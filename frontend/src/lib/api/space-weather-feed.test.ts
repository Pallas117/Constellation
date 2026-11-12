import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MARK_UNAVAILABLE_AFTER,
  liveDataLost,
  parseSpaceWeatherReading,
  spaceWeatherPolling,
} from "./space-weather-feed.ts";

const canonical = {
  timestamp: "2026-10-10T12:00:00.000Z",
  source: "fusion",
  solarWind: { speed: 512, density: 4.2, dynamicPressure: 1.8 },
  magneticField: { x: 1, y: 2, z: -6.5, bt: 7 },
  indices: { kp: 4.3, dst: -30 },
  quality: { outlier: false, stale: false, interpolated: false, extrapolated: false, lowConfidence: false, tier: 0 },
};

const legacy = {
  timestamp: "2026-10-10T12:00:00.000Z",
  solarWind: { speed: 450, density: 6, pressure: 2.1 },
  imf: { bz: -3, bt: 5 },
  particles: { protonFlux: 10, electronFlux: 1000 },
  indices: { kp: 3, dst: -10 },
  flags: { stale: false, source: "live", lastUpdate: "2026-10-10T12:00:00.000Z" },
};

describe("spaceWeatherPolling", () => {
  it("polls every minute in the cloud, every 3 min over satellite, never when air-gapped", () => {
    assert.deepEqual(spaceWeatherPolling("CLOUD"), { intervalMs: 60_000, maxBackoffMs: 300_000 });
    assert.deepEqual(spaceWeatherPolling("SAT"), { intervalMs: 180_000, maxBackoffMs: 900_000 });
    assert.equal(spaceWeatherPolling("AIRGAP"), null);
  });
});

describe("parseSpaceWeatherReading", () => {
  const at = new Date("2026-10-10T12:00:30.000Z");

  it("reads the canonical point the backend serves and stamps when it arrived", () => {
    const reading = parseSpaceWeatherReading(canonical, at);
    assert.equal(reading.data.solarWind.speed, 512);
    assert.equal(reading.data.imfBz, -6.5);
    assert.equal(reading.data.source, "fusion");
    assert.equal(reading.receivedAt, at);
  });

  it("still accepts the legacy edge-function shape", () => {
    const reading = parseSpaceWeatherReading(legacy, at);
    assert.equal(reading.data.solarWind.speed, 450);
    assert.equal(reading.data.imfBz, -3);
  });

  it("throws on anything else, so the poller counts it as a failure", () => {
    assert.throws(() => parseSpaceWeatherReading({ error: "upstream down" }), /Invalid response format/);
    assert.throws(() => parseSpaceWeatherReading(null), /Invalid response format/);
    assert.throws(() => parseSpaceWeatherReading({ ...canonical, timestamp: "nope" }), /Invalid response format/);
  });
});

describe("liveDataLost", () => {
  it("keeps the last reading for two failures and shows no data from the third", () => {
    assert.equal(MARK_UNAVAILABLE_AFTER, 3);
    assert.equal(liveDataLost(0), false);
    assert.equal(liveDataLost(2), false);
    assert.equal(liveDataLost(3), true);
    assert.equal(liveDataLost(7), true);
  });
});
