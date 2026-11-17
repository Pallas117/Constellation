/**
 * Incremental time-series polling helpers.
 *
 * The 5 s feed used to re-download its whole 24 h history (up to 17,280
 * points, several MB) on every poll. Now the first request backfills the
 * window, later requests ask only for points newer than the last one held,
 * and the merge returns the same array when nothing new arrived so React
 * skips the re-render.
 */

export interface Timestamped {
  timestamp: string;
}

export const SERIES_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SERIES_MAX_POINTS = 17_280;
/** Overlap re-requested on each poll, covering client/server clock skew. */
export const LOOKBACK_MARGIN_MS = 2 * 60 * 1000;

const time = (p: Timestamped) => Date.parse(p.timestamp);

/**
 * ISO 8601 lookback (`PT…S`) for the next request: the full window when
 * nothing is held yet, otherwise the gap since the newest point plus a margin.
 * Gaps (a hidden tab, backoff) are refilled because the lookback grows with them.
 */
export function lookbackSince(
  series: readonly Timestamped[] | null,
  nowMs: number,
  windowMs = SERIES_WINDOW_MS,
  marginMs = LOOKBACK_MARGIN_MS,
): string {
  const newest = series && series.length > 0 ? time(series[series.length - 1]) : NaN;
  const gap = Number.isFinite(newest) ? Math.max(0, nowMs - newest) + marginMs : windowMs;
  const seconds = Math.ceil(Math.min(windowMs, Math.max(marginMs, gap)) / 1000);
  return `PT${seconds}S`;
}

/**
 * The pushed points a poll hasn't caught up with yet: those newer than `base`'s newest. Returns
 * `pushed` itself when nothing changes, so React keeps the same state. Without this the pushed
 * list grew into a second 24 h copy of the feed (GAU-208).
 */
export function pendingAfter<T extends Timestamped>(pushed: readonly T[], base: readonly T[] | null): T[] {
  if (pushed.length === 0 || !base || base.length === 0) return pushed as T[];
  const newest = time(base[base.length - 1]);
  const keepFrom = pushed.findIndex((p) => time(p) > newest);
  if (keepFrom === 0) return pushed as T[];
  return keepFrom === -1 ? [] : pushed.slice(keepFrom);
}

/**
 * Append the points newer than the newest one held, then trim to the window.
 * Returns `prev` itself when nothing new arrived (an empty series when `prev` is
 * null). Held points are immutable: a re-sent timestamp never replaces one already shown.
 */
export function mergeSeries<T extends Timestamped>(
  prev: readonly T[] | null,
  incoming: readonly T[],
  windowMs = SERIES_WINDOW_MS,
  maxPoints = SERIES_MAX_POINTS,
): T[] {
  const held = prev ?? [];
  const newest = held.length > 0 ? time(held[held.length - 1]) : -Infinity;
  const seen = new Set<number>();
  const fresh = incoming
    .filter((p) => {
      const t = time(p);
      if (!Number.isFinite(t) || t <= newest || seen.has(t)) return false;
      seen.add(t);
      return true;
    })
    .sort((a, b) => time(a) - time(b));
  // Nothing new: `prev` itself, or an empty series when nothing is held yet (the history
  // panel can mount before both its backfill and the first live point, GAU-150).
  if (fresh.length === 0) return prev ? (prev as T[]) : [];

  const all = held.length > 0 ? [...held, ...fresh] : fresh;
  const cutoff = time(all[all.length - 1]) - windowMs;
  let start = Math.max(0, all.length - maxPoints);
  while (start < all.length && time(all[start]) < cutoff) start += 1;
  return start === 0 ? all : all.slice(start);
}

export interface Bucketed {
  timestamp: string;
  values: Record<string, number>;
}

/**
 * Mean of each numeric field over fixed time buckets, at most `maxBuckets`
 * of them, so a 24 h chart draws hundreds of points instead of 17,280.
 * Bucket width is a whole number of minutes; returns it for the chart label.
 */
export function bucketMeans<T extends Timestamped>(
  series: readonly T[],
  pick: (p: T) => Record<string, number>,
  maxBuckets = 720,
): { buckets: Bucketed[]; bucketMs: number } {
  if (series.length === 0) return { buckets: [], bucketMs: 60_000 };
  const first = time(series[0]);
  const span = time(series[series.length - 1]) - first;
  const bucketMs = Math.max(1, Math.ceil(span / maxBuckets / 60_000)) * 60_000;

  const buckets: Bucketed[] = [];
  let key = NaN;
  let sums: Record<string, number> = {};
  let counts: Record<string, number> = {};
  const flush = () => {
    if (!Number.isFinite(key)) return;
    const values: Record<string, number> = {};
    for (const k of Object.keys(sums)) values[k] = sums[k] / counts[k];
    buckets.push({ timestamp: new Date(first + key * bucketMs).toISOString(), values });
  };
  for (const p of series) {
    const t = time(p);
    if (!Number.isFinite(t)) continue;
    const k = Math.floor((t - first) / bucketMs);
    if (k !== key) {
      flush();
      key = k;
      sums = {};
      counts = {};
    }
    for (const [name, v] of Object.entries(pick(p))) {
      if (!Number.isFinite(v)) continue;
      sums[name] = (sums[name] ?? 0) + v;
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  flush();
  return { buckets, bucketMs };
}
