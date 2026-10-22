import assert from "node:assert/strict";
import test from "node:test";
import {
  flareClass,
  geomagneticStorm,
  KP_MAX_AGE_MS,
  radiationStorm,
  radioBlackout,
  S_SCALE_CHANNEL,
  XRAY_BAND,
} from "./noaa-scales.js";
import type { CanonicalSpaceWeatherPoint, ParticleReading, XrayReading } from "../types.js";

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

const xray = (value: number, band = XRAY_BAND): XrayReading => ({
  value,
  band,
  flareClass: flareClass(value),
  satellite: "GOES-18",
  timestamp: "2026-10-19T08:44:00Z",
});

test("R-scale levels start at M1, M5, X1, X10 and X20 (GOES 0.1-0.8 nm, W/m²)", () => {
  const cases: Array<[number, number]> = [
    [5.66e-7, 0], // B5.6, the quiet Sun on 2026-10-19
    [9.99e-6, 0],
    [1e-5, 1],
    [4.9e-5, 1],
    [5e-5, 2],
    [1e-4, 3],
    [9.9e-4, 3],
    [1e-3, 4],
    [2e-3, 5],
  ];
  for (const [wm2, level] of cases) {
    assert.equal(radioBlackout(xray(wm2)).level, level, `${wm2} W/m²`);
  }
  assert.match(radioBlackout(xray(5.66e-7)).basis, /GOES 0\.1-0\.8nm X-rays 5\.7e-7 W\/m² \(B5\.6\)/);
});

test("flare class truncates, so a flux just under a boundary keeps its class", () => {
  assert.equal(flareClass(5.66e-7), "B5.6");
  assert.equal(flareClass(3e-6), "C3.0", "float division error doesn't drop a tenth");
  assert.equal(flareClass(9.99e-6), "C9.9");
  assert.equal(flareClass(1e-5), "M1.0");
  assert.equal(flareClass(2.3e-3), "X23");
  assert.equal(flareClass(4e-9), "A0.4");
  assert.equal(flareClass(-1), "?");
});

test("a missing, wrong-band or fill X-ray reading is unknown, not R0", () => {
  assert.equal(radioBlackout(null).label, "R?");
  assert.equal(radioBlackout(xray(1e-4, "0.05-0.4nm")).level, null);
  assert.equal(radioBlackout(xray(0)).level, null);
  assert.equal(radioBlackout(xray(Number.NaN)).level, null);
});
