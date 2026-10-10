import { vec } from "../physics/coordinates.js";
import type { DataSource, SourceStatus } from "../types.js";

const SOURCE: DataSource = "noaa-swpc";

// SWPC Real-Time Solar Wind (RTSW) 1-minute feeds. The older
// /products/solar-wind/{plasma,mag}-1-day.json products have been retired (HTTP 404).
const RTSW_WIND_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json";
const RTSW_MAG_URL = "https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json";
const KP_URL = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
const OVATION_URL = "https://services.swpc.noaa.gov/json/ovation_aurora_latest.json";

export interface NOAAReadout {
  /** Measurement time: the older of the wind and mag samples, so freshness is never overstated. */
  timestamp: string;
  /** L1 spacecraft the sample came from (e.g. DSCOVR, ACE, IMAP, SOLAR1). */
  spacecraft: string;
  density: number;
  velocityGse: { x: number; y: number; z: number };
  magneticFieldGse: { x: number; y: number; z: number };
  kp: number;
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

/**
 * RTSW lists every L1 spacecraft per minute (newest first) and marks the operational one
 * `active`. Take the newest active record with all required fields finite; if no
 * spacecraft is active, fall back to the newest complete record from any of them.
 */
export function pickRtsw(data: unknown, fields: string[]): { rec: Rec; time: string } | null {
  if (!Array.isArray(data)) return null;
  let bestActive: { rec: Rec; time: string; ms: number } | null = null;
  let bestAny: { rec: Rec; time: string; ms: number } | null = null;
  for (const item of data) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Rec;
    const time = swpcTimeToIso(rec.time_tag);
    if (!time || !fields.every((f) => finite(rec[f]) !== null)) continue;
    const ms = Date.parse(time);
    if (!bestAny || ms > bestAny.ms) bestAny = { rec, time, ms };
    if (rec.active === true && (!bestActive || ms > bestActive.ms)) bestActive = { rec, time, ms };
  }
  const best = bestActive ?? bestAny;
  return best ? { rec: best.rec, time: best.time } : null;
}

/** Latest planetary Kp; accepts the current object rows and the legacy array-of-arrays layout. */
export function latestKp(data: unknown): number | null {
  if (!Array.isArray(data)) return null;
  for (let i = data.length - 1; i >= 0; i -= 1) {
    const row = data[i];
    const kp = Array.isArray(row) ? finite(row[1]) : row && typeof row === "object" ? finite((row as Rec).Kp) : null;
    if (kp !== null) return Math.min(9, Math.max(0, kp));
  }
  return null;
}

export async function fetchNoaaReadout(): Promise<NOAAReadout | null> {
  try {
    const [windData, magData, kpData, ovation] = await Promise.all([
      fetchJson(RTSW_WIND_URL),
      fetchJson(RTSW_MAG_URL),
      fetchJson(KP_URL),
      fetchJson(OVATION_URL).catch(() => null),
    ]);

    const wind = pickRtsw(windData, ["proton_speed", "proton_density"]);
    const mag = pickRtsw(magData, ["bx_gse", "by_gse", "bz_gse"]);
    const kp = latestKp(kpData);
    if (!wind) throw new Error("NOAA RTSW wind: no complete record");
    if (!mag) throw new Error("NOAA RTSW mag: no complete record");
    if (kp === null) throw new Error("NOAA Kp: no valid value");

    const timestamp = Date.parse(wind.time) <= Date.parse(mag.time) ? wind.time : mag.time;
    const speed = finite(wind.rec.proton_speed)!;

    // Use the measured GSE velocity when published; otherwise the bulk flow is taken as
    // anti-sunward along X.
    const vx = finite(wind.rec.proton_vx_gse);
    const vy = finite(wind.rec.proton_vy_gse);
    const vz = finite(wind.rec.proton_vz_gse);
    const velocityGse = vx !== null && vy !== null && vz !== null ? vec(vx, vy, vz) : vec(-speed, 0, 0);

    const spacecraft = String(wind.rec.source ?? mag.rec.source ?? "unknown");
    latestStatus = {
      source: SOURCE,
      lastSeen: timestamp,
      latencySeconds: Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000),
      healthy: true,
      message: `NOAA SWPC RTSW OK (${spacecraft})`,
    };

    return {
      timestamp,
      spacecraft,
      density: finite(wind.rec.proton_density)!,
      velocityGse,
      // RTSW publishes native GSE components; no frame conversion needed.
      magneticFieldGse: vec(finite(mag.rec.bx_gse)!, finite(mag.rec.by_gse)!, finite(mag.rec.bz_gse)!),
      kp,
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
