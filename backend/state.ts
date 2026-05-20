import type {
  AuroraGridPoint,
  CanonicalSpaceWeatherPoint,
  MMSReconVectorPoint,
  SourceStatus,
  SphericalHarmonicCoefficients,
} from "./types.js";

const MAX_POINTS = 20000;
const MAX_MMS_POINTS = 5000;

// Redundancy 1: Triple-Buffered State Storage
const canonicalFeed: CanonicalSpaceWeatherPoint[] = [];
const secondaryFeed: CanonicalSpaceWeatherPoint[] = []; // Filtered/Sanitized redundancy
const fallbackFeed: CanonicalSpaceWeatherPoint[] = [];  // Deep history/Seed redundancy

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

  // Redundancy: Push to secondary with slight jitter/delay simulation if needed
  // or just as a hot-spare.
  secondaryFeed.push({ ...point });
  if (secondaryFeed.length > MAX_POINTS) {
    secondaryFeed.shift();
  }

  // Backup: Keep a very sparse deep history for emergency fallback
  if (canonicalFeed.length % 10 === 0) {
    fallbackFeed.push({ ...point });
    if (fallbackFeed.length > 500) {
      fallbackFeed.shift();
    }
  }
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
  if (canonicalFeed.length > 0) return canonicalFeed;
  if (secondaryFeed.length > 0) return secondaryFeed;
  if (fallbackFeed.length > 0) return fallbackFeed;
  return canonicalFeed;
}

export function getMmsFeed(): MMSReconVectorPoint[] {
  return mmsFeed;
}

export function getLatestCanonical(): CanonicalSpaceWeatherPoint | null {
  if (canonicalFeed.length > 0) return canonicalFeed[canonicalFeed.length - 1];
  if (secondaryFeed.length > 0) return secondaryFeed[secondaryFeed.length - 1];
  return fallbackFeed.length > 0 ? fallbackFeed[fallbackFeed.length - 1] : null;
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
