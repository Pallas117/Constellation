import assert from "node:assert/strict";
import test from "node:test";
import {
  getCanonicalFeed,
  getMmsFeed,
  pushCanonical,
  pushMms,
} from "./state.js";
import type { CanonicalSpaceWeatherPoint, MMSReconVectorPoint } from "./types.js";

function canonicalPoint(i: number): CanonicalSpaceWeatherPoint {
  const ts = new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 5_000).toISOString();
  return {
    timestamp: ts,
    source: "fusion",
    rho: 5,
    velocity: { x: -400, y: 0, z: 0, magnitude: 400 },
    magneticField: { x: 1, y: -2, z: -3, bt: 3.7416573868 },
    electricField: { x: 0, y: 1, z: 0, ey: 1 },
    solarWind: { speed: 400, density: 5, dynamicPressure: 2 },
    indices: { kp: 2, dst: -20 },
    coupling: { newell: 1200, epsilon: 1.2e11 },
    propagation: { l1DelaySeconds: 3750, etaEarthArrival: ts },
    alerts: { stormTier: "quiet", reason: "test" },
    quality: {
      outlier: false,
      stale: false,
      interpolated: false,
      extrapolated: false,
      lowConfidence: false,
    },
    uncertainty: {
      speed: { lower: 360, upper: 440, sigma: 20 },
      density: { lower: 4, upper: 6, sigma: 0.5 },
      bz: { lower: -4, upper: -2, sigma: 0.5 },
    },
  };
}

function mmsPoint(i: number): MMSReconVectorPoint {
  const ts = new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 5_000).toISOString();
  return {
    timestamp: ts,
    barycenterGsmRe: { x: 10, y: 0, z: 1 },
    currentDensity: { x: 3, y: 4, z: 0, magnitude: 5 },
    normal: { x: 0, y: 0, z: 1 },
    lmn: {
      l: { x: 1, y: 0, z: 0 },
      m: { x: 0, y: 1, z: 0 },
      n: { x: 0, y: 0, z: 1 },
    },
    quality: {
      valid: true,
      volume: 0.1,
      conditionNumber: 2,
      divCurlRatio: 0.1,
      confidence: "high",
    },
  };
}

test("canonical feed keeps a fixed-size ring buffer", () => {
  const feed = getCanonicalFeed();
  feed.length = 0;

  for (let i = 0; i < 20_050; i += 1) {
    pushCanonical(canonicalPoint(i));
  }

  assert.equal(feed.length, 20_000);
  assert.equal(feed[0]?.timestamp, canonicalPoint(50).timestamp);
  assert.equal(feed[feed.length - 1]?.timestamp, canonicalPoint(20_049).timestamp);
});

test("mms recon feed keeps a fixed-size ring buffer", () => {
  const feed = getMmsFeed();
  feed.length = 0;

  for (let i = 0; i < 5_040; i += 1) {
    pushMms(mmsPoint(i));
  }

  assert.equal(feed.length, 5_000);
  assert.equal(feed[0]?.timestamp, mmsPoint(40).timestamp);
  assert.equal(feed[feed.length - 1]?.timestamp, mmsPoint(5_039).timestamp);
});
