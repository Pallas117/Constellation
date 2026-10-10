import type { DataSource, SourceStatus } from "../types.js";

const SOURCE: DataSource = "jaxa-erg";

let latestStatus: SourceStatus = {
  source: SOURCE,
  lastSeen: null,
  latencySeconds: null,
  healthy: false,
  message: "Not fetched yet",
};

/**
 * Reachability probe for the JAXA DARTS ERG (Arase) catalog page. It ingests no particle
 * data, so it never returns a readout and never reports the source as a healthy feed —
 * only whether the catalog is reachable.
 */
export async function probeJaxaCatalog(): Promise<boolean> {
  try {
    const url = "https://darts.isas.jaxa.jp/en/datasets/darts:erg-04004/";
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      throw new Error(`JAXA DARTS returned HTTP ${response.status}`);
    }
    const html = await response.text();
    const reachable = html.includes("ERG") || html.includes("Arase");

    latestStatus = {
      source: SOURCE,
      lastSeen: latestStatus.lastSeen,
      latencySeconds: latestStatus.latencySeconds,
      healthy: false,
      message: reachable
        ? "JAXA ERG catalog reachable; no particle data ingested (probe only)"
        : "JAXA catalog response format unexpected",
    };
    return reachable;
  } catch (error) {
    latestStatus = {
      source: SOURCE,
      lastSeen: latestStatus.lastSeen,
      latencySeconds: latestStatus.latencySeconds,
      healthy: false,
      message: error instanceof Error ? error.message : "JAXA probe failed",
    };
    return false;
  }
}

export function getJaxaStatus(): SourceStatus {
  return latestStatus;
}
