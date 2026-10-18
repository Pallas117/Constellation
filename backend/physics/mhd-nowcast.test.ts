import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { vec } from "./coordinates.js";
import { computeCanonicalPoint, DST_MODEL_METHOD, estimateDst, type MhdInput } from "./mhd-nowcast.js";

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
  const first = computeCanonicalPoint(input("2026-10-10T04:50:00Z", -3.9), [], null);
  let point = first.point;
  for (let i = 1; i <= 5; i += 1) {
    const ts = new Date(Date.parse("2026-10-10T04:50:00Z") + i * 5000).toISOString();
    point = computeCanonicalPoint(input(ts, -3.9), [], point.indices.dst, point.timestamp).point;
  }
  // Only the slow GSE->GSM rotation over 25 s may move it; the old projection moved it by nT.
  assert.ok(Math.abs(point.magneticField.z - first.point.magneticField.z) < 0.01);
  assert.ok(point.magneticField.z < 0, "southward IMF stays southward");
});

test("modelled Dst is labelled with its method and inputs; a measured Dst says so (GAU-84)", async () => {
  const input: MhdInput = {
    timestamp: "2026-10-12T00:00:00Z",
    source: "fusion",
    density: 6,
    velocityGse: vec(-450, 0, 0),
    magneticFieldGse: vec(1, 2, -8),
    kp: 3,
  };
  const modelled = computeCanonicalPoint(input, [], null).point.indices;
  assert.equal(modelled.dstMethod, DST_MODEL_METHOD);
  assert.deepEqual(modelled.dstDerivedFrom, ["solarWind.speed", "magneticField.z", "solarWind.dynamicPressure"]);

  const measured = computeCanonicalPoint({ ...input, dst: -35 }, [], null).point.indices;
  assert.equal(measured.dst, -35);
  assert.equal(measured.dstMethod, "measured");
  assert.deepEqual(measured.dstDerivedFrom, []);

  // The provenance survives the protobuf feed.
  const { encodeCanonicalPoint, decodeCanonicalPoint } = await import("../lib/proto.js");
  const point = computeCanonicalPoint(input, [], null).point;
  const decoded = await decodeCanonicalPoint(await encodeCanonicalPoint(point));
  assert.equal(decoded.indices.dstMethod, DST_MODEL_METHOD);
  assert.deepEqual([...decoded.indices.dstDerivedFrom], modelled.dstDerivedFrom);
});

// GAU-133: when the native kernel is built it must agree with the TypeScript formulas.
// It used to compute in float32 and diverged after about 7 significant digits.
type NativeMhd = {
  dynamicPressureNpa(densityCm3: number, speedKmS: number): number;
  newellCoupling(speedKmS: number, btNt: number, byNt: number, bzNt: number): number;
};
let nativeKernel: NativeMhd | null = null;
try {
  nativeKernel = createRequire(import.meta.url)("../../build/Release/mhd_native.node") as NativeMhd;
} catch {
  nativeKernel = null;
}

test(
  "GAU-133: native MHD kernel matches the TypeScript formulas to double precision",
  { skip: nativeKernel ? false : "native kernel not built" },
  () => {
    const kernel = nativeKernel;
    assert.ok(kernel);
    const close = (a: number, b: number) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b));
    for (const [n, v] of [[5, 450], [7.6, 408], [0.3, 812.4], [42.1, 301.7]]) {
      const expected = 1.6726e-6 * n * v * v;
      assert.ok(close(kernel.dynamicPressureNpa(n, v), expected), `dynamic pressure n=${n} v=${v}`);
    }
    for (const [v, bt, by, bz] of [[450, 6.2, -3.0, -5.4], [612.3, 11.7, 4.1, -10.9], [380, 2.1, 1.2, 1.7]]) {
      const theta = Math.atan2(by, bz);
      const expected = Math.pow(v, 4 / 3) * Math.pow(bt, 2 / 3) * Math.pow(Math.max(Math.sin(theta / 2), 0), 8 / 3);
      assert.ok(close(kernel.newellCoupling(v, bt, by, bz), expected), `Newell coupling v=${v} bt=${bt}`);
    }
  },
);
