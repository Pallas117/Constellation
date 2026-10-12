import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ArrivingSolarWind, CanonicalSpaceWeatherPoint } from '../types/space-weather.ts';
import { beltVisuals, G4_DRIVERS, liveDrivers, standoffIfReference } from './live-drivers.ts';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const arriving = (arrivedMinutesAgo: number): ArrivingSolarWind => ({
  observedAt: iso(arrivedMinutesAgo + 50),
  arrivedAt: iso(arrivedMinutesAgo),
  travelSeconds: 3000,
  spacecraft: 'SOLAR1',
  samples: 5,
  bz: -3.7,
  by: -2,
  density: 0.8,
  speed: 500,
  dynamicPressure: 0.33,
});

/** Issued just now (5 s tick); measured `minutesOld` ago at L1. */
const reading = (minutesOld: number, extra: Partial<CanonicalSpaceWeatherPoint> = {}) =>
  ({
    timestamp: iso(0),
    observedAt: iso(minutesOld),
    magneticField: { x: 1, y: -3, z: 0.4, bt: 6 },
    solarWind: { speed: 480, density: 0.75, dynamicPressure: 0.29 },
    indices: { kp: 1.67, kpKind: 'estimated-1m' },
    propagation: { l1DelaySeconds: 3100, etaEarthArrival: iso(minutesOld - 52) },
    quality: { stale: false, tier: 0 },
    ...extra,
  }) as unknown as CanonicalSpaceWeatherPoint;

describe('liveDrivers', () => {
  it('drives the scene with the solar wind arriving at Earth, and keeps the L1 reading as what is next', () => {
    const live = liveDrivers(reading(2, { arriving: arriving(1) }), NOW);
    assert.equal(live.mode, 'live');
    assert.equal(live.propagated, true);
    assert.deepEqual(live.drivers, { bz: -3.7, by: -2, pdyn: 0.33, kp: 1.67 });
    assert.equal(live.l1?.bz, 0.4, 'northward at L1 now, southward arriving at Earth');
    assert.equal(live.arriving?.travelMin, 50);
    assert.deepEqual(live.kp, { value: 1.67, kind: 'estimated-1m' });
  });

  it('falls back to the latest L1 reading when nothing is propagated yet', () => {
    const live = liveDrivers(reading(2), NOW);
    assert.equal(live.mode, 'live');
    assert.equal(live.propagated, false);
    assert.deepEqual(live.drivers, { bz: 0.4, by: -3, pdyn: 0.29, kp: 1.67 });
  });

  it('judges age by when L1 measured, not when the point was issued', () => {
    const live = liveDrivers(reading(12), NOW);
    assert.equal(live.mode, 'stale');
    assert.equal(live.ageMin, 12);
  });

  it('keeps showing measured solar wind in transit when the L1 feed is late', () => {
    const live = liveDrivers(reading(25, { arriving: arriving(3), quality: { stale: true, tier: 3 } as never }), NOW);
    assert.equal(live.mode, 'transit');
    assert.equal(live.drivers?.bz, -3.7);
    assert.equal(live.l1, null, 'a 25 min old L1 reading is not shown as current');
  });

  it('fails closed with no recent measurement and nothing arriving', () => {
    for (const point of [reading(16), reading(2, { quality: { stale: true, tier: 3 } as never }), reading(2, { arriving: arriving(20), quality: { stale: true, tier: 3 } as never })]) {
      const live = liveDrivers(point, NOW);
      assert.equal(live.mode, 'none');
      assert.equal(live.drivers, undefined);
    }
    assert.equal(liveDrivers(null, NOW).mode, 'none');
  });

  it('fails closed on an unparseable measurement time', () => {
    assert.equal(liveDrivers(reading(0, { observedAt: 'nope' }), NOW).mode, 'none');
  });

  it('uses the issue time for points from a backend without observedAt', () => {
    const legacy = { ...reading(0), observedAt: undefined, timestamp: iso(3) } as CanonicalSpaceWeatherPoint;
    assert.equal(liveDrivers(legacy, NOW).ageMin, 3);
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

describe('standoffIfReference', () => {
  it('moves the magnetopause by Pdyn^(-1/6.6) for the other spacecraft density', () => {
    const r = standoffIfReference(12.6, { spacecraft: 'SOLAR1', density: 0.75, reference: 'IMAP', referenceDensity: 3, ratio: 0.25, minutes: 30 });
    assert.ok(Math.abs(r - 12.6 * Math.pow(4, -1 / 6.6)) < 1e-12);
    assert.ok(r > 10 && r < 10.5);
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
