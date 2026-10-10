import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDecay,
  calculateVisualizationParams,
  canonicalToInterpolated,
  DATA_EXPIRY_MS,
  EMAInterpolator,
  unavailableData,
} from "./dataProcessing.ts";

const canonical = {
  timestamp: "2026-10-10T12:00:00.000Z",
  source: "fusion",
  solarWind: { speed: 512, density: 4.2, dynamicPressure: 1.8 },
  magneticField: { x: 1, y: 2, z: -6.5, bt: 7 },
  indices: { kp: 4.3, dst: -30 },
  quality: { outlier: false, stale: false, interpolated: false, extrapolated: false, lowConfidence: false, tier: 0 },
};

test("maps the backend canonical point the feed actually serves", () => {
  const d = canonicalToInterpolated(canonical);
  assert.ok(d);
  assert.equal(d.solarWind.speed, 512);
  assert.equal(d.solarWind.pressure, 1.8);
  assert.equal(d.imfBz, -6.5);
  assert.equal(d.kpIndex, 4.3);
  assert.equal(d.tier, 0);
  assert.equal(d.isStale, false);
  assert.equal(d.protonFlux, null, "no particle source: flux stays unknown");
  assert.equal(d.electronFlux, null);
});

test("carries backend staleness through, and rejects malformed points", () => {
  const stale = canonicalToInterpolated({ ...canonical, quality: { ...canonical.quality, stale: true, tier: 3 } });
  assert.equal(stale?.isStale, true);
  assert.equal(canonicalToInterpolated({ ...canonical, solarWind: { speed: "fast" } }), null);
  assert.equal(canonicalToInterpolated({ ...canonical, timestamp: "nope" }), null);
  assert.equal(canonicalToInterpolated(null), null);
});

test("unavailable placeholder is deterministic and never claims to be live", () => {
  const a = unavailableData();
  const b = unavailableData();
  assert.equal(a.source, "unavailable");
  assert.equal(a.tier, 3);
  assert.equal(a.isStale, true);
  assert.equal(a.protonFlux, null);
  assert.deepEqual(a.solarWind, b.solarWind);
  assert.equal(a.imfBz, b.imfBz);
});

test("data expires at 15 min without drifting values toward a baseline", () => {
  const d = canonicalToInterpolated(canonical)!;
  assert.equal(applyDecay(d, DATA_EXPIRY_MS), d);
  const expired = applyDecay(d, DATA_EXPIRY_MS + 1);
  assert.equal(expired.isStale, true);
  assert.equal(expired.tier, 3);
  assert.equal(expired.solarWind.speed, 512);
  assert.equal(expired.imfBz, -6.5);
});

test("unknown flux is handled by interpolation and visuals without NaN", () => {
  const interp = new EMAInterpolator(unavailableData(), 1);
  interp.setTarget(canonicalToInterpolated(canonical)!);
  const out = interp.getInterpolated();
  assert.equal(out.protonFlux, null);
  const params = calculateVisualizationParams(out);
  for (const v of Object.values(params)) assert.ok(Number.isFinite(v));
});
