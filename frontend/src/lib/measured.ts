import { formatDuration } from "./pipelineLatency";
import type { CanonicalSpaceWeatherPoint } from "./types/space-weather";

/** The backend's cap for serving a point as current (LATEST_MAX_AGE_MS in backend/lib/freshness.ts, GAU-15). */
export const MEASUREMENT_MAX_AGE_MS = 15 * 60 * 1000;

type FeedPoint = Pick<CanonicalSpaceWeatherPoint, "timestamp" | "indices" | "magneticField" | "solarWind" | "quality">;

/** How old a point is, or null when its time is missing or unparseable. */
function pointAgeMs(point: FeedPoint, nowMs: number): number | null {
  const t = Date.parse(point.timestamp);
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
}

/**
 * A point is current only if the backend has not flagged it stale or tier 3 and it is within the
 * backend's age cap. The client re-checks the age because a stopped feed leaves its last point in
 * place, still unflagged (GAU-81).
 */
function isCurrent(point: FeedPoint, nowMs: number): boolean {
  if (point.quality?.stale === true || point.quality?.tier === 3) return false;
  const age = pointAgeMs(point, nowMs);
  return age !== null && age <= MEASUREMENT_MAX_AGE_MS;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export interface MeasuredDrivers {
  kp: number;
  bz: number;
  speed: number;
}

/**
 * Kp, Bz and solar-wind speed from a canonical point, but only when it is a current measurement
 * (not stale, not tier 3, not older than the age cap, all values finite). Otherwise null:
 * conditions are unknown, and callers must say so rather than substitute defaults or report
 * "nominal" (GAU-63 / GAU-114 / GAU-81).
 */
export function measuredDrivers(point: FeedPoint | null | undefined, nowMs = Date.now()): MeasuredDrivers | null {
  if (!point || !isCurrent(point, nowMs)) return null;
  const kp = point.indices?.kp;
  const bz = point.magneticField?.z;
  const speed = point.solarWind?.speed;
  if (![kp, bz, speed].every(isFiniteNumber)) return null;
  return { kp: kp as number, bz: bz as number, speed: speed as number };
}

export interface ReadingView {
  /** The value when current; otherwise "Stale" or "Unknown", never an old number. */
  text: string;
  current: boolean;
  /** Why no value is shown, with the data's age when there is one; null when current. */
  note: string | null;
}

/**
 * Kp and Bz for display. A stale, flagged or over-age point shows "Stale" and its age, not its old
 * values; no point, or a missing field, shows "Unknown" (GAU-81).
 */
export function driverReadings(
  point: FeedPoint | null | undefined,
  nowMs = Date.now(),
): { kp: ReadingView; bz: ReadingView } {
  if (!point) {
    const none: ReadingView = { text: "Unknown", current: false, note: "No reading yet" };
    return { kp: none, bz: none };
  }
  if (!isCurrent(point, nowMs)) {
    const age = pointAgeMs(point, nowMs);
    const stale: ReadingView = {
      text: "Stale",
      current: false,
      note: age === null ? "Reading has no valid time" : `Data age ${formatDuration(age)}`,
    };
    return { kp: stale, bz: stale };
  }
  const missing: ReadingView = { text: "Unknown", current: false, note: "Not in the latest reading" };
  const kp = point.indices?.kp;
  const bz = point.magneticField?.z;
  return {
    kp: isFiniteNumber(kp) ? { text: String(kp), current: true, note: null } : missing,
    bz: isFiniteNumber(bz) ? { text: `${bz.toFixed(1)} nT`, current: true, note: null } : missing,
  };
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
export function weatherRisk(point: FeedPoint | null | undefined, nowMs = Date.now()): WeatherRisk {
  const drivers = measuredDrivers(point, nowMs);
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
