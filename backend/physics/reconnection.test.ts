import assert from "node:assert/strict";
import test from "node:test";
import { vec, type Vector3 } from "./coordinates.js";
import { computeMMSReconnectionVector, type MMSSpacecraftSample } from "./reconnection.js";

const RE_KM = 6371.2;
const MU0 = 4e-7 * Math.PI;
const ids = ["mms1", "mms2", "mms3", "mms4"] as const;

// Uniform current J along z gives B = (mu0 J / 2) * (-y, x, 0).
function samplesFor(jzNaPerM2: number, edgeKm: number, flatten = 1): MMSSpacecraftSample[] {
  const kNtPerKm = (MU0 * jzNaPerM2 * 1e-9 * 0.5) * 1e3 * 1e9; // T/m -> nT/km
  const centreKm = vec(-7.4 * RE_KM, 1.6 * RE_KM, -6.9 * RE_KM);
  const a = edgeKm / Math.SQRT2;
  const offsets: Vector3[] = [vec(a, a, a * flatten), vec(a, -a, -a * flatten), vec(-a, a, -a * flatten), vec(-a, -a, a * flatten)];
  return ids.map((id, i) => {
    const r = offsets[i];
    const p = vec(centreKm.x + r.x, centreKm.y + r.y, centreKm.z + r.z);
    return {
      id,
      timestamp: "2026-08-16T23:59:59Z",
      positionGsmRe: vec(p.x / RE_KM, p.y / RE_KM, p.z / RE_KM),
      magneticFieldNt: vec(-kNtPerKm * r.y, kNtPerKm * r.x, -20),
    };
  });
}

test("curlometer recovers a known current at real MMS separations (nA/m^2)", () => {
  for (const edgeKm of [10, 80, 300]) {
    const out = computeMMSReconnectionVector(samplesFor(25, edgeKm));
    assert.ok(out);
    assert.equal(out.quality.valid, true, `edge ${edgeKm} km should be valid`);
    assert.ok(Math.abs(out.currentDensity.z - 25) < 0.05, `edge ${edgeKm}: jz=${out.currentDensity.z}`);
    assert.ok(Math.abs(out.currentDensity.x) < 0.05 && Math.abs(out.currentDensity.y) < 0.05);
  }
});

test("curlometer rejects a near-planar tetrahedron", () => {
  const out = computeMMSReconnectionVector(samplesFor(25, 80, 0.001));
  assert.ok(out);
  assert.equal(out.quality.valid, false);
});

// Harris-like current sheet with normal n: B = B0 tanh((r.n)/lambda) l + Bn n, sampled by a tetrahedron.
function sheetSamples(n: Vector3, l: Vector3, edgeKm = 40, bnNt = 2): MMSSpacecraftSample[] {
  const centreKm = vec(-7.4 * RE_KM, 1.6 * RE_KM, -6.9 * RE_KM);
  const a = edgeKm / Math.SQRT2;
  const offsets: Vector3[] = [vec(a, a, a), vec(a, -a, -a), vec(-a, a, -a), vec(-a, -a, a)];
  const lambdaKm = 400;
  return ids.map((id, i) => {
    const r = offsets[i];
    const s = (r.x * n.x + r.y * n.y + r.z * n.z) / lambdaKm;
    const bl = 20 * Math.tanh(s);
    const p = vec(centreKm.x + r.x, centreKm.y + r.y, centreKm.z + r.z);
    return {
      id,
      timestamp: "2026-08-16T23:59:59Z",
      positionGsmRe: vec(p.x / RE_KM, p.y / RE_KM, p.z / RE_KM),
      magneticFieldNt: vec(bl * l.x + bnNt * n.x + 5 * l.x, bl * l.y + bnNt * n.y + 5 * l.y, bl * l.z + bnNt * n.z + 5 * l.z),
    };
  });
}

const unit = (x: number, y: number, z: number) => {
  const m = Math.hypot(x, y, z);
  return vec(x / m, y / m, z / m);
};

test("MDD recovers the current-sheet normal and L along the reconnecting field (GAU-89)", () => {
  const cases = [
    { n: unit(0, 0, 1), l: unit(1, 0, 0) },
    { n: unit(1, 0.3, 0.2), l: unit(-0.3, 1, 0) }, // tilted sheet
  ];
  for (const { n, l } of cases) {
    // make l exactly perpendicular to n
    const d = l.x * n.x + l.y * n.y + l.z * n.z;
    const lp = unit(l.x - d * n.x, l.y - d * n.y, l.z - d * n.z);
    const out = computeMMSReconnectionVector(sheetSamples(n, lp));
    assert.ok(out);
    const nDot = Math.abs(out.lmn.n.x * n.x + out.lmn.n.y * n.y + out.lmn.n.z * n.z);
    const lDot = out.lmn.l.x * lp.x + out.lmn.l.y * lp.y + out.lmn.l.z * lp.z;
    assert.ok(nDot > 0.999, `normal off by ${Math.acos(Math.min(1, nDot)) * 57.3} deg`);
    assert.ok(lDot > 0.99, `L should follow the field, got cos=${lDot}`);
    const m = out.lmn.m;
    const handed = m.x * (out.lmn.n.y * out.lmn.l.z - out.lmn.n.z * out.lmn.l.y)
      + m.y * (out.lmn.n.z * out.lmn.l.x - out.lmn.n.x * out.lmn.l.z)
      + m.z * (out.lmn.n.x * out.lmn.l.y - out.lmn.n.y * out.lmn.l.x);
    assert.ok(handed > 0.999, "M = N x L");
    assert.deepEqual(out.normal, out.lmn.n);
  }
});

test("MDD reports an unknown frame when no direction dominates (GAU-89)", () => {
  // A uniform current along z varies equally in x and y: not a 1-D boundary.
  const out = computeMMSReconnectionVector(samplesFor(25, 80));
  assert.ok(out);
  assert.deepEqual(out.lmn.n, vec(0, 0, 0));
  assert.deepEqual(out.lmn.l, vec(0, 0, 0));
  assert.equal(out.quality.valid, true, "the current estimate itself stays valid");
});
