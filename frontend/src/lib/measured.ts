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

export interface WeatherRisk {
  label: string;
  description: string;
  /** 0–100 threat score, or null when the risk is unknown. */
  score: number | null;
}

/**
 * Heliophysics threat level from the measured drivers. Without a current, complete measurement
 * the risk is unknown: no score at all, never 0 or "Stable" (GAU-81 / GAU-114).
 */
export function weatherRisk(point: Parameters<typeof measuredDrivers>[0]): WeatherRisk {
  const drivers = measuredDrivers(point);
  if (!drivers) {
    return {
      label: "Unknown",
      description: point
        ? "Space weather data is stale or incomplete; conditions are unknown."
        : "No solar wind feed available yet.",
      score: null,
    };
  }

  const { speed, kp, bz } = drivers;
  const score = Math.min(100, Math.max(0, Math.round((kp * 9) + Math.abs(bz) * 3 + ((speed - 300) / 15))));

  if (score > 80) {
    return {
      label: "Severe Storm",
      description: "Strong solar wind pressure and southward IMF make device protection critical now.",
      score,
    };
  }
  if (score > 50) {
    return {
      label: "Active Warning",
      description: "Geomagnetic activity is rising. Prioritize thermal and load redistribution across SWAP tiers.",
      score,
    };
  }
  if (score > 25) {
    return {
      label: "Moderate Risk",
      description: "Transitions in the magnetosphere can begin to influence sensitive routing and power budgets.",
      score,
    };
  }
  return { label: "Stable", description: "Current conditions are below the threshold for operational impact.", score };
}
