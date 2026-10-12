import type { CanonicalSpaceWeatherPoint } from "./types/space-weather";

export interface MeasuredDrivers {
  kp: number;
  bz: number;
  speed: number;
}

/**
 * Kp, Bz and solar-wind speed from a canonical point, but only when it is a current measurement
 * (not stale, not tier 3, all values finite). Otherwise null: conditions are unknown, and callers
 * must say so rather than substitute defaults or report "nominal" (GAU-63 / GAU-114).
 */
export function measuredDrivers(
  point: Pick<CanonicalSpaceWeatherPoint, "indices" | "magneticField" | "solarWind" | "quality"> | null | undefined,
): MeasuredDrivers | null {
  if (!point) return null;
  if (point.quality?.stale === true || point.quality?.tier === 3) return null;
  const kp = point.indices?.kp;
  const bz = point.magneticField?.z;
  const speed = point.solarWind?.speed;
  if (![kp, bz, speed].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return { kp: kp as number, bz: bz as number, speed: speed as number };
}
