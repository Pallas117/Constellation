import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bzStatus, feedState, hudTone, kpStatus, scaleStatus, speedStatus } from './readout-status';

test('speed: normal below 450, elevated from 450, high from 600 km/s', () => {
  assert.deepEqual(speedStatus(420), { tone: 'nominal', word: 'Normal' });
  assert.equal(speedStatus(450).tone, 'caution');
  assert.equal(speedStatus(599.9).tone, 'caution');
  assert.deepEqual(speedStatus(600), { tone: 'risk', word: 'High' });
});

test('Bz: southward is caution from −5 nT and risk from −10 nT', () => {
  assert.equal(bzStatus(2).word, 'Northward');
  assert.equal(bzStatus(-1).word, 'Weakly south');
  assert.equal(bzStatus(-1).tone, 'nominal');
  assert.deepEqual(bzStatus(-5), { tone: 'caution', word: 'Southward' });
  assert.deepEqual(bzStatus(-12), { tone: 'risk', word: 'Strongly south' });
});

test('Kp: NOAA G-scale names storms only at whole-number thresholds', () => {
  assert.deepEqual(kpStatus(3.67), { tone: 'nominal', word: 'Quiet' });
  assert.deepEqual(kpStatus(4), { tone: 'caution', word: 'Active' });
  assert.deepEqual(kpStatus(4.67), { tone: 'caution', word: 'Active' });
  assert.deepEqual(kpStatus(5), { tone: 'caution', word: 'G1 storm' });
  assert.deepEqual(kpStatus(6.33), { tone: 'caution', word: 'G2 storm' });
  assert.deepEqual(kpStatus(7), { tone: 'risk', word: 'G3 storm' });
  assert.deepEqual(kpStatus(9), { tone: 'risk', word: 'G5 storm' });
});

test('feed: unavailable wins, then simulated, then stale', () => {
  assert.equal(feedState({ source: 'unavailable', isStale: true, tier: 3 }), 'unavailable');
  assert.equal(feedState({ source: 'model', isStale: false, tier: 2 }), 'simulated');
  assert.equal(feedState({ source: 'noaa', isStale: true, tier: 3 }), 'stale');
  assert.equal(feedState({ source: 'noaa', isStale: false, tier: 0 }), 'live');
});

test('NOAA scale levels: unknown is said, S0/G0 is none, level 3+ is risk (GAU-135)', () => {
  const reading = (level: 0 | 1 | 2 | 3 | 4 | 5 | null, label: string) => ({ level, label, basis: 'test', observedAt: null });
  assert.deepEqual(scaleStatus(undefined), { tone: 'caution', word: 'Unknown' });
  assert.deepEqual(scaleStatus(reading(null, 'S?')), { tone: 'caution', word: 'Unknown' });
  assert.deepEqual(scaleStatus(reading(0, 'S0')), { tone: 'nominal', word: 'None' });
  assert.deepEqual(scaleStatus(reading(2, 'S2')), { tone: 'caution', word: 'S2 storm' });
  assert.deepEqual(scaleStatus(reading(4, 'G4')), { tone: 'risk', word: 'G4 storm' });
  assert.equal(hudTone('nominal'), 'default');
  assert.equal(hudTone('risk'), 'risk');
});
