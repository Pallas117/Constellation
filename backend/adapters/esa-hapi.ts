import { vec } from "../physics/coordinates.js";
import type { DataSource, SourceStatus } from "../types.js";

const SOURCE: DataSource = "esa-hapi";
const HAPI_BASE = "https://vires.services/hapi";
const DATASET = "SW_FAST_MAGA_LR_1B";

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
  const url = new URL(`${HAPI_BASE}/data`);
  url.searchParams.set("dataset", dataset);
  url.searchParams.set("parameters", parameters);
  url.searchParams.set("start", start);
  url.searchParams.set("stop", stop);
  url.searchParams.set("format", "json");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`ESA HAPI returned HTTP ${response.status}`);
  }
  return parseHapiJson(await response.text());
}

/** VirES emits bare NaN for missing samples, which is not valid JSON; read those as null. */
export function parseHapiJson(text: string): unknown {
  return JSON.parse(text.replace(/\bNaN\b/g, "null"));
}

/** Last time covered by the dataset; requests beyond it fail with HAPI 1405. */
async function fetchStopDate(dataset: string): Promise<Date> {
  const url = new URL(`${HAPI_BASE}/info`);
  url.searchParams.set("dataset", dataset);
  const response = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`ESA HAPI info returned HTTP ${response.status}`);
  }
  const info = parseHapiJson(await response.text()) as { stopDate?: unknown };
  const stop = typeof info.stopDate === "string" ? new Date(info.stopDate) : null;
  if (!stop || Number.isNaN(stop.getTime())) {
    throw new Error("ESA HAPI info has no stopDate");
  }
  return stop;
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
    // FAST is Swarm's lowest-latency L1b product (hours behind, vs days for OPER). Query
    // the last 15 minutes the dataset actually covers.
    const stopDate = await fetchStopDate(DATASET);
    const stop = new Date(Math.min(Date.now(), stopDate.getTime()));
    const start = new Date(stop.getTime() - 15 * 60 * 1000);
    const data = (await fetchHapiDataset(DATASET, "B_NEC", toIso(start), toIso(stop))) as { data?: unknown[] };

    if (!Array.isArray(data.data) || data.data.length === 0) {
      throw new Error("ESA HAPI returned no rows");
    }

    // Trailing samples are often NaN-filled; use the latest complete one.
    let parsed: ReturnType<typeof parseNecRow> = null;
    for (let i = data.data.length - 1; i >= 0 && !parsed; i -= 1) {
      parsed = parseNecRow(data.data[i]);
    }
    if (!parsed) {
      throw new Error("ESA HAPI returned no complete B_NEC sample");
    }
    const { timestamp, n, e, c } = parsed;

    latestStatus = {
      source: SOURCE,
      lastSeen: timestamp,
      latencySeconds: Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000),
      healthy: true,
      message: `ESA HAPI OK (Swarm A FAST, ${((Date.now() - Date.parse(timestamp)) / 3600000).toFixed(1)} h behind)`,
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
