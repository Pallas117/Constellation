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
