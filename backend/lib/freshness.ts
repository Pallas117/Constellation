import type { CanonicalSpaceWeatherPoint } from "../types.js";

/** Carried values expire after 15 minutes (GAU-15). */
export const LATEST_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * An older point (e.g. from the bedrock buffer) may still be served, but flagged stale
 * rather than presented as live.
 */
export function withFreshness(point: CanonicalSpaceWeatherPoint, nowMs = Date.now()): CanonicalSpaceWeatherPoint {
  const t = Date.parse(point.timestamp);
  if (Number.isFinite(t) && nowMs - t <= LATEST_MAX_AGE_MS) {
    return point;
  }
  return { ...point, quality: { ...point.quality, stale: true, lowConfidence: true, tier: 3 } };
}
