/**
 * Measurement times for a feed buffer, kept beside it so a lookback query can binary-search
 * instead of parsing every timestamp on every poll (the 5 s feed is polled every 5 s per tab
 * over ~20,000 points).
 *
 * The search is only used while the times are all finite and non-decreasing. Otherwise
 * `since` falls back to the full scan, so the result always equals
 * `points.filter((p) => Date.parse(p.timestamp) >= threshold).slice(-limit)`.
 */
export class TimeIndex {
  private readonly times: number[] = [];
  /** Adjacent pairs where the later time is smaller (both finite). */
  private inversions = 0;
  /** Times that are not finite (unparseable timestamps). */
  private invalid = 0;

  /** Call after appending `timestamp` to the buffer. */
  push(timestamp: string): void {
    const t = Date.parse(timestamp);
    const last = this.times.length > 0 ? this.times[this.times.length - 1] : undefined;
    if (!Number.isFinite(t)) this.invalid += 1;
    else if (last !== undefined && Number.isFinite(last) && t < last) this.inversions += 1;
    this.times.push(t);
  }

  /** Call after removing the buffer's first element. */
  shift(): void {
    const first = this.times.shift();
    if (first === undefined) return;
    if (!Number.isFinite(first)) this.invalid -= 1;
    else if (this.times.length > 0 && Number.isFinite(this.times[0]) && this.times[0] < first) this.inversions -= 1;
  }

  get length(): number {
    return this.times.length;
  }

  /** The newest `limit` points measured at or after `thresholdMs`, oldest first. */
  since<T extends { timestamp: string }>(points: readonly T[], thresholdMs: number, limit: number): T[] {
    if (this.inversions > 0 || this.invalid > 0 || points.length !== this.times.length || Number.isNaN(thresholdMs)) {
      const filtered = points.filter((point) => Date.parse(point.timestamp) >= thresholdMs);
      return filtered.slice(Math.max(0, filtered.length - limit));
    }
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.times[mid] < thresholdMs) lo = mid + 1;
      else hi = mid;
    }
    const start = points.length - limit;
    return points.slice(start > lo ? start : lo);
  }
}
