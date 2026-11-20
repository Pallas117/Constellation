/**
 * NOAA SWPC GloTEC: global total electron content (TEC), a data-assimilative model driven by
 * ground GNSS (and F-region profile) observations. Open, no login, US government product at
 * services.swpc.noaa.gov; SWPC states no separate licence on the product page (UNVERIFIED beyond
 * the NOAA/NWS disclaimer), so credit NOAA SWPC and keep the "not a measurement everywhere" caveat.
 *
 *   index   /products/glotec/geojson_2d_urt.json   [{url, time_tag}, ...] oldest first, ~4.5k entries (510 KB)
 *   file    /products/glotec/geojson_2d_urt/glotec_icao_YYYYMMDDTHHMMSSZ.geojson   (2.4 MB, 5184 cells)
 *   grid    5 deg lon (-177.5..177.5) x 2.5 deg lat (-88.75..88.75), Point features
 *   props   tec (TECU, 0..300 per file metadata), anomaly (TECU vs climatology), hmF2 (km), NmF2 (m^-3),
 *           quality_flag 0..5 = mean number of F-region observations in the profile, rounded up, capped at 5
 *   cadence 10 min time steps; a step is listed ~25 min after its valid time (observed 18 Nov 2026)
 * Where no observation constrains a cell (flag 0) TEC relaxes toward IRI-2016 climatology.
 *
 * Only a Malaysian-region summary is kept; the grid is parsed, summarised and dropped. This is TEC,
 * not scintillation: S4/ROTI are not derived here (see docs/adr/ionosphere-sources.md).
 */
import { freshnessMs } from "../../shared/policy/freshness.js";
import type { IonosphereTecReading, SourceStatus } from "../types.js";
import { fetchSwpcResponse, SWPC_ORIGIN } from "./swpc-fetch.js";

const SOURCE = "glotec-swpc" as const;
const INDEX_URL = `${SWPC_ORIGIN}/products/glotec/geojson_2d_urt.json`;
const FILE_PATH = /^\/products\/glotec\/geojson_2d_urt\/glotec_icao_\d{8}T\d{6}Z\.geojson$/;

/** Cell centres inside this box are summarised: 2-7 N, 100-119 E (Peninsular Malaysia and Borneo, with sea between). */
export const MALAYSIA_BOX = { latMin: 2, latMax: 7, lonMin: 100, lonMax: 119 } as const;
const KL = { lat: 3.14, lon: 101.69 } as const;
/** TEC bounds from the file's own metadata (0..300 TECU). */
export const TEC_MIN = 0;
export const TEC_MAX = 300;
/** A reading older than this is unknown (freshness.json, glotec_tec). */
export const GLOTEC_MAX_AGE_MS = freshnessMs("glotec_tec");
/** One time budget for the whole fetch (index tail, newest file, optional baseline file). */
export const GLOTEC_BUDGET_MS = 11_000;
/** Largest product body accepted. The real file is about 2.5 MB. */
const MAX_BYTES = 8 * 1024 * 1024;
const STEP_MS = 10 * 60_000;
/** The rate compares the newest regional mean with one this far back (or the nearest within the window). */
const RATE_TARGET_MS = 30 * 60_000;
const RATE_MIN_MS = 20 * 60_000;
const RATE_MAX_MS = 90 * 60_000;
const HISTORY_MAX = 12;

export interface GlotecIndexEntry {
  url: string;
  timeTag: string;
}

/** The regional summary of one GloTEC file, before a rate is attached. */
export type GlotecSummary = Omit<IonosphereTecReading, "rateTecuPerHour" | "rateBaselineAt">;

let latestStatus: SourceStatus = { source: SOURCE, lastSeen: null, latencySeconds: null, healthy: false, message: "Not fetched yet" };
let latest: IonosphereTecReading | null = null;
/** Recent regional means, newest last: the rate baseline, so a rate costs no extra download once running. */
let history: GlotecSummary[] = [];

export function resetGlotecForTests(): void {
  latest = null;
  history = [];
  latestStatus = { source: SOURCE, lastSeen: null, latencySeconds: null, healthy: false, message: "Not fetched yet" };
}

