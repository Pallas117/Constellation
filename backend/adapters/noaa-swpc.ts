import type { Vector3 } from "../physics/coordinates.js";
import type { DataSource, SourceStatus } from "../types.js";
import { buildL1Series, checkDensity, type DensityCheck, type L1Sample } from "./rtsw-series.js";

const SOURCE: DataSource = "noaa-swpc";

// SWPC Real-Time Solar Wind (RTSW) 1-minute feeds. The older
// /products/solar-wind/{plasma,mag}-1-day.json products have been retired (HTTP 404).
const RTSW_WIND_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json";
const RTSW_MAG_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json";
// Running estimate of planetary Kp for the current 3-hour interval, updated each minute.
const KP_1M_URL = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
const OVATION_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";

/** A newest L1 sample older than this is not current: the source is unhealthy (same bound as the ingest tick). */
export const RTSW_MAX_AGE_MS = 15 * 60_000;

/** The L1 history kept for propagation: the slowest plausible wind (200 km/s) takes 2.1 h. */
const SERIES_KEEP_MS = 3 * 3_600_000;

export interface KpReading {
  value: number;
  /** Start of the Kp interval (3-hourly) or the estimate's minute. */
  observedAt: string | null;
  kind: "estimated-1m" | "planetary-3h";
}

export interface NOAAReadout {
  /** Measurement time: the older of the paired wind and mag samples, so freshness is never overstated. */
  timestamp: string;
  /** L1 spacecraft the sample came from (e.g. DSCOVR, ACE, IMAP, SOLAR1). */
  spacecraft: string;
  density: number;
  velocityGse: Vector3;
  /** As published by SWPC; null when only GSE is available. */
  velocityGsm?: Vector3 | null;
  magneticFieldGse: Vector3;
  magneticFieldGsm?: Vector3 | null;
  kp: number;
  kpReading?: KpReading;
  /** The last 3 h of validated 1-minute L1 samples, oldest first. */
  series?: L1Sample[];
  /** Set when another L1 spacecraft disagrees on density by more than 2x. */
  densityCheck?: DensityCheck | null;
  /** True when no velocity vector was published and the flow was assumed anti-sunward from the speed. */
  velocityAssumed?: boolean;
  ovation: unknown | null;
}

let latestStatus: SourceStatus = {
  source: SOURCE,
  lastSeen: null,
  latencySeconds: null,
  healthy: false,
  message: "Not fetched yet",
};

type Rec = Record<string, unknown>;

const finite = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    // Name the product, never the URL: status messages are shown in the UI and logged.
    throw new Error(`NOAA SWPC ${new URL(url).pathname.split("/").pop()} returned HTTP ${response.status}`);
  }
  return response.json();
}

/** Kp is 0–9. Anything else is a fill or a fault, and is skipped rather than clamped to a quiet value. */
const kpInRange = (kp: number | null): number | null => (kp !== null && kp >= 0 && kp <= 9 ? kp : null);

/** SWPC time_tags are UTC but carry no zone ("2026-10-10 12:00:00.000"); make that explicit. */
export function swpcTimeToIso(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)) {
    text = `${text.replace(" ", "T")}Z`;
  }
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Latest 3-hourly planetary Kp; accepts the current object rows and the legacy array-of-arrays layout. */
export function latestKp(data: unknown): KpReading | null {
  if (!Array.isArray(data)) return null;
  for (let i = data.length - 1; i >= 0; i -= 1) {
    const row = data[i];
    const kp = kpInRange(Array.isArray(row) ? finite(row[1]) : row && typeof row === "object" ? finite((row as Rec).Kp) : null);
    const time = Array.isArray(row) ? row[0] : row && typeof row === "object" ? (row as Rec).time_tag : null;
    if (kp !== null) return { value: kp, observedAt: swpcTimeToIso(time), kind: "planetary-3h" };
  }
  return null;
}

/** Newest running estimate of Kp for the current 3-hour interval. */
export function latestKp1m(data: unknown): KpReading | null {
  if (!Array.isArray(data)) return null;
  let best: { kp: number; time: string } | null = null;
  for (const row of data) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as Rec;
    const kp = kpInRange(finite(rec.estimated_kp) ?? finite(rec.kp_index));
    const time = swpcTimeToIso(rec.time_tag);
    if (kp === null || !time) continue;
    if (!best || Date.parse(time) > Date.parse(best.time)) best = { kp, time };
  }
  return best ? { value: best.kp, observedAt: best.time, kind: "estimated-1m" } : null;
}

