import assert from "node:assert/strict";
import test from "node:test";
import { vec } from "./coordinates.js";
import { computeCanonicalPoint, estimateDst, type MhdInput } from "./mhd-nowcast.js";

const input = (timestamp: string, bz: number): MhdInput => ({
  timestamp,
  source: "fusion",
  density: 7.6,
  velocityGse: vec(-408, 0, 0),
  magneticFieldGse: vec(-6.7, -3.0, bz),
  kp: 2.33,
});

test("Dst: quiet northward IMF stays near the pressure baseline, not a storm", () => {
  const dst = estimateDst(400, 3, 2, null, null);
  assert.ok(dst > -15 && dst < 10, `quiet Dst ${dst}`);
});

test("Dst: weak southward IMF gives a modest equilibrium, never the -400 clamp", () => {
  const dst = estimateDst(408, -3, 2.1, null, null);
  assert.ok(dst < -20 && dst > -60, `weak-driving Dst ${dst}`);
});

test("Dst: strong driving deepens over hours and relaxes back after", () => {
  let dst = estimateDst(700, 3, 4, null, null);
  for (let h = 0; h < 6; h += 1) dst = estimateDst(700, -20, 4, dst, 1);
  assert.ok(dst < -150, `storm main phase Dst ${dst}`);
  const peak = dst;
  for (let h = 0; h < 24; h += 1) dst = estimateDst(450, 2, 2, dst, 1);
  assert.ok(dst > peak + 100, `recovery Dst ${dst}`);
});

test("nowcast: constant input keeps Bz's sign and value across ticks (no component-mean shift)", () => {
  const first = computeCanonicalPoint(input("2026-10-10T04:50:00Z", -3.9), null, [], null);
  let state = first.state;
  let point = first.point;
  for (let i = 1; i <= 5; i += 1) {
    const ts = new Date(Date.parse("2026-10-10T04:50:00Z") + i * 5000).toISOString();
    const next = computeCanonicalPoint(input(ts, -3.9), state, [], point.indices.dst, point.timestamp);
    state = next.state;
    point = next.point;
  }
  // Only the slow GSE->GSM rotation over 25 s may move it; the old projection moved it by nT.
  assert.ok(Math.abs(point.magneticField.z - first.point.magneticField.z) < 0.01);
  assert.ok(point.magneticField.z < 0, "southward IMF stays southward");
});
