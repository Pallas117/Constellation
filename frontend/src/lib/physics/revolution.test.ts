import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fillRevolution, revolutionTopology } from './revolution.ts';
import { shueRadius } from './geomagnetic.ts';

const THETA = 72;
const PHI = 64;

/** |cos| of the angle between the analytic and the triangle-averaged normal at interior vertices. */
function agreement(radius: (th: number) => number, tail: number) {
  const g = revolutionTopology(THETA, PHI);
  fillRevolution(g, radius, tail, THETA, PHI);
  const analytic = (g.attributes.normal.array as Float32Array).slice();
  const ref = g.clone();
  ref.computeVertexNormals();
  const computed = ref.attributes.normal.array as Float32Array;
  const dots: number[] = [];
  const lengths: number[] = [];
  for (let i = 1; i < THETA; i++) {
    for (let j = 1; j < PHI; j++) {
      const k = (i * (PHI + 1) + j) * 3;
      const a = [analytic[k], analytic[k + 1], analytic[k + 2]];
      const c = [computed[k], computed[k + 1], computed[k + 2]];
      lengths.push(Math.hypot(a[0], a[1], a[2]));
      dots.push(Math.abs(a[0] * c[0] + a[1] * c[1] + a[2] * c[2]));
    }
  }
  dots.sort((x, y) => x - y);
  return { min: dots[0], median: dots[dots.length >> 1], lengths };
}

describe('fillRevolution normals', () => {
  it('match the triangle-averaged normals on the magnetopause (up to sign, which the fresnel ignores)', () => {
    const { min, median, lengths } = agreement((th) => shueRadius(th, 10.5, 0.58), 40);
    assert.ok(median > 0.9999, `median ${median}`);
    assert.ok(min > 0.995, `min ${min}`);
    assert.ok(lengths.every((l) => Math.abs(l - 1) < 1e-5), 'unit length');
  });

  it('match on the bow shock conic too', () => {
    const ecc = 0.81;
    const { min, median } = agreement((th) => (13.5 * (1 + ecc)) / (1 + ecc * Math.cos(th)), 16);
    assert.ok(median > 0.9999, `median ${median}`);
    assert.ok(min > 0.995, `min ${min}`);
  });

  it('point along the axis at the nose, not NaN', () => {
    const g = revolutionTopology(THETA, PHI);
    fillRevolution(g, () => 10, 40, THETA, PHI);
    const n = g.attributes.normal.array as Float32Array;
    assert.ok(Math.abs(Math.abs(n[0]) - 1) < 1e-6, `nose normal x ${n[0]}`);
    assert.ok(Array.from(n).every(Number.isFinite));
  });
});
