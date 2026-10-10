import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ParticleType, RadiationMeasurement } from '@/lib/types/radiation';
import {
  getAlertLevel,
  getAlertLevelFromMeasurements,
  noaaSolarRadiationStormLevel,
} from './radiation.ts';

function bin(particleType: ParticleType, min: number, max: number, flux: number): RadiationMeasurement {
  return {
    timestamp: '2026-10-10T00:00:00Z',
    particleFlux: flux,
    altitude: 35786,
    L_shell: 6.6,
    particleType,
    energyRange: { min, max },
    orbitType: 'GEO',
    source: 'unknown',
  };
}

describe('noaaSolarRadiationStormLevel (NOAA S-scale, ≥10 MeV protons, pfu)', () => {
  it('switches at 10, 10², 10³, 10⁴ and 10⁵ pfu', () => {
    const cases: Array<[number, number]> = [
      [0, 0], [9.99, 0], [10, 1], [99.9, 1], [100, 2], [999, 2],
      [1e3, 3], [9999, 3], [1e4, 4], [99999, 4], [1e5, 5], [1e7, 5],
    ];
    for (const [pfu, s] of cases) assert.equal(noaaSolarRadiationStormLevel(pfu), s, `${pfu} pfu`);
  });
});

describe('getAlertLevel (integral flux, pfu)', () => {
  it('protons follow the S-scale: S1–S2 moderate, S3 high, S4–S5 severe', () => {
    const cases: Array<[number, string]> = [
      [9.99, 'low'], [10, 'moderate'], [999, 'moderate'], [1e3, 'high'],
      [9999, 'high'], [1e4, 'severe'], [1e5, 'severe'],
    ];
    for (const [pfu, level] of cases) assert.equal(getAlertLevel(pfu, 'proton'), level, `${pfu} pfu`);
  });

  it('>2 MeV electrons alert at the SWPC 1000 pfu internal-charging threshold', () => {
    assert.equal(getAlertLevel(999.9, 'electron'), 'low');
    assert.equal(getAlertLevel(1000, 'electron'), 'high');
    assert.equal(getAlertLevel(1e6, 'electron'), 'high');
  });

  it('has no level without a cited threshold or a valid flux', () => {
    assert.equal(getAlertLevel(1e6, 'alpha'), null);
    assert.equal(getAlertLevel(1e6, 'heavy_ion'), null);
    assert.equal(getAlertLevel(Number.NaN, 'proton'), null);
    assert.equal(getAlertLevel(-1, 'electron'), null);
  });
});

describe('getAlertLevelFromMeasurements (differential bins)', () => {
  it('integrates j over the part of the bin above the channel energy', () => {
    // 10 × (20 − 10) = 100 pfu → S2
    assert.equal(getAlertLevelFromMeasurements([bin('proton', 10, 20, 10)]), 'moderate');
    // 300 × (15 − 10) = 1500 pfu → S3; the 5–10 MeV half does not count
    assert.equal(getAlertLevelFromMeasurements([bin('proton', 5, 15, 300)]), 'high');
    // 600 × (3 − 2) = 600 pfu < 1000
    assert.equal(getAlertLevelFromMeasurements([bin('electron', 1, 3, 600)]), 'low');
    // 600 × (4 − 2) = 1200 pfu ≥ 1000
    assert.equal(getAlertLevelFromMeasurements([bin('electron', 2, 4, 600)]), 'high');
  });

  it('ignores bins below the channel and species without a threshold', () => {
    assert.equal(getAlertLevelFromMeasurements([bin('proton', 1, 5, 1e6)]), null);
    assert.equal(getAlertLevelFromMeasurements([bin('electron', 0.5, 2, 1e6)]), null);
    assert.equal(getAlertLevelFromMeasurements([bin('alpha', 10, 100, 1e6)]), null);
    assert.equal(getAlertLevelFromMeasurements([]), null);
  });

  it('reports the most severe species', () => {
    const level = getAlertLevelFromMeasurements([
      bin('proton', 10, 20, 2), // 20 pfu → S1 → moderate
      bin('electron', 2, 4, 600), // 1200 pfu → high
    ]);
    assert.equal(level, 'high');
  });

  it('uses the largest bin, not the sum, so it never overstates', () => {
    // Two 60 pfu bins: 60 (S1), not 120 (S2)
    assert.equal(noaaSolarRadiationStormLevel(60), 1);
    const level = getAlertLevelFromMeasurements([bin('proton', 10, 20, 6), bin('proton', 20, 30, 6)]);
    assert.equal(level, 'moderate');
  });

  it('skips non-finite fluxes', () => {
    const level = getAlertLevelFromMeasurements([bin('proton', 10, 20, Number.NaN), bin('proton', 10, 20, 200)]);
    assert.equal(level, 'high');
  });
});
