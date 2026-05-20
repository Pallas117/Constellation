import type { DataSource, SourceStatus } from "../types.js";

const SOURCE: DataSource = "mms-lasp";

export interface MMSBurstWindow {
  start: string;
  end: string;
  mode: "brst" | "srvy";
}

let latestStatus: SourceStatus = {
  source: SOURCE,
  lastSeen: null,
  latencySeconds: null,
  healthy: false,
  message: "Not fetched yet",
};

export async function fetchMmsBurstWindows(): Promise<MMSBurstWindow[]> {
  try {
    const now = new Date();
    const startDate = new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = now.toISOString().slice(0, 10);

    const url = new URL("https://lasp.colorado.edu/mms/sdc/public/files/api/v1/file_info/science");
    url.searchParams.set("sc_id", "mms1");
    url.searchParams.set("instrument_id", "fgm");
    url.searchParams.set("data_rate_mode", "brst");
    url.searchParams.set("level", "l2");
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("end_date", endDate);

    const response = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!response.ok) {
      throw new Error(`MMS LASP returned HTTP ${response.status}`);
    }

    const json = (await response.json()) as {
      files?: Array<{ tstart?: string; tend?: string }>;
    };

    const windows: MMSBurstWindow[] = Array.isArray(json.files)
      ? json.files
          .map((file) => ({
            start: file.tstart ?? "",
            end: file.tend ?? "",
            mode: "brst" as const,
          }))
          .filter((window) => window.start && window.end)
      : [];

    latestStatus = {
      source: SOURCE,
      lastSeen: new Date().toISOString(),
      latencySeconds: 0,
      healthy: windows.length > 0,
      message: windows.length > 0 ? `Burst windows: ${windows.length}` : "No burst windows currently available",
    };

    return windows;
  } catch (error) {
    latestStatus = {
      source: SOURCE,
      lastSeen: latestStatus.lastSeen,
      latencySeconds: latestStatus.latencySeconds,
      healthy: false,
      message: error instanceof Error ? error.message : "MMS LASP fetch failed",
    };
    return [];
  }
}

export function getMmsLaspStatus(): SourceStatus {
  return latestStatus;
}
