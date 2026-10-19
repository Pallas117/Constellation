import assert from "node:assert/strict";
import test from "node:test";
import {
  applyDecay,
  calculateVisualizationParams,
  canonicalToInterpolated,
  DATA_EXPIRY_MS,
  EMAInterpolator,
  isCanonicalPoint,
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

test("maps measured GOES particle flux, and keeps a missing channel unknown (GAU-112)", () => {
  const reading = { value: 0.25, energy: ">=10 MeV", satellite: "GOES-18", timestamp: "2026-10-10T11:55:00.000Z" };
  const d = canonicalToInterpolated({ ...canonical, particles: { protons: reading, electrons: null } });
  assert.ok(d);
  assert.equal(d.protonFlux, 0.25);
  assert.equal(d.electronFlux, null, "missing electrons stay unknown, never 0");
});

test("only a complete canonical point counts as data; legacy or partial payloads are rejected", () => {
  assert.equal(isCanonicalPoint(canonical), true);
  const { quality: _quality, ...noQuality } = canonical;
  assert.equal(isCanonicalPoint(noQuality), false, "no quality block: the landing would crash reading it");
  const legacy = {
    timestamp: canonical.timestamp,
    solarWind: { speed: 425, density: 5.5, pressure: 2.4 },
    imf: { bz: -6.2, bt: 7.4 },
    indices: { kp: 4, dst: -40 },
    flags: { stale: false, source: "live" },
  };
  assert.equal(isCanonicalPoint(legacy), false);
  assert.equal(isCanonicalPoint(null), false);
  assert.equal(isCanonicalPoint({ ...canonical, indices: {} }), false);
});
