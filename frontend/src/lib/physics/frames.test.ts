import assert from 'node:assert/strict';
import test from 'node:test';
import { geoToGsm as backendGeoToGsm } from '../../../../backend/physics/coordinates.ts';
import { vec } from '../../../../backend/physics/coordinates.ts';
import { circularOrbitGei, geoToGsm, insideOutline, latLonToUnit, orbitPeriodMs, subSatellitePoint } from './frames.ts';

const angleDeg = (a: number[], b: number[]) =>
  (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;

test('frames: geo to GSM agrees with the backend Hapgood transform to within 1 degree (GAU-229)', () => {
  for (const iso of ['2024-05-10T12:00:00Z', '2024-05-11T01:07:00Z', '2026-01-19T18:00:00Z', '2025-07-01T00:00:00Z']) {
    for (const [lat, lon] of [[0, 0], [45, 90], [-23, -59], [80, -70]]) {
      const u = latLonToUnit(lat, lon);
      const b = backendGeoToGsm(vec(...u), iso);
      const f = geoToGsm(u, Date.parse(iso));
      assert.ok(angleDeg([b.x, b.y, b.z], f) < 1, `${iso} ${lat},${lon}`);
    }
  }
});

test('frames: a circular orbit keeps its altitude, inclination and period (GAU-229)', () => {
  const o = { altKm: 400, inclinationDeg: 51.6, raanDeg: 30, epochMs: 0 };
  const period = orbitPeriodMs(400);
  assert.ok(period > 5400e3 && period < 5600e3, 'about 92 minutes');
  let maxLat = 0;
  for (let t = 0; t < period; t += 30_000) {
    const [x, y, z] = circularOrbitGei(o, t);
    assert.ok(Math.abs(Math.hypot(x, y, z) - 1) < 1e-9);
    maxLat = Math.max(maxLat, Math.abs(subSatellitePoint(o, t).lat));
  }
  assert.ok(Math.abs(maxLat - 51.6) < 0.2);
});

test('frames: insideOutline uses the even-odd rule', () => {
  const sq: [number, number][] = [[0, 0], [0, 10], [10, 10], [10, 0]];
  assert.equal(insideOutline(5, 5, sq), true);
  assert.equal(insideOutline(15, 5, sq), false);
});
