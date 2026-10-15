// The public latest-point feed behind useSpaceWeather, polled with usePolledFeed.
import type { ConnectivityMode } from "../../hooks/useConnectivity.ts";
import {
  canonicalToInterpolated,
  transformApiResponse,
  validateSpaceWeatherResponse,
  type InterpolatedData,
} from "../dataProcessing.ts";

export const SPACE_WEATHER_LATEST_PATH = "/api/feed/space-weather/latest";
const CLOUD_INTERVAL_MS = 60_000;

/** Consecutive failures before the UI shows "no data" instead of the last reading. */
export const MARK_UNAVAILABLE_AFTER = 3;

export interface SpaceWeatherPolling {
  intervalMs: number;
  maxBackoffMs: number;
}

/**
 * How often to poll for the link we're on: once a minute in the cloud, every
 * 3 min over satellite, and not at all when air-gapped (null).
 */
export function spaceWeatherPolling(mode: ConnectivityMode): SpaceWeatherPolling | null {
  if (mode === "AIRGAP") return null;
  const intervalMs = mode === "SAT" ? 3 * CLOUD_INTERVAL_MS : CLOUD_INTERVAL_MS;
  return { intervalMs, maxBackoffMs: 5 * intervalMs };
}

export interface SpaceWeatherReading {
  data: InterpolatedData;
  /** When the browser received it (the measurement carries its own timestamp). */
  receivedAt: Date;
}

/**
 * The backend serves CanonicalSpaceWeatherPoint; the legacy edge-function shape
 * is still accepted. Throws on anything else, which the poller counts as a failure.
 */
export function parseSpaceWeatherReading(json: unknown, receivedAt = new Date()): SpaceWeatherReading {
  const legacy = validateSpaceWeatherResponse(json);
  const data = canonicalToInterpolated(json) ?? (legacy ? transformApiResponse(legacy) : null);
  if (!data) throw new Error("Invalid response format");
  return { data, receivedAt };
}

export function liveDataLost(failures: number): boolean {
  return failures >= MARK_UNAVAILABLE_AFTER;
}
