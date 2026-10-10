import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RadiationDataPoint, RadiationMeasurement } from '@/lib/types/radiation';
import {
  GRAY_PER_MEV_PER_GRAM,
  absorbedDoseRate,
  calculateDoseRate,
  getDoseRateFromMeasurement,
  unidirectionalToOmnidirectional,
} from './radiation-calculations.ts';

function assertClose(actual: number | undefined, expected: number, relTol: number, msg?: string) {
  assert.ok(actual !== undefined, `${msg ?? 'value'} is undefined`);
  const rel = Math.abs(actual - expected) / Math.abs(expected);
  assert.ok(rel <= relTol, `${msg ?? ''} ${actual} vs ${expected} (rel ${rel.toExponential(2)} > ${relTol})`);
}

describe('dose-rate building blocks', () => {
  it('1 MeV/g = 1.602e-10 Gy', () => {
    // 1 MeV = 1.602176634e-13 J; per gram = per 1e-3 kg
    assert.equal(GRAY_PER_MEV_PER_GRAM, 1.602176634e-13 / 1e-3);
  });

  it('1 pfu isotropic is 4π cm⁻²·s⁻¹ omnidirectional', () => {
    assertClose(unidirectionalToOmnidirectional(1), 12.566, 1e-4);
    assert.equal(unidirectionalToOmnidirectional(1), 4 * Math.PI);
  });

  it('Ḋ = 1.602e-10 × Φ × S: 1e4 cm⁻²·s⁻¹ of 10 MeV p in Si is 5.54e-5 Gy/s', () => {
    // 1.602e-10 × 1e4 × 34.6 = 5.543e-5
    assertClose(absorbedDoseRate(1e4, 34.6), 5.543e-5, 1e-3);
  });
});

describe('calculateDoseRate (thin Si, isotropic)', () => {
  it('narrow 10 MeV proton bin: S ≈ 34.6 MeV·cm²/g', () => {
    // j = 1000 over 0.1 MeV → 100 pfu → Φ = 400π = 1256.6 cm⁻²·s⁻¹
    // Ḋ = 1.602e-10 × 1256.6 × 34.58 = 6.962e-6 Gy(Si)/s
    const dose = calculateDoseRate(1000, { min: 9.95, max: 10.05 }, 'proton');
    assert.equal(dose?.material, 'Si');
    assertClose(dose?.omnidirectionalFlux, 400 * Math.PI, 1e-12);
    assertClose(dose?.stoppingPower, 34.6, 1e-3);
    assertClose(dose?.grayPerSecond, 6.962e-6, 1e-3);
  });

  it('10–15 MeV protons use the bin-averaged stopping power', () => {
    // j = 100 over 5 MeV → 500 pfu → Φ = 2000π = 6283 cm⁻²·s⁻¹; S̄ ≈ 29.39 (Simpson on NIST)
    // Ḋ = 1.602e-10 × 6283 × 29.39 = 2.959e-5 Gy(Si)/s ≈ 0.107 Gy(Si)/h
    const dose = calculateDoseRate(100, { min: 10, max: 15 }, 'proton');
    assertClose(dose?.omnidirectionalFlux, 2000 * Math.PI, 1e-12);
    assertClose(dose?.grayPerSecond, 2.959e-5, 3e-3);
  });

  it('1–3 MeV electrons use the ESTAR collision stopping power', () => {
    // j = 1000 over 2 MeV → Φ = 8000π = 25133; S̄ ≈ (1.507 + 4 × 1.518 + 1.558) / 6 = 1.523
    // Ḋ = 1.602e-10 × 25133 × 1.523 = 6.13e-6 Gy(Si)/s
    const dose = calculateDoseRate(1000, { min: 1, max: 3 }, 'electron');
    assertClose(dose?.stoppingPower, 1.523, 5e-3);
    assertClose(dose?.grayPerSecond, 6.13e-6, 5e-3);
  });

  it('scales with stopping power, not mean energy', () => {
    // Same Φ at 10 and 100 MeV: the old flux × energy formula gave 10×; physics gives
    // S(100)/S(10) = 5.836 / 34.58 = 0.169 (PSTAR, Si)
    const at10 = calculateDoseRate(1, { min: 9.9, max: 10.1 }, 'proton')!;
    const at100 = calculateDoseRate(0.1, { min: 99, max: 101 }, 'proton')!;
    assertClose(at100.omnidirectionalFlux, at10.omnidirectionalFlux, 1e-12);
    assertClose(at100.grayPerSecond / at10.grayPerSecond, 5.836 / 34.58, 1e-3);
  });

  it('zero flux is zero dose', () => {
    assert.equal(calculateDoseRate(0, { min: 1, max: 3 }, 'electron')?.grayPerSecond, 0);
  });

  it('returns null when no dose can be computed', () => {
    assert.equal(calculateDoseRate(100, { min: 10, max: 15 }, 'alpha'), null);
    assert.equal(calculateDoseRate(100, { min: 10, max: 15 }, 'heavy_ion'), null);
    assert.equal(calculateDoseRate(100, { min: 10, max: 10 }, 'proton'), null);
    assert.equal(calculateDoseRate(100, { min: 500, max: 2000 }, 'electron'), null);
    assert.equal(calculateDoseRate(-1, { min: 10, max: 15 }, 'proton'), null);
    assert.equal(calculateDoseRate(Number.NaN, { min: 10, max: 15 }, 'proton'), null);
  });
});

describe('getDoseRateFromMeasurement', () => {
  const base = {
    timestamp: '2026-10-10T00:00:00Z',
    altitude: 35786,
    L_shell: 6.6,
    orbitType: 'GEO' as const,
    particleType: 'proton' as const,
    energyRange: { min: 10, max: 15 },
  };

  it('reads particleFlux from measurements and flux from data points', () => {
    const measurement: RadiationMeasurement = { ...base, particleFlux: 100, source: 'unknown' };
    const point: RadiationDataPoint = { ...base, flux: 100 };
    const expected = calculateDoseRate(100, base.energyRange, 'proton');
    assert.deepEqual(getDoseRateFromMeasurement(measurement), expected);
    assert.deepEqual(getDoseRateFromMeasurement(point), expected);
  });
});