/** Index entries from an index body (full JSON array, or the tail of one cut mid-entry). Invalid entries are dropped; oldest first. */
export function parseIndex(text: string): GlotecIndexEntry[] {
  const out: GlotecIndexEntry[] = [];
  const add = (url: unknown, timeTag: unknown) => {
    if (typeof url !== "string" || typeof timeTag !== "string") return;
    if (!FILE_PATH.test(url) || !Number.isFinite(Date.parse(timeTag))) return;
    out.push({ url, timeTag });
  };
  try {
    const data: unknown = JSON.parse(text);
    if (Array.isArray(data)) {
      for (const e of data) if (e && typeof e === "object") add((e as Record<string, unknown>).url, (e as Record<string, unknown>).time_tag);
      return out.sort((a, b) => Date.parse(a.timeTag) - Date.parse(b.timeTag));
    }
    return [];
  } catch {
    // A byte-range tail: take whole entries only.
    for (const m of text.matchAll(/"url":\s*"([^"]+)",\s*"time_tag":\s*"([^"]+)"/g)) add(m[1], m[2]);
    return out.sort((a, b) => Date.parse(a.timeTag) - Date.parse(b.timeTag));
  }
}

/**
 * Summarise one GloTEC GeoJSON file over the Malaysian box. Cells with a non-finite or out-of-range
 * tec, or coordinates outside the globe, are skipped (never read as 0). Null when the document is not
 * a GloTEC FeatureCollection, its time tag is missing, in the future or does not match `expectedTimeTag`,
 * or no valid cell lies in the box.
 */
export function summarizeGlotec(doc: unknown, nowMs: number, expectedTimeTag?: string): GlotecSummary | null {
  if (!doc || typeof doc !== "object") return null;
  const d = doc as Record<string, unknown>;
  if (d.type !== "FeatureCollection" || !Array.isArray(d.features)) return null;
  const tag = typeof d.time_tag === "string" ? Date.parse(d.time_tag) : Number.NaN;
  if (!Number.isFinite(tag) || tag > nowMs + STEP_MS) return null;
  if (expectedTimeTag !== undefined && Date.parse(expectedTimeTag) !== tag) return null;

  let n = 0;
  let constrained = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let nearest: { lat: number; lon: number; tecu: number; qualityFlag: number; dist: number } | null = null;
  for (const f of d.features) {
    if (!f || typeof f !== "object") continue;
    const geom = (f as Record<string, unknown>).geometry as Record<string, unknown> | undefined;
    const props = (f as Record<string, unknown>).properties as Record<string, unknown> | undefined;
    const c = geom?.type === "Point" && Array.isArray(geom.coordinates) ? geom.coordinates : null;
    if (!c || !props) continue;
    const lon = c[0];
    const lat = c[1];
    const tec = props.tec;
    if (typeof lon !== "number" || typeof lat !== "number" || typeof tec !== "number") continue;
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(tec)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
    if (lat < MALAYSIA_BOX.latMin || lat > MALAYSIA_BOX.latMax || lon < MALAYSIA_BOX.lonMin || lon > MALAYSIA_BOX.lonMax) continue;
    if (tec < TEC_MIN || tec > TEC_MAX) continue;
    const q = props.quality_flag;
    const flag = typeof q === "number" && Number.isInteger(q) && q >= 0 && q <= 5 ? q : 0;
    n += 1;
    if (flag >= 1) constrained += 1;
    sum += tec;
    min = Math.min(min, tec);
    max = Math.max(max, tec);
    const dist = Math.hypot(lat - KL.lat, lon - KL.lon);
    if (!nearest || dist < nearest.dist) nearest = { lat, lon, tecu: tec, qualityFlag: flag, dist };
  }
  if (n === 0 || !nearest) return null;
  return {
    source: SOURCE,
    observedAt: new Date(tag).toISOString(),
    region: { ...MALAYSIA_BOX },
    cells: n,
    constrainedCells: constrained,
    meanTecu: sum / n,
    minTecu: min,
    maxTecu: max,
    nearestKl: { lat: nearest.lat, lon: nearest.lon, tecu: nearest.tecu, qualityFlag: nearest.qualityFlag },
  };
}

/** The history entry closest to RATE_TARGET_MS before `current`, within 20-90 min, with the same cell count; else null. */
export function pickBaseline(current: GlotecSummary, past: readonly GlotecSummary[]): GlotecSummary | null {
  const t = Date.parse(current.observedAt);
  let best: GlotecSummary | null = null;
  let bestGap = Infinity;
  for (const p of past) {
    const age = t - Date.parse(p.observedAt);
    if (age < RATE_MIN_MS || age > RATE_MAX_MS || p.cells !== current.cells) continue;
    const gap = Math.abs(age - RATE_TARGET_MS);
    if (gap < bestGap) {
      best = p;
      bestGap = gap;
    }
  }
  return best;
}

