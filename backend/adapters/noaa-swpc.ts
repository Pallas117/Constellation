import { gsmToGse, vec } from "../physics/coordinates.js";
import type { DataSource, SourceStatus } from "../types.js";

const SOURCE: DataSource = "noaa-swpc";

export interface NOAAReadout {
  timestamp: string;
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

function parseNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

function latestRow(arrayData: unknown): unknown[] | null {
  if (!Array.isArray(arrayData) || arrayData.length < 2) {
    return null;
  }
  for (let i = arrayData.length - 1; i >= 1; i -= 1) {
    const row = arrayData[i];
    if (Array.isArray(row)) {
      return row;
    }
  }
  return null;
}

export async function fetchNoaaReadout(): Promise<NOAAReadout | null> {
  try {
    const [plasmaData, magData, kpData, ovation] = await Promise.all([
      fetchJson("https://services.swpc.noaa.gov/products/solar-wind/plasma-1-day.json"),
      fetchJson("https://services.swpc.noaa.gov/products/solar-wind/mag-1-day.json"),
      fetchJson("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json"),
      fetchJson("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json").catch(() => null),
    ]);

    const p = latestRow(plasmaData);
    const m = latestRow(magData);
    const k = latestRow(kpData);
    if (!p || !m || !k) {
      throw new Error("Missing NOAA rows");
    }

    const timestamp = String(p[0] || m[0] || new Date().toISOString());
    const density = parseNumber(p[1], 5);
    // plasma-1-day columns: time_tag, density, speed, temperature. SWPC publishes bulk
    // speed only, so the flow is taken as anti-sunward along X (shared by GSE and GSM).
    const speed = parseNumber(p[2], 400);

    // mag-1-day columns: time_tag, bx_gsm, by_gsm, bz_gsm, ... — rotate GSM into the
    // GSE frame the nowcast expects.
    const bGsm = vec(parseNumber(m[1], 0), parseNumber(m[2], 0), parseNumber(m[3], 0));
    const bGse = gsmToGse(bGsm, String(m[0] || timestamp));
    const kp = Math.min(9, Math.max(0, parseNumber(k[1], 2)));

    latestStatus = {
      source: SOURCE,
      lastSeen: timestamp,
      latencySeconds: Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000),
      healthy: true,
      message: "NOAA SWPC OK",
    };

    return {
      timestamp,
      density,
      velocityGse: vec(-speed, 0, 0),
      magneticFieldGse: bGse,
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
