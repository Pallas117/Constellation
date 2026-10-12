import assert from "node:assert/strict";
import test from "node:test";
import { buildAuroraGrid, latLonGridHarmonics, sphericalHarmonics } from "./healpix.js";
import type { CanonicalSpaceWeatherPoint } from "../types.js";

const point = {
  indices: { kp: 5 },
  magneticField: { z: -8 },
  coupling: { newell: 6000 },
  electricField: { ey: 2.5 },
} as unknown as CanonicalSpaceWeatherPoint;

test("separable harmonics match the generic per-pixel sum", () => {
  // nside 8 keeps the generic reference fast enough for a unit test.
  const { grid } = buildAuroraGrid(point, 8);
  const fast = latLonGridHarmonics(grid, 24, 32, 8);
  const reference = sphericalHarmonics(grid, 8);
  assert.equal(fast.coefficients.length, reference.coefficients.length);
  const scale = Math.max(...reference.coefficients.map((c) => Math.abs(c.re)));
  fast.coefficients.forEach((c, i) => {
    const ref = reference.coefficients[i];
    assert.equal(c.l, ref.l);
    assert.equal(c.m, ref.m);
    assert.ok(Math.abs(c.re - ref.re) <= 1e-9 * scale, `l=${c.l} m=${c.m}: ${c.re} vs ${ref.re}`);
  });
  fast.powerSpectrum.forEach((p, i) => {
    assert.ok(Math.abs(p.cL - reference.powerSpectrum[i].cL) <= 1e-9 * scale * scale);
  });
});

test("aurora grid at nside 64 builds within its 1 s pipeline budget", () => {
  buildAuroraGrid(point, 64); // warm up
  const start = performance.now();
  const { grid, harmonics } = buildAuroraGrid(point, 64);
  const ms = performance.now() - start;
  assert.equal(grid.length, 12 * 64 * 64);
  assert.equal(harmonics.coefficients.length, 81);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)}ms`);
});
