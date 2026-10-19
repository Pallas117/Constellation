import assert from "node:assert/strict";
import test from "node:test";
import { geomagneticStorm, KP_MAX_AGE_MS, radiationStorm, S_SCALE_CHANNEL } from "./noaa-scales.js";
import type { CanonicalSpaceWeatherPoint, ParticleReading } from "../types.js";

const NOW = Date.parse("2026-01-19T20:00:00Z");

const protons = (value: number, energy = S_SCALE_CHANNEL): ParticleReading => ({
  value,
  energy,
  satellite: "GOES-19",
  timestamp: "2026-01-19T19:55:00Z",
});

const indices = (kp: number, observedAt: string | null = "2026-01-19T19:59:00Z", kpKind: "estimated-1m" | "planetary-3h" | undefined = "estimated-1m") =>
  ({ kp, dst: -100, kpKind, kpObservedAt: observedAt }) as CanonicalSpaceWeatherPoint["indices"];

test("S-scale levels start at each NOAA boundary (10, 100, 1000, 10^4, 10^5 pfu)", () => {
  const cases: Array<[number, number]> = [
    [0.4, 0],
    [9.99, 0],
    [10, 1],
    [99, 1],
    [100, 2],
    [1_000, 3],
    [10_000, 4],
    [99_999, 4],
    [100_000, 5],
    [3e6, 5],
  ];
  for (const [pfu, level] of cases) {
    const reading = radiationStorm(protons(pfu));
    assert.equal(reading.level, level, `${pfu} pfu`);
    assert.equal(reading.label, `S${level}`);
  }
});

test("a missing, stale or wrong-channel proton reading is unknown, not S0", () => {
  assert.equal(radiationStorm(null).level, null);
  assert.equal(radiationStorm(null).label, "S?");
  assert.equal(radiationStorm(protons(500, ">=50 MeV")).level, null);
  assert.equal(radiationStorm(protons(Number.NaN)).level, null);
  assert.equal(radiationStorm(protons(-1e5)).level, null); // GOES fill value
});

test("G-scale: G1 at Kp 5 … G5 at Kp 9, with fractional Kp floored like the frontend", () => {
  const cases: Array<[number, number]> = [
    [2, 0],
    [4.67, 0], // "5−" is not yet G1
    [5, 1],
    [6.33, 2],
    [7, 3],
    [8.67, 4], // "9−" is G4
    [9, 5],
  ];
  for (const [kp, level] of cases) {
    assert.equal(geomagneticStorm(indices(kp), NOW).level, level, `Kp ${kp}`);
  }
});

test("Kp without a NOAA reading, or older than 6 h, is unknown, not G0", () => {
  // Points with no measurement carry a placeholder Kp and no kpKind.
  const placeholder = { kp: 2, dst: -10 } as CanonicalSpaceWeatherPoint["indices"];
  assert.equal(geomagneticStorm(placeholder, NOW).level, null);
  assert.equal(geomagneticStorm(indices(2, null), NOW).level, null);
  const old = new Date(NOW - KP_MAX_AGE_MS - 60_000).toISOString();
  assert.equal(geomagneticStorm(indices(7, old, "planetary-3h"), NOW).label, "G?");
});

test("the streams are independent: a radiation storm under a quiet geomagnetic field reads S4 / G0, not quiet", () => {
  const radiation = radiationStorm(protons(25_000));
  const geomagnetic = geomagneticStorm(indices(4.33), NOW);
  assert.equal(radiation.label, "S4");
  assert.equal(geomagnetic.label, "G0");
  assert.match(radiation.basis, /GOES >=10 MeV protons 25,000 pfu/);
});
