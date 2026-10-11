import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DriverAverager, damp, shouldRetrace } from './driver-smoothing.ts';

const d = (bz: number, pdyn = 2, kp = 2, by = 0) => ({ bz, by, pdyn, kp });
const MIN = 60_000;

describe('DriverAverager', () => {
  it('returns null before any sample and the value itself after one', () => {
    const a = new DriverAverager();
    assert.equal(a.mean(0), null);
    a.push(0, d(-4));
    assert.deepEqual(a.mean(0), d(-4));
  });

  it('weights each value by how long it was in effect', () => {
    const a = new DriverAverager(5 * MIN);
    a.push(0, d(0));
    a.push(4 * MIN, d(-10)); // 0 nT for 4 min, then -10 nT for 1 min
    const m = a.mean(5 * MIN)!;
    assert.ok(Math.abs(m.bz - -2) < 1e-9, `bz ${m.bz}`);
  });

  it('only averages the trailing window', () => {
    const a = new DriverAverager(5 * MIN);
    a.push(0, d(20));
    a.push(10 * MIN, d(-5));
    // From 10 min on, only -5 nT is in the window.
    assert.equal(a.mean(16 * MIN)!.bz, -5);
  });

  it('counts a value that started before the window for the part inside it', () => {
    const a = new DriverAverager(5 * MIN);
    a.push(0, d(10)); // in effect until 8 min
    a.push(8 * MIN, d(0));
    // Window [5, 10] min: 10 nT for 3 min, 0 nT for 2 min -> 6 nT
    assert.ok(Math.abs(a.mean(10 * MIN)!.bz - 6) < 1e-9);
  });

  it('ignores non-finite samples and lets same-instant updates replace', () => {
    const a = new DriverAverager();
    a.push(0, d(Number.NaN));
    assert.equal(a.mean(0), null);
    a.push(0, d(1));
    a.push(0, d(3));
    assert.equal(a.mean(0)!.bz, 3);
  });
});

describe('shouldRetrace', () => {
  it('always traces the first time', () => {
    assert.equal(shouldRetrace(null, d(0)), true);
  });

  it('ignores small changes and reacts to meaningful ones', () => {
    assert.equal(shouldRetrace(d(-3), d(-3.5)), false);
    assert.equal(shouldRetrace(d(-3), d(-4)), true);
    assert.equal(shouldRetrace(d(0, 2), d(0, 2.1)), false); // 5% of Pdyn
    assert.equal(shouldRetrace(d(0, 2), d(0, 2.3)), true); // 15%
    assert.equal(shouldRetrace(d(0, 2, 3), d(0, 2, 3.4)), false);
    assert.equal(shouldRetrace(d(0, 2, 3), d(0, 2, 3.5)), true);
  });
});

describe('stability under noisy live data', () => {
  it('retraces a handful of times where naive quantisation retraces constantly', () => {
    // 30 min of 5 s samples: Bz -3 nT with ±1.5 nT noise, Pdyn 2 ± 0.2 nPa.
    let seed = 42;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
    const samples = Array.from({ length: (30 * 60) / 5 }, (_, i) => ({
      t: i * 5000,
      v: d(-3 + 1.5 * rand(), 2 + 0.2 * rand()),
    }));

    // Old behaviour: retrace whenever the 0.5 nT / 0.25 nPa quantised values change.
    const q = (v: number, s: number) => Math.round(v / s) * s;
    let naive = 0;
    let last = '';
    for (const { v } of samples) {
      const key = `${q(v.bz, 0.5)}|${q(v.pdyn, 0.25)}`;
      if (key !== last) naive++;
      last = key;
    }

    // New behaviour: 5-min mean + hysteresis.
    const a = new DriverAverager();
    let traced: ReturnType<DriverAverager['mean']> = null;
    let stable = 0;
    for (const { t, v } of samples) {
      a.push(t, v);
      const m = a.mean(t)!;
      if (shouldRetrace(traced, m)) {
        traced = m;
        stable++;
      }
    }
    assert.ok(naive > 150, `naive retraces ${naive}`);
    assert.ok(stable <= 4, `stable retraces ${stable}`);
  });
});

describe('damp', () => {
  it('approaches the target independent of frame rate', () => {
    let a = 0;
    for (let i = 0; i < 60; i++) a = damp(a, 10, 1 / 60, 0.5); // 1 s at 60 fps
    let b = 0;
    for (let i = 0; i < 30; i++) b = damp(b, 10, 1 / 30, 0.5); // 1 s at 30 fps
    assert.ok(Math.abs(a - b) < 1e-9);
    assert.ok(Math.abs(a - 10 * (1 - Math.exp(-2))) < 1e-9);
  });

  it('snaps when tau is 0 (reduced motion)', () => {
    assert.equal(damp(0, 7, 0.016, 0), 7);
  });
});
