import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualityOf, summariseLinks, type DeviceWithSample } from './link-map';

const NOW = Date.parse('2026-11-18T03:00:00Z');
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const dev = (name: string, minAgo: number, s: Partial<NonNullable<DeviceWithSample['last']>['linkSample']> & { network?: string }): DeviceWithSample => ({
  name,
  last: { receivedAt: at(minAgo), linkSample: { class: 'wifi', bearer: 'https', lossPct: 0, rttMs: 80, low: false, ...s } },
});

test('one row per network, with mean loss, median RTT and the best signal', () => {
  const rows = summariseLinks(
    [
      dev('a', 1, { network: 'aaaaaaaaaaaa', lossPct: 2, rttMs: 100, signalDbm: -60, noiseDbm: -92 }),
      dev('b', 2, { network: 'aaaaaaaaaaaa', lossPct: 4, rttMs: 300, signalDbm: -70, noiseDbm: -90, class: 'usb' }),
      dev('c', 3, { network: 'bbbbbbbbbbbb', place: 'Hostel roof', lossPct: 30, rttMs: 2000, low: true }),
      { name: 'd' }, // never reported
    ],
    NOW,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { key: 'n:bbbbbbbbbbbb', label: 'Hostel roof', devices: 1, classes: ['wifi'], lossPct: 30, rttMs: 2000, signalDbm: null, snrDb: null, lowDevices: 1, quality: 'poor' }, 'worst first');
  assert.deepEqual(rows[1], { key: 'n:aaaaaaaaaaaa', label: 'network aaaaaa', devices: 2, classes: ['usb', 'wifi'], lossPct: 3, rttMs: 300, signalDbm: -60, snrDb: 32, lowDevices: 0, quality: 'good' });
});

test('stale samples are left out and places group networks without a hash', () => {
  const rows = summariseLinks([dev('a', 90, { network: 'aaaaaaaaaaaa' }), dev('b', 5, { place: 'Cafe' }), dev('c', 6, { place: 'Cafe' })], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Cafe');
  assert.equal(rows[0].devices, 2);
});

test('quality thresholds: loss, RTT and low-signal mode', () => {
  assert.equal(qualityOf(1, 100, 0), 'good');
  assert.equal(qualityOf(8, 100, 0), 'fair');
  assert.equal(qualityOf(1, null, 0), 'fair', 'no RTT is never called good');
  assert.equal(qualityOf(16, 100, 0), 'poor');
  assert.equal(qualityOf(0, 100, 1), 'poor');
  assert.equal(qualityOf(0, 1600, 0), 'poor');
});
