import { vec } from "../physics/coordinates.js";
import type { DataSource, SourceStatus } from "../types.js";

const SOURCE: DataSource = "esa-hapi";

export interface ESAReadout {
  timestamp: string;
  magneticFieldGse: { x: number; y: number; z: number };
  densityHint: number;
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
    if (!Array.isArray(row) || row.length < 4) {
      throw new Error("ESA row format invalid");
    }

    const timestamp = String(row[0]);
    const bx = Number((row[1] as number[] | undefined)?.[0] ?? 0);
    const by = Number((row[1] as number[] | undefined)?.[1] ?? 0);
    const bz = Number((row[1] as number[] | undefined)?.[2] ?? 0);

    latestStatus = {
      source: SOURCE,
      lastSeen: timestamp,
      latencySeconds: Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000),
      healthy: true,
      message: "ESA HAPI OK",
    };

    return {
      timestamp,
      magneticFieldGse: vec(bx, by, bz),
      densityHint: 4,
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
