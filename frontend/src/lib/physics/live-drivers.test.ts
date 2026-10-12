import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalSpaceWeatherPoint } from '../types/space-weather.ts';
import { beltVisuals, G4_DRIVERS, liveDrivers } from './live-drivers.ts';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const reading = (minutesOld: number, stale = false) =>
  ({
    timestamp: new Date(NOW - minutesOld * 60_000).toISOString(),
    magneticField: { x: 1, y: -3, z: -7, bt: 8 },
    solarWind: { speed: 520, density: 6, dynamicPressure: 2.7 },
    indices: { kp: 4.3 },
    quality: { stale },
  }) as unknown as CanonicalSpaceWeatherPoint;

describe('liveDrivers', () => {
  it('maps a fresh reading to GSM drivers and plasma', () => {
    const live = liveDrivers(reading(2), NOW);
    assert.equal(live.mode, 'live');
    assert.equal(live.ageMin, 2);
    assert.deepEqual(live.drivers, { bz: -7, by: -3, pdyn: 2.7, kp: 4.3 });
    assert.deepEqual(live.plasma, { speed: 520, density: 6 });
  });

  it('marks old or flagged readings stale but still shows them', () => {
    assert.equal(liveDrivers(reading(16), NOW).mode, 'stale');
    assert.equal(liveDrivers(reading(1, true), NOW).mode, 'stale');
    assert.ok(liveDrivers(reading(16), NOW).drivers);
  });

  it('fails closed without a reading', () => {
    assert.deepEqual(liveDrivers(null, NOW), { mode: 'none', ageMin: null, drivers: undefined, plasma: null });
  });

  it('treats an unparseable timestamp as stale with unknown age', () => {
    const bad = { ...reading(0), timestamp: 'nope' } as CanonicalSpaceWeatherPoint;
    const live = liveDrivers(bad, NOW);
    assert.equal(live.mode, 'stale');
    assert.equal(live.ageMin, null);
  });

  it('clamps a reading stamped in the future to zero age', () => {
    assert.equal(liveDrivers(reading(-1), NOW).ageMin, 0);
  });

  it('simulates G4 regardless of the feed', () => {
    const sim = liveDrivers(null, NOW, true);
    assert.equal(sim.mode, 'simulated');
    assert.equal(sim.drivers, G4_DRIVERS);
  });
});

describe('beltVisuals', () => {
  it('uses reference values without drivers', () => {
    const v = beltVisuals(undefined);
    assert.ok(Math.abs(v.magnetopauseCompression - 0.92) < 1e-12);
    assert.ok(Math.abs(v.beltIntensity - (2 / 9 + 0.2)) < 1e-12);
    assert.equal(v.reconnectionStrength, 0);
  });

  it('saturates under a severe storm', () => {
    const v = beltVisuals(G4_DRIVERS);
    assert.equal(v.magnetopauseCompression, 0.6);
    assert.equal(v.reconnectionStrength, 1);
  });
});
