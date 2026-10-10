import { vec } from "../physics/coordinates.js";
import type { DataSource, SourceStatus } from "../types.js";

const SOURCE: DataSource = "esa-hapi";

export interface ESAReadout {
  timestamp: string;
  /**
   * Swarm in-situ geomagnetic field at LEO, in the local North-East-Centre frame (nT).
   * This is the main field (~10^4 nT), not the interplanetary field, so it must never be
   * blended into the solar-wind IMF.
   */
  magneticFieldNec: { x: number; y: number; z: number };
}

let latestStatus: SourceStatus = {
  source: SOURCE,
  lastSeen: null,
  latencySeconds: null,
  healthy: false,
  message: "Not fetched yet",
};

function toIso(ts: Date): string {
  return ts.toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function fetchHapiDataset(
  dataset: string,
  parameters: string,
  start: string,
  stop: string,
): Promise<unknown> {
  const url = new URL("https://vires.services/hapi/data");
  url.searchParams.set("id", dataset);
  url.searchParams.set("parameters", parameters);
  url.searchParams.set("time.min", start);
  url.searchParams.set("time.max", stop);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`ESA HAPI returned HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * HAPI JSON nests vector parameters, so `parameters=B_NEC` yields `[time, [n, e, c]]`.
 * A flattened `[time, n, e, c]` row is accepted too. Anything else, or any non-finite
 * component, is rejected rather than defaulted to zero.
 */
export function parseNecRow(row: unknown): { timestamp: string; n: number; e: number; c: number } | null {
  if (!Array.isArray(row) || typeof row[0] !== "string") return null;
  let components: unknown[];
  if (row.length === 2 && Array.isArray(row[1])) {
    components = row[1];
  } else if (row.length === 4) {
    components = row.slice(1);
  } else {
    return null;
  }
  if (components.length !== 3) return null;
  const [n, e, c] = components.map((v) => (v === null || v === "" ? Number.NaN : Number(v)));
  if (![n, e, c].every(Number.isFinite) || !Number.isFinite(Date.parse(row[0]))) return null;
  return { timestamp: row[0], n, e, c };
}

export async function fetchEsaReadout(): Promise<ESAReadout | null> {
  try {
    const now = new Date();
    const start = new Date(now.getTime() - 15 * 60 * 1000);

    // Prefer stable near-real-time Swarm magnetic field series.
    const data = (await fetchHapiDataset(
      "SW_OPER_MAGA_LR_1B",
      "B_NEC",
      toIso(start),
      toIso(now),
    )) as { data?: unknown[] };

    if (!Array.isArray(data.data) || data.data.length === 0) {
      throw new Error("ESA HAPI returned no rows");
    }

    const row = data.data[data.data.length - 1];
    const parsed = parseNecRow(row);
    if (!parsed) {
      throw new Error("ESA row format invalid");
    }
    const { timestamp, n, e, c } = parsed;

    latestStatus = {
      source: SOURCE,
      lastSeen: timestamp,
      latencySeconds: Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000),
      healthy: true,
      message: "ESA HAPI OK",
    };

    return {
      timestamp,
      magneticFieldNec: vec(n, e, c),
    };
  } catch (error) {
    latestStatus = {
      source: SOURCE,
      lastSeen: latestStatus.lastSeen,
      latencySeconds: latestStatus.lastSeen
        ? Math.max(0, (Date.now() - Date.parse(latestStatus.lastSeen)) / 1000)
        : null,
      healthy: false,
      message: error instanceof Error ? error.message : "ESA HAPI fetch failed",
    };
    return null;
  }
}

export function getEsaStatus(): SourceStatus {
  return latestStatus;
}
