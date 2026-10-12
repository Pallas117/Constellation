import type { DataSource, SourceStatus } from "../types.js";

const SOURCE: DataSource = "mms-lasp";

export interface MMSBurstWindow {
  /** File start time (UTC), from the SDC `timetag`. */
  start: string;
  /** The file_info API gives no end time; unknown rather than guessed. */
  end: null;
  mode: "brst" | "srvy";
  fileName: string;
}

let latestStatus: SourceStatus = {
  source: SOURCE,
  lastSeen: null,
  latencySeconds: null,
  healthy: false,
  message: "Not fetched yet",
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const LASP_LOOKBACK_DAYS = 2;

/** SDC timetags are UTC without a zone suffix, e.g. "2024-06-04T23:26:53". */
function timetagToIso(tag: unknown): string | null {
  if (typeof tag !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(tag)) return null;
  const t = Date.parse(tag.endsWith("Z") ? tag : `${tag}Z`);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export async function fetchMmsBurstWindows(nowMs = Date.now()): Promise<MMSBurstWindow[]> {
  try {
    // end_date is exclusive, so query through tomorrow to include today.
    const startDate = new Date(nowMs - LASP_LOOKBACK_DAYS * DAY_MS).toISOString().slice(0, 10);
    const endDate = new Date(nowMs + DAY_MS).toISOString().slice(0, 10);

    const url = new URL("https://lasp.colorado.edu/mms/sdc/public/files/api/v1/file_info/science");
    url.searchParams.set("sc_id", "mms1");
    url.searchParams.set("instrument_id", "fgm");
    url.searchParams.set("data_rate_mode", "brst");
    url.searchParams.set("data_level", "l2");
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("end_date", endDate);

    const response = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (!response.ok) {
      throw new Error(`MMS LASP returned HTTP ${response.status}`);
    }

    const json = (await response.json()) as {
      files?: Array<{ file_name?: string; timetag?: string }>;
    };

    const windows: MMSBurstWindow[] = Array.isArray(json.files)
      ? json.files
          .map((file) => ({
            start: timetagToIso(file.timetag) ?? "",
            end: null,
            mode: "brst" as const,
            fileName: typeof file.file_name === "string" ? file.file_name : "",
          }))
          .filter((window) => window.start)
      : [];

    // Freshness is the age of the newest file, not the time of this request.
    const newest = windows.reduce<string | null>((max, w) => (max === null || w.start > max ? w.start : max), null);
    latestStatus = {
      source: SOURCE,
      lastSeen: newest ?? latestStatus.lastSeen,
      latencySeconds: newest ? Math.max(0, Math.round((nowMs - Date.parse(newest)) / 1000)) : latestStatus.latencySeconds,
      healthy: windows.length > 0,
      message:
        windows.length > 0
          ? `L2 burst files: ${windows.length}`
          : `No L2 burst files in the last ${LASP_LOOKBACK_DAYS} days (L2 is published with a delay)`,
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
