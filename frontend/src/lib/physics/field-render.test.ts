import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeMagnetosphere } from './geomagnetic.ts';
import { buildFieldRender, fieldScalars, tracedModel, transferables } from './field-render.ts';

const EPOCH = Date.UTC(2026, 9, 11, 12);
const storm = { bz: -15, by: 4, pdyn: 8, kp: 7 };

describe('buildFieldRender', () => {
  const state = computeMagnetosphere(storm, EPOCH);
  const r = buildFieldRender(state);

  it('packs every line with consistent sizes', () => {
    const vertices = state.lines.reduce((s, l) => s + l.points.length, 0);
    const segments = state.lines.reduce((s, l) => s + l.points.length - 1, 0);
    assert.equal(r.segments.length, segments * 6);
    assert.equal(r.colors.length, segments * 6);
    assert.equal(r.pathPoints.length, vertices * 3);
    assert.equal(r.pathCum.length, vertices);
    assert.equal(r.pathStart.length, state.lines.length + 1);
    assert.equal(r.pathStart[state.lines.length], vertices);
    assert.equal(r.pathOpen.reduce((s, x) => s + x, 0), state.lines.filter((l) => l.topology === 'open').length);
  });

  it('produces finite positions, colours in [0,1] and monotonic arc length', () => {
    assert.ok(r.segments.every(Number.isFinite));
    assert.ok(r.colors.every((c) => c >= 0 && c <= 1));
    for (let li = 0; li < state.lines.length; li++) {
      assert.equal(r.pathCum[r.pathStart[li]], 0);
      for (let i = r.pathStart[li] + 1; i < r.pathStart[li + 1]; i++) assert.ok(r.pathCum[i] >= r.pathCum[i - 1]);
    }
  });

  it('uses scene coordinates (x, z, -y)', () => {
    const p = state.lines[0].points[0];
    assert.deepEqual(Array.from(r.pathPoints.slice(0, 3)).map((v) => +v.toFixed(5)), [p[0], p[2], -p[1]].map((v) => +v.toFixed(5)));
  });

  it('lists six distinct transferable buffers', () => {
    const bufs = transferables(r);
    assert.equal(bufs.length, 6);
    assert.equal(new Set(bufs).size, 6);
  });
});

describe('fieldScalars', () => {
  it('matches the traced model without tracing', () => {
    const s = fieldScalars(storm, EPOCH);
    const m = tracedModel(computeMagnetosphere(storm, EPOCH));
    assert.ok(Math.abs(s.r0 - m.r0) < 1e-12);
    assert.ok(Math.abs(s.bowShock - m.bowShock) < 1e-12);
    assert.ok(Math.abs(s.tilt - m.tilt) < 1e-12);
    assert.deepEqual(s.oval, m.oval);
  });
});
