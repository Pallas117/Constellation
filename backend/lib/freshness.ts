import { freshnessMs } from "../../shared/policy/freshness.js";
import type { CanonicalSpaceWeatherPoint } from "../types.js";

/** Carried values expire with the L1 bound (GAU-15; shared/policy/freshness.json). */
export const LATEST_MAX_AGE_MS = freshnessMs("l1_solar_wind");

/**
 * An older point (e.g. from the bedrock buffer) may still be served, but flagged stale
 * rather than presented as live.
 */
export function withFreshness(point: CanonicalSpaceWeatherPoint, nowMs = Date.now()): CanonicalSpaceWeatherPoint {
  // Judge by when the values were measured; a recently issued point can carry old values.
  const t = Date.parse(point.observedAt ?? point.timestamp);
  if (Number.isFinite(t) && nowMs - t <= LATEST_MAX_AGE_MS) {
    return point;
  }
  return { ...point, quality: { ...point.quality, stale: true, lowConfidence: true, tier: 3 } };
}
