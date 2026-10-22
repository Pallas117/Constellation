/**
 * The space environment Gauss held at a past moment (GAU-57): the newest canonical point issued
 * at or before that moment, never one from after it. Works the same over the live feed's history
 * and over a storm replay's points, so a trust record means the same thing in both.
 */
import type { CanonicalSpaceWeatherPoint } from "../types.js";

/** A reading issued longer than this before the inference doesn't describe it: unknown, not stretched. */
export const MAX_READING_LAG_MS = 2 * 60_000;

export interface EnvironmentAt {
  point: CanonicalSpaceWeatherPoint;
  /** When Gauss issued the point it held at that moment. */
  issuedAt: string;
  /** Inference time minus issue time, ms. */
  lagMs: number;
}

export class EnvironmentHistory {
  private readonly points: CanonicalSpaceWeatherPoint[];
  private readonly times: number[];

  /** `points` in any order; points without a valid issue time are ignored. */
  constructor(points: readonly CanonicalSpaceWeatherPoint[], readonly label: string) {
    const valid = points.filter((p) => Number.isFinite(Date.parse(p.timestamp)));
    valid.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    this.points = valid;
    this.times = valid.map((p) => Date.parse(p.timestamp));
  }

  get size(): number {
    return this.points.length;
  }

  /** The point Gauss held at `atMs`, or null when it had none within `maxLagMs` before. */
  at(atMs: number, maxLagMs = MAX_READING_LAG_MS): EnvironmentAt | null {
    // Last index with time <= atMs (binary search: histories hold ~20k points).
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] <= atMs) lo = mid + 1;
      else hi = mid;
    }
    const i = lo - 1;
    if (i < 0) return null;
    const lagMs = atMs - this.times[i];
    if (lagMs > maxLagMs) return null;
    return { point: this.points[i], issuedAt: this.points[i].timestamp, lagMs };
  }
}
