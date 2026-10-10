import { vec } from "../physics/coordinates.js";
import type { DataSource, SourceStatus } from "../types.js";
import type { MMSSpacecraftSample } from "../physics/reconnection.js";

const SOURCE: DataSource = "mms-cdaweb";
const HAPI_BASE = "https://cdaweb.gsfc.nasa.gov/hapi";
const RE_KM = 6371.2;
const SPACECRAFT = ["mms1", "mms2", "mms3", "mms4"] as const;
type ScId = (typeof SPACECRAFT)[number];

// MMS FGM survey L2 is an archival product (weeks behind real time). Samples are taken
// from the end of the published coverage, and the status reports how far behind that is.
const WINDOW_MS = 60 * 1000;
const STOP_DATE_TTL_MS = 60 * 60 * 1000;

let latestStatus: SourceStatus = {
  source: SOURCE,
  lastSeen: null,
  latencySeconds: null,
  healthy: false,
  message: "Not fetched yet",
};

const stopDateCache = new Map<ScId, { stop: number; fetchedAt: number }>();

function toIso(ts: Date): string {
  return ts.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function hapiJson(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`${HAPI_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(9000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`CDAWeb HAPI ${params.id ?? path} returned HTTP ${response.status}`);
  }
  return response.json();
}

// Field from FGM survey L2 (HAPI sub-dataset @0). Position from MEC: FGM's own
// ephemeris (@1) is published to 3 significant figures (~100 km), far coarser than the
// ~10-100 km tetrahedron separation, so it cannot support curlometer geometry.
const fieldId = (id: ScId) => `${id.toUpperCase()}_FGM_SRVY_L2@0`;
const ephemId = (id: ScId) => `${id.toUpperCase()}_MEC_SRVY_L2_EPHT89D`;
const MEC_CADENCE_MS = 30 * 1000;

async function stopDate(id: ScId): Promise<number> {
  const cached = stopDateCache.get(id);
  if (cached && Date.now() - cached.fetchedAt < STOP_DATE_TTL_MS) return cached.stop;
  const info = await hapiJson("info", { id: fieldId(id) });
  const stop = typeof info?.stopDate === "string" ? Date.parse(info.stopDate) : Number.NaN;
  if (!Number.isFinite(stop)) throw new Error(`CDAWeb HAPI ${fieldId(id)} has no stopDate`);
  stopDateCache.set(id, { stop, fetchedAt: Date.now() });
  return stop;
}

// CDF/HAPI fill values are large negative sentinels (e.g. -1e31).
const FILL_THRESHOLD = 1e30;

function finiteTriple(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out = value.slice(0, 3).map((v) => (v === null || v === "" ? Number.NaN : Number(v)));
  return out.every((v) => Number.isFinite(v) && Math.abs(v) < FILL_THRESHOLD)
    ? (out as [number, number, number])
    : null;
}

/** Latest row whose vector (first three components; FGM appends |B| or |r|) is valid. */
export function lastValidVectorRow(rows: unknown): { time: string; v: [number, number, number] } | null {
  if (!Array.isArray(rows)) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (!Array.isArray(row) || typeof row[0] !== "string" || !Number.isFinite(Date.parse(row[0]))) continue;
    const v = finiteTriple(row[1]);
    if (v) return { time: row[0], v };
  }
  return null;
}

/** MEC position (30 s cadence) linearly interpolated to `atIso`; null unless bracketed. */
export function interpolatePosition(rows: unknown, atIso: string): [number, number, number] | null {
  if (!Array.isArray(rows)) return null;
  const at = Date.parse(atIso);
  let before: { t: number; v: [number, number, number] } | null = null;
  let after: { t: number; v: [number, number, number] } | null = null;
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== "string") continue;
    const t = Date.parse(row[0]);
    const v = finiteTriple(row[1]);
    if (!Number.isFinite(t) || !v) continue;
    if (t <= at && (!before || t > before.t)) before = { t, v };
    if (t >= at && (!after || t < after.t)) after = { t, v };
  }
  if (!before || !after) return null;
  if (after.t === before.t) return before.v;
  const f = (at - before.t) / (after.t - before.t);
  return [0, 1, 2].map((i) => before!.v[i] + (after!.v[i] - before!.v[i]) * f) as [number, number, number];
}

async function fetchSpacecraft(id: ScId, start: string, stop: string): Promise<MMSSpacecraftSample | null> {
  // Pad the MEC window by one cadence each side so the B sample is bracketed.
  const mecStart = toIso(new Date(Date.parse(start) - MEC_CADENCE_MS));
  const mecStop = toIso(new Date(Date.parse(stop) + MEC_CADENCE_MS));
  const [field, ephem] = await Promise.all([
    hapiJson("data", { id: fieldId(id), parameters: `${id}_fgm_b_gsm_srvy_l2_clean`, "time.min": start, "time.max": stop, format: "json" }),
    hapiJson("data", { id: ephemId(id), parameters: `${id}_mec_r_gsm`, "time.min": mecStart, "time.max": mecStop, format: "json" }),
  ]);

  const b = lastValidVectorRow(field?.data);
  const r = b ? interpolatePosition(ephem?.data, b.time) : null;
  if (!b || !r) {
    // Missing or fill-valued components are not data; never substitute zeros.
    return null;
  }

  // FGM and MEC both publish natively in GSM, so no frame conversion is applied.
  return {
    id,
    timestamp: b.time,
    positionGsmRe: vec(r[0] / RE_KM, r[1] / RE_KM, r[2] / RE_KM),
    magneticFieldNt: vec(b.v[0], b.v[1], b.v[2]),
  };
}

export async function fetchMmsCdawebSamples(): Promise<MMSSpacecraftSample[]> {
  try {
    // A common window ending at the earliest coverage end keeps the four samples
    // time-aligned for the tetrahedron skew check.
    const stops = await Promise.all(SPACECRAFT.map((id) => stopDate(id)));
    const stopMs = Math.min(Date.now(), ...stops);
    const start = toIso(new Date(stopMs - WINDOW_MS));
    const stop = toIso(new Date(stopMs));

    // One spacecraft failing must not discard the other three.
    const results = await Promise.allSettled(SPACECRAFT.map((id) => fetchSpacecraft(id, start, stop)));

    const samples: MMSSpacecraftSample[] = [];
    const failures: string[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value) samples.push(result.value);
      } else {
        failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
      }
    }

    // lastSeen only advances when data actually arrived; it is the newest sample time.
    const newest = samples.reduce<string | null>(
      (latest, sample) => (latest === null || Date.parse(sample.timestamp) > Date.parse(latest) ? sample.timestamp : latest),
      null,
    );
    const lastSeen = newest ?? latestStatus.lastSeen;
    const latencySeconds = lastSeen ? Math.max(0, (Date.now() - Date.parse(lastSeen)) / 1000) : null;
    const failureNote = failures.length > 0 ? `; ${failures.length} failed: ${failures[0]}` : "";
    const behind = latencySeconds !== null ? `, archival L2 ${(latencySeconds / 86400).toFixed(1)} d behind` : "";
    latestStatus = {
      source: SOURCE,
      lastSeen,
      latencySeconds,
      healthy: samples.length >= 3,
      message: `Fetched ${samples.length}/4 MMS spacecraft${behind}${failureNote}`,
    };

    return samples;
  } catch (error) {
    latestStatus = {
      source: SOURCE,
      lastSeen: latestStatus.lastSeen,
      latencySeconds: latestStatus.lastSeen
        ? Math.max(0, (Date.now() - Date.parse(latestStatus.lastSeen)) / 1000)
        : null,
      healthy: false,
      message: error instanceof Error ? error.message : "MMS CDAWeb fetch failed",
    };
    return [];
  }
}

export function getMmsCdawebStatus(): SourceStatus {
  return latestStatus;
}