/** A completed 3-hour Kp older than this (interval start) no longer describes now. */
const KP_3H_MAX_AGE_MS = 6 * 3_600_000;

/**
 * Kp for now: the higher of the running estimate for the current 3-hour interval and
 * the last completed interval. The running estimate covers only the minutes so far, so
 * it restarts near 0 each interval (0.33 at 09:39 UT on 2026-10-12, after a 06-09 UT
 * interval of 3.33): alone it under-reads for much of every interval. The completed value
 * alone lags a rise by up to 3 h. Taking the higher never under-reports activity.
 */
export function currentKp(estimate: KpReading | null, completed: KpReading | null, nowMs: number): KpReading | null {
  const start = completed?.observedAt ? Date.parse(completed.observedAt) : NaN;
  const recent = completed && Number.isFinite(start) && nowMs - start <= KP_3H_MAX_AGE_MS ? completed : null;
  if (!estimate) return recent ?? completed;
  if (!recent) return estimate;
  return estimate.value > recent.value ? estimate : recent;
}

export async function fetchNoaaReadout(nowMs = Date.now()): Promise<NOAAReadout | null> {
  try {
    const [windData, magData, kp1mData, kpData, ovation] = await Promise.all([
      fetchJson(RTSW_WIND_URL),
      fetchJson(RTSW_MAG_URL),
      fetchJson(KP_1M_URL).catch(() => null),
      fetchJson(KP_URL).catch(() => null),
      fetchJson(OVATION_URL).catch(() => null),
    ]);

    const all = buildL1Series(windData, magData);
    const latest = all.at(-1);
    // Judge how recent the completed Kp is against now, not against the newest L1 sample.
    const kp = currentKp(latestKp1m(kp1mData), latestKp(kpData), nowMs);
    if (!latest) throw new Error("NOAA RTSW: no complete, plausible wind+mag record");
    if (!kp) throw new Error("NOAA Kp: no valid value");

    const timestamp = new Date(latest.t).toISOString();
    const series = all.filter((x) => x.t > latest.t - SERIES_KEEP_MS);
    const densityCheck = checkDensity(windData, latest.spacecraft, latest.t);
    const ageMs = nowMs - latest.t;
    const current = ageMs <= RTSW_MAX_AGE_MS;
    const disagreement = densityCheck
      ? `; density disagrees with ${densityCheck.reference} ` +
        `(${densityCheck.density.toFixed(2)} vs ${densityCheck.referenceDensity.toFixed(2)} cm^-3)`
      : "";
    latestStatus = {
      source: SOURCE,
      lastSeen: timestamp,
      latencySeconds: Math.max(0, ageMs / 1000),
      healthy: current,
      message: current
        ? `NOAA SWPC RTSW OK (${latest.spacecraft})${disagreement}`
        : `NOAA SWPC RTSW: newest complete L1 sample (${latest.spacecraft}) is ${Math.round(ageMs / 60_000)} min old${disagreement}`,
    };

    return {
      timestamp,
      spacecraft: latest.spacecraft,
      density: latest.density,
      velocityGse: latest.velocityGse,
      velocityGsm: latest.velocityGsm,
      // RTSW publishes native GSE and GSM components; no local conversion is needed.
      magneticFieldGse: latest.magneticFieldGse,
      magneticFieldGsm: latest.magneticFieldGsm,
      kp: kp.value,
      kpReading: kp,
      series,
      densityCheck,
      velocityAssumed: latest.velocityAssumed === true,
      // No measured Dst here: SWPC does not publish it in these products, so the nowcast
      // derives its own model estimate rather than receiving a Kp-synthesised value.
      ovation,
    };
  } catch (error) {
    latestStatus = {
      source: SOURCE,
      lastSeen: latestStatus.lastSeen,
      latencySeconds: latestStatus.lastSeen
        ? Math.max(0, (nowMs - Date.parse(latestStatus.lastSeen)) / 1000)
        : null,
      healthy: false,
      message: error instanceof Error ? error.message : "NOAA fetch failed",
    };
    return null;
  }
}

export function getNoaaStatus(): SourceStatus {
  return latestStatus;
}
