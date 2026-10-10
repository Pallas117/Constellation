import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasStoppingPowerTable,
  massStoppingPowerSi,
  meanStoppingPowerSi,
  stoppingPowerRange,
} from './stopping-power.ts';

function assertClose(actual: number | null, expected: number, relTol: number, msg?: string) {
  assert.ok(actual !== null, `${msg ?? 'value'} is null`);
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(rel <= relTol, `${msg ?? ''} ${actual} vs ${expected} (rel ${rel.toExponential(2)} > ${relTol})`);
}

describe('massStoppingPowerSi (NIST PSTAR/ESTAR, silicon)', () => {
  it('10 MeV proton: S ≈ 34.6 MeV·cm²/g (PSTAR electronic 34.58)', () => {
    assert.equal(massStoppingPowerSi('proton', 10), 34.58);
    assertClose(massStoppingPowerSi('proton', 10), 34.6, 1e-3);
  });

  it('1 MeV electron: ESTAR collision S = 1.507 MeV·cm²/g', () => {
    assert.equal(massStoppingPowerSi('electron', 1), 1.507);
  });

  it('log-log interpolation reproduces NIST rows that are not in the table to < 0.5 %', () => {
    // [particle, E (MeV), NIST value at that E]; none of these energies is a table row
    const offGrid = [
      ['proton', 1.25, 152.3],
      ['proton', 3.5, 75.5],
      ['proton', 12.5, 29.12],
      ['electron', 1.25, 1.5],
      ['electron', 3.5, 1.575],
      ['electron', 12.5, 1.721],
    ] as const;
    for (const [particle, energy, nist] of offGrid) {
      assertClose(massStoppingPowerSi(particle, energy), nist, 5e-3, `${particle} ${energy} MeV`);
    }
  });

  it('does not extrapolate outside the table', () => {
    assert.deepEqual(stoppingPowerRange('proton'), { min: 0.01, max: 1e4 });
    assert.deepEqual(stoppingPowerRange('electron'), { min: 0.01, max: 1e3 });
    assert.equal(massStoppingPowerSi('proton', 0.005), null);
    assert.equal(massStoppingPowerSi('proton', 2e4), null);
    assert.equal(massStoppingPowerSi('electron', 2e3), null);
    assert.equal(massStoppingPowerSi('electron', Number.NaN), null);
    assert.equal(massStoppingPowerSi('electron', 1e3), 2.099);
  });

  it('only protons and electrons have tables', () => {
    assert.equal(hasStoppingPowerTable('proton'), true);
    assert.equal(hasStoppingPowerTable('electron'), true);
    assert.equal(hasStoppingPowerTable('alpha'), false);
    assert.equal(hasStoppingPowerTable('heavy_ion'), false);
  });
});

describe('meanStoppingPowerSi', () => {
  it('10–15 MeV protons: matches Simpson on the NIST values at 10, 12.5 and 15 MeV', () => {
    // (34.58 + 4 × 29.12 + 25.28) / 6 = 29.39
    assertClose(meanStoppingPowerSi('proton', { min: 10, max: 15 }), 29.39, 2e-3);
  });

  it('a narrow bin gives the point value', () => {
    assertClose(meanStoppingPowerSi('proton', { min: 9.999, max: 10.001 }), 34.58, 1e-4);
  });

  it('integrates exactly across many table segments', () => {
    // Trapezoid on a fine log grid of the same interpolant, 1–100 MeV protons
    const n = 20000;
    let integral = 0;
    let prevE = 1;
    let prevS = massStoppingPowerSi('proton', prevE)!;
    for (let i = 1; i <= n; i++) {
      const e = 100 ** (i / n);
      const s = massStoppingPowerSi('proton', e)!;
      integral += ((prevS + s) / 2) * (e - prevE);
      prevE = e;
      prevS = s;
    }
    assertClose(meanStoppingPowerSi('proton', { min: 1, max: 100 }), integral / 99, 1e-5);
  });

  it('returns null for empty, inverted or out-of-table bins', () => {
    assert.equal(meanStoppingPowerSi('proton', { min: 10, max: 10 }), null);
    assert.equal(meanStoppingPowerSi('proton', { min: 15, max: 10 }), null);
    assert.equal(meanStoppingPowerSi('proton', { min: 0, max: 2 }), null);
    assert.equal(meanStoppingPowerSi('electron', { min: 500, max: 2000 }), null);
  });
});
