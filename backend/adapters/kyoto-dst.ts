import type { DataSource, SourceStatus } from "../types.js";

const SOURCE: DataSource = "kyoto-dst";

// Kyoto WDC real-time (quicklook) Dst, hourly, as republished by SWPC. Provisional: later Kyoto
// revisions can differ, but it is a measurement, unlike the nowcast's model estimate.
const KYOTO_DST_URL = "https://services.swpc.noaa.gov/products/kyoto-dst.json";

/** Hourly values: past this age (one missed hour) the reading is unknown and the model is used. */
export const DST_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface DstReading {
  dst: number;
  /** Start of the hour the value describes (UTC). */
  timestamp: string;
}

let latestStatus: SourceStatus = {
  source: SOURCE,
  lastSeen: null,
  latencySeconds: null,
  healthy: false,
  message: "Not fetched yet",
};

/** SWPC time tags carry no zone ("2026-10-12T09:00:00") but are UTC. */
function timeTagMs(tag: unknown): number {
  if (typeof tag !== "string") return Number.NaN;
  return Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(tag) ? tag : `${tag}Z`);
}

/** Newest row with a finite Dst in a physical range; fill and non-numeric rows are skipped. */
export function pickLatestDst(data: unknown): DstReading | null {
  if (!Array.isArray(data)) return null;
  let best: DstReading | null = null;
  let bestMs = -Infinity;
  for (const row of data) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    // Unpublished hours arrive as "" or null, and Number("") is 0: only real numbers count.
    const dst =
      typeof rec.dst === "number" ? rec.dst
      : typeof rec.dst === "string" && rec.dst.trim() !== "" ? Number(rec.dst)
      : Number.NaN;
    const ms = timeTagMs(rec.time_tag);
    if (!Number.isFinite(dst) || dst < -2000 || dst > 500 || !Number.isFinite(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = { dst, timestamp: new Date(ms).toISOString() };
  }
  return best;
}

/** The measured Dst if it is under DST_MAX_AGE_MS old at `nowMs`, otherwise undefined. */
export function freshDst(reading: DstReading | null, nowMs: number): number | undefined {
  if (!reading) return undefined;
  const age = nowMs - Date.parse(reading.timestamp);
  return age >= 0 && age <= DST_MAX_AGE_MS ? reading.dst : undefined;
}

export async function fetchKyotoDst(nowMs = Date.now()): Promise<DstReading | null> {
  try {
    const response = await fetch(KYOTO_DST_URL, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      throw new Error(`Kyoto Dst feed returned HTTP ${response.status}`);
    }
    const reading = pickLatestDst(await response.json());
    const fresh = freshDst(reading, nowMs) !== undefined;
    latestStatus = {
      source: SOURCE,
      lastSeen: reading?.timestamp ?? latestStatus.lastSeen,
      latencySeconds: reading
        ? Math.max(0, Math.round((nowMs - Date.parse(reading.timestamp)) / 1000))
        : latestStatus.latencySeconds,
      healthy: fresh,
      message: fresh
        ? "Kyoto real-time Dst current (provisional quicklook)"
        : "Kyoto Dst missing or older than 2 h; using the labelled model estimate",
    };
    return reading;
  } catch (error) {
    latestStatus = {
      source: SOURCE,
      lastSeen: latestStatus.lastSeen,
      latencySeconds: latestStatus.latencySeconds,
      healthy: false,
      message: error instanceof Error && error.name === "TimeoutError"
        ? "Kyoto Dst feed timed out"
        : error instanceof Error ? error.message : "Kyoto Dst fetch failed",
    };
    return null;
  }
}

export function getKyotoDstStatus(): SourceStatus {
  return latestStatus;
}
