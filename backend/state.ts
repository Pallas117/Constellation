import type {
  AuroraGridPoint,
  CanonicalSpaceWeatherPoint,
  MMSReconVectorPoint,
  SourceStatus,
  SphericalHarmonicCoefficients,
} from "./types.js";

const MAX_POINTS = 20000;
const MAX_MMS_POINTS = 5000;

// One buffer. The former "secondary" and "fallback" copies were read only when this one was
// empty, which never happens once a point is pushed (they were pushed together): about 4 MB of
// duplicate objects for nothing. The fallback's `length % 10` test was also always true at the
// cap, so it held the last 500 points rather than sparse history. Persistence is bedrock.
const canonicalFeed: CanonicalSpaceWeatherPoint[] = [];

const mmsFeed: MMSReconVectorPoint[] = [];
let sourceStatus: SourceStatus[] = [];
let auroraMap:
  | {
      timestamp: string;
      nside: number;
      grid: AuroraGridPoint[];
      harmonics: SphericalHarmonicCoefficients;
    }
  | null = null;

export function pushCanonical(point: CanonicalSpaceWeatherPoint): void {
  // Push to primary
  canonicalFeed.push(point);
  if (canonicalFeed.length > MAX_POINTS) {
    canonicalFeed.shift();
  }

}

/**
 * Reload the live buffer from persisted points after a restart (oldest first). Only when the
 * buffer is empty, so it never duplicates points the worker has already pushed. GAU-117.
 */
export function seedCanonical(points: CanonicalSpaceWeatherPoint[]): number {
  if (canonicalFeed.length > 0) return 0;
  // Each persisted line parses into its own objects, so 20,000 seeded points held 20,000 copies of
  // the same NOAA alert list (live points share one array): share it again when unchanged.
  let alertsKey: string | undefined;
  let alerts: CanonicalSpaceWeatherPoint["noaaAlerts"];
  for (const point of points.slice(-MAX_POINTS)) {
    if (point.noaaAlerts) {
      const key = JSON.stringify(point.noaaAlerts);
      if (key === alertsKey) point.noaaAlerts = alerts;
      else [alertsKey, alerts] = [key, point.noaaAlerts];
    }
    pushCanonical(point);
  }
  return Math.min(points.length, MAX_POINTS);
}

export function pushMms(point: MMSReconVectorPoint): void {
  mmsFeed.push(point);
  if (mmsFeed.length > MAX_MMS_POINTS) {
    mmsFeed.shift();
  }
}

export function setSourceStatus(status: SourceStatus[]): void {
  sourceStatus = status;
}

export function setAuroraMap(map: {
  timestamp: string;
  nside: number;
  grid: AuroraGridPoint[];
  harmonics: SphericalHarmonicCoefficients;
}): void {
  auroraMap = map;
}

export function getCanonicalFeed(): CanonicalSpaceWeatherPoint[] {
  return canonicalFeed;
}

export function getMmsFeed(): MMSReconVectorPoint[] {
  return mmsFeed;
}

export function getLatestCanonical(): CanonicalSpaceWeatherPoint | null {
  return canonicalFeed.length > 0 ? canonicalFeed[canonicalFeed.length - 1] : null;
}

export function getLatestMms(): MMSReconVectorPoint | null {
  return mmsFeed.length > 0 ? mmsFeed[mmsFeed.length - 1] : null;
}

export function getSourceStatus(): SourceStatus[] {
  return sourceStatus;
}

export function getAuroraMap():
  | {
      timestamp: string;
      nside: number;
      grid: AuroraGridPoint[];
      harmonics: SphericalHarmonicCoefficients;
    }
  | null {
  return auroraMap;
}
