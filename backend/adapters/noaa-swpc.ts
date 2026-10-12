import type { Vector3 } from "../physics/coordinates.js";
import type { DataSource, SourceStatus } from "../types.js";
import { buildL1Series, checkDensity, type DensityCheck, type L1Sample } from "./rtsw-series.js";

const SOURCE: DataSource = "noaa-swpc";

// SWPC Real-Time Solar Wind (RTSW) 1-minute feeds. The older
// /products/solar-wind/{plasma,mag}-1-day.json products have been retired (HTTP 404).
const RTSW_WIND_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json";
const RTSW_MAG_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json";
// Estimated planetary Kp, updated each minute; the 3-hourly product lags by up to 3 h.
const KP_1M_URL = "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json";
const KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
const OVATION_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";

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
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

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
    const kp = Array.isArray(row) ? finite(row[1]) : row && typeof row === "object" ? finite((row as Rec).Kp) : null;
    const time = Array.isArray(row) ? row[0] : row && typeof row === "object" ? (row as Rec).time_tag : null;
    if (kp !== null) return { value: Math.min(9, Math.max(0, kp)), observedAt: swpcTimeToIso(time), kind: "planetary-3h" };
  }
  return null;
}

/** Newest 1-minute estimated planetary Kp. */
export function latestKp1m(data: unknown): KpReading | null {
  if (!Array.isArray(data)) return null;
  let best: { kp: number; time: string } | null = null;
  for (const row of data) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as Rec;
    const kp = finite(rec.estimated_kp) ?? finite(rec.kp_index);
    const time = swpcTimeToIso(rec.time_tag);
    if (kp === null || !time) continue;
    if (!best || Date.parse(time) > Date.parse(best.time)) best = { kp, time };
  }
  return best ? { value: Math.min(9, Math.max(0, best.kp)), observedAt: best.time, kind: "estimated-1m" } : null;
}

export async function fetchNoaaReadout(): Promise<NOAAReadout | null> {
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
    const kp = latestKp1m(kp1mData) ?? latestKp(kpData);
    if (!latest) throw new Error("NOAA RTSW: no complete, plausible wind+mag record");
    if (!kp) throw new Error("NOAA Kp: no valid value");

    const timestamp = new Date(latest.t).toISOString();
    const series = all.filter((x) => x.t > latest.t - SERIES_KEEP_MS);
    const densityCheck = checkDensity(windData, latest.spacecraft, latest.t);
    latestStatus = {
      source: SOURCE,
      lastSeen: timestamp,
      latencySeconds: Math.max(0, (Date.now() - latest.t) / 1000),
      healthy: true,
      message: densityCheck
        ? `NOAA SWPC RTSW OK (${latest.spacecraft}); density disagrees with ${densityCheck.reference} ` +
          `(${densityCheck.density.toFixed(2)} vs ${densityCheck.referenceDensity.toFixed(2)} cm^-3)`
        : `NOAA SWPC RTSW OK (${latest.spacecraft})`,
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
      // No measured Dst here: SWPC does not publish it in these products, so the nowcast
      // derives its own model estimate rather than receiving a Kp-synthesised value.
      ovation,
    };
  } catch (error) {
    latestStatus = {
      source: SOURCE,
      lastSeen: latestStatus.lastSeen,
      latencySeconds: latestStatus.lastSeen
        ? Math.max(0, (Date.now() - Date.parse(latestStatus.lastSeen)) / 1000)
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