/** dTEC/dt of the regional mean in TECU per hour; null without a valid baseline. */
export function withRate(current: GlotecSummary, baseline: GlotecSummary | null): IonosphereTecReading {
  if (!baseline) return { ...current, rateTecuPerHour: null, rateBaselineAt: null };
  const hours = (Date.parse(current.observedAt) - Date.parse(baseline.observedAt)) / 3_600_000;
  return { ...current, rateTecuPerHour: hours > 0 ? (current.meanTecu - baseline.meanTecu) / hours : null, rateBaselineAt: baseline.observedAt };
}

/** The reading if its model time is within GLOTEC_MAX_AGE_MS of `nowMs` (and not in the future), otherwise null (unknown). */
export function freshIonosphere(reading: IonosphereTecReading | null, nowMs: number): IonosphereTecReading | null {
  if (!reading) return null;
  const age = nowMs - Date.parse(reading.observedAt);
  return Number.isFinite(age) && age >= -STEP_MS && age <= GLOTEC_MAX_AGE_MS ? reading : null;
}

async function readBody(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BYTES) throw new Error("GloTEC response larger than 8 MB refused");
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error("GloTEC response larger than 8 MB refused");
  return text;
}

async function fetchSummary(entry: GlotecIndexEntry, nowMs: number, signal: AbortSignal): Promise<GlotecSummary> {
  const body = await readBody(await fetchSwpcResponse(`${SWPC_ORIGIN}${entry.url}`, { signal }));
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new Error("GloTEC file is not valid JSON");
  }
  const summary = summarizeGlotec(doc, nowMs, entry.timeTag);
  if (!summary) throw new Error("GloTEC file failed validation (shape, time tag, or no valid Malaysian cell)");
  return summary;
}

/** The index tail (a few KB, byte range); the whole index when the server ignores the range. */
async function fetchIndexTail(signal: AbortSignal): Promise<GlotecIndexEntry[]> {
  const response = await fetchSwpcResponse(INDEX_URL, { signal, headers: { Range: "bytes=-3072" } });
  return parseIndex(await readBody(response));
}

/**
 * Newest GloTEC step as a Malaysian regional reading with its rate of change. Downloads a 2.4 MB file
 * only when a new step has been published. Null on failure (status says why); the caller keeps its
 * previous reading, which expires through freshIonosphere.
 */
export async function fetchGlotec(nowMs = Date.now()): Promise<IonosphereTecReading | null> {
  try {
    const signal = AbortSignal.timeout(GLOTEC_BUDGET_MS);
    const entries = await fetchIndexTail(signal);
    const newest = entries[entries.length - 1];
    if (!newest) throw new Error("GloTEC index had no valid entries");

    if (!latest || Date.parse(latest.observedAt) !== Date.parse(newest.timeTag)) {
      const summary = await fetchSummary(newest, nowMs, signal);
      let baseline = pickBaseline(summary, history);
      if (!baseline) {
        // Cold start: one older step from the index tail gives the first rate.
        const target = Date.parse(summary.observedAt) - RATE_TARGET_MS;
        const older = entries
          .filter((e) => {
            const age = Date.parse(summary.observedAt) - Date.parse(e.timeTag);
            return age >= RATE_MIN_MS && age <= RATE_MAX_MS;
          })
          .sort((a, b) => Math.abs(Date.parse(a.timeTag) - target) - Math.abs(Date.parse(b.timeTag) - target))[0];
        if (older) baseline = await fetchSummary(older, nowMs, signal).catch(() => null);
        if (baseline) history = [...history, baseline].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
      }
      history = [...history.filter((h) => h.observedAt !== summary.observedAt), summary].slice(-HISTORY_MAX);
      latest = withRate(summary, baseline);
    }

    const age = nowMs - Date.parse(latest.observedAt);
    const fresh = freshIonosphere(latest, nowMs) !== null;
    latestStatus = {
      source: SOURCE,
      lastSeen: latest.observedAt,
      latencySeconds: Math.max(0, Math.round(age / 1000)),
      healthy: fresh,
      message: fresh
        ? `GloTEC TEC over Malaysia current (${latest.constrainedCells}/${latest.cells} cells observation-constrained)`
        : "GloTEC newest step is older than 60 min",
    };
    return latest;
  } catch (error) {
    latestStatus = {
      source: SOURCE,
      lastSeen: latestStatus.lastSeen,
      latencySeconds: latestStatus.lastSeen ? Math.max(0, Math.round((nowMs - Date.parse(latestStatus.lastSeen)) / 1000)) : null,
      healthy: false,
      message: error instanceof Error && error.name === "TimeoutError" ? "GloTEC fetch timed out" : error instanceof Error ? error.message : "GloTEC fetch failed",
    };
    return null;
  }
}

export function getGlotecStatus(): SourceStatus {
  return latestStatus;
}
