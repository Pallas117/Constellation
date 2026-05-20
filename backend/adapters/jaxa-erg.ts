import type { DataSource, SourceStatus } from "../types.js";

const SOURCE: DataSource = "jaxa-erg";

export interface JAXAReadout {
  timestamp: string;
  particleFluxHint: number;
  freshnessSeconds: number;
}

let latestStatus: SourceStatus = {
  source: SOURCE,
  lastSeen: null,
  latencySeconds: null,
  healthy: false,
  message: "Not fetched yet",
};

export async function fetchJaxaReadout(): Promise<JAXAReadout | null> {
  try {
    // DARTS endpoints are frequently catalog-oriented and delayed; treat as opportunistic.
    const url = "https://darts.isas.jaxa.jp/en/datasets/darts:erg-04004/";
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      throw new Error(`JAXA DARTS returned HTTP ${response.status}`);
    }
    const html = await response.text();
    const hasDataset = html.includes("ERG") || html.includes("Arase");
    const nowIso = new Date().toISOString();

    latestStatus = {
      source: SOURCE,
      lastSeen: nowIso,
      latencySeconds: 3600,
      healthy: hasDataset,
      message: hasDataset
        ? "JAXA ERG catalog reachable (latency-tolerant source)"
        : "JAXA response format unexpected",
    };

    return {
      timestamp: nowIso,
      particleFluxHint: hasDataset ? 1 : 0,
      freshnessSeconds: 3600,
    };
  } catch (error) {
    latestStatus = {
      source: SOURCE,
      lastSeen: latestStatus.lastSeen,
      latencySeconds: latestStatus.latencySeconds,
      healthy: false,
      message: error instanceof Error ? error.message : "JAXA fetch failed",
    };
    return null;
  }
}

export function getJaxaStatus(): SourceStatus {
  return latestStatus;
}
