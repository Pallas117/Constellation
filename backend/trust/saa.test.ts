import assert from "node:assert/strict";
import test from "node:test";
import { coefficientsAt, decimalYear, igrfAt, synthesize } from "../physics/igrf.js";
import { propagateTle } from "./orbit.js";
import { SAA_CORE_NT, SAA_EXTENDED_NT, saaContext } from "./saa.js";

// |B| (nT) from an independent Python IGRF-14 implementation (direct Schmidt recursion, written
// separately on 2026-10-21) from the same official coefficient file; ours uses Gauss-normalised
// recursion with Schmidt factors. [decimal year, geocentric lat, lon, altitude km, |B|]
const REFERENCE: Array<[number, number, number, number, number]> = [
  [2025, -26, -60, 0, 22094.471],
  [2025, 51.5, -0.1, 0, 48978.04],
  [2025, 0, 0, 420, 25295.628],
  [2025, -30, -45, 420, 19501.59],
  [2025, 60, 100, 550, 47065.98],
  [2025, -75, 140, 800, 43137.227],
  [2025, 10, -170, 400, 27110.55],
  [2026.8, -26, -60, 0, 22035.292],
  [2026.8, 51.5, -0.1, 0, 49036.144],
  [2026.8, 0, 0, 420, 25254.95],
  [2026.8, -30, -45, 420, 19465.614],
  [2026.8, 60, 100, 550, 47127.516],
  [2026.8, -75, 140, 800, 43088.587],
  [2026.8, 10, -170, 400, 27081.76],
];

test("IGRF-14: agrees with an independent implementation to 0.001 nT, surface to 800 km (GAU-141)", () => {
  for (const [year, lat, lon, alt, ref] of REFERENCE) {
    const f = synthesize(coefficientsAt(year)!, lat, lon, 6371.2 + alt).total;
    assert.ok(Math.abs(f - ref) < 1e-3, `${year} ${lat},${lon} ${alt} km: ${f} vs ${ref}`);
  }
});

test("IGRF-14: a pure dipole matches its closed form; the official check value; validity 2015–2030 (GAU-141)", () => {
  const c = coefficientsAt(2025)!;
  assert.equal(c.g[1][0], -29350.0, "g(1,0) at 2025.0, the published check value");
  const dipole = { g: c.g.map((r) => r.map(() => 0)), h: c.h.map((r) => r.map(() => 0)) };
  dipole.g[1][0] = -30_000;
  const ar = 6371.2 / 7000;
  const colat = (60 * Math.PI) / 180;
  assert.ok(Math.abs(synthesize(dipole, 30, 10, 7000).total - 30_000 * ar ** 3 * Math.sqrt(1 + 3 * Math.cos(colat) ** 2)) < 1e-9);
  assert.equal(igrfAt(Date.parse("2014-12-31T00:00:00Z"), 0, 0, 6800), null);
  assert.equal(igrfAt(Date.parse("2030-06-01T00:00:00Z"), 0, 0, 6800), null);
  assert.ok(Math.abs(decimalYear(Date.parse("2026-07-02T12:00:00Z")) - 2026.5) < 0.001);
  // The weakest surface field in 2025 is the SAA, about 22,000 nT over South America.
  let weakest = { f: Infinity, lat: 0, lon: 0 };
  for (let lat = -60; lat <= 0; lat += 1) {
    for (let lon = -100; lon <= 20; lon += 1) {
      const f = synthesize(c, lat, lon, 6371.2).total;
      if (f < weakest.f) weakest = { f, lat, lon };
    }
  }
  assert.deepEqual([Math.round(weakest.f), weakest.lat, weakest.lon], [22094, -26, -60]);
});

// NICER's own SAA polygon on the ISS (NASA HEASARC CALDB nixtisaareg20170601v003.fits, SAACONT;
// valid from 2017-06-01), (longitude, latitude) degrees.
const NICER: Array<[number, number]> = [
  [-67.68, -2.36], [-86.4, -10.28], [-84.49, -31.85], [-72.35, -43.99], [-54.56, -52.58], [-28.19, -53.63], [0.21, -46.89],
  [15.51, -42.67], [28.8, -34.04], [12.96, -21.08], [-9.36, -21.08], [-23.76, -16.04], [-43.2, 0.52],
];
const insideNicer = (lon: number, lat: number) => {
  let c = false;
  for (let i = 0, j = NICER.length - 1; i < NICER.length; j = i++) {
    const [xi, yi] = NICER[i];
    const [xj, yj] = NICER[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const ISS: [string, string] = [
  "1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992",
  "2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442",
];

test("SAA: along six days of an ISS orbit, NICER's SAA lies inside the extended tier and the core inside NICER's (GAU-141)", () => {
  const epoch = Date.parse("2019-06-05T12:12:58Z");
  const samples: Array<{ nicer: boolean; tier: string | null }> = [];
  for (let t = epoch - 3 * 86_400_000; t <= epoch + 3 * 86_400_000; t += 30_000) {
    const p = propagateTle(ISS, t);
    assert.ok(!("error" in p));
    samples.push({ nicer: insideNicer(p.ephemeris.lonDeg, p.ephemeris.latDeg), tier: saaContext(t, p.ephemeris).tier });
  }
  const flagged = (s: { tier: string | null }) => s.tier === "core" || s.tier === "extended";
  assert.ok(samples.every((s) => s.tier !== null), "the ISS stays in the 300–450 km band");
  assert.equal(samples.filter((s) => s.nicer && !flagged(s)).length, 0, "every NICER-SAA sample is in the extended SAA");
  assert.equal(samples.filter((s) => s.tier === "core" && !s.nicer).length, 0, "every core sample is inside NICER's SAA");
  // Every NICER SAA pass coincides with a Gauss SAA pass.
  const runs = (pick: (s: (typeof samples)[number]) => boolean) => {
    const out: Array<[number, number]> = [];
    let start = -1;
    samples.forEach((s, i) => {
      if (pick(s) && start < 0) start = i;
      if (!pick(s) && start >= 0) {
        out.push([start, i - 1]);
        start = -1;
      }
    });
    if (start >= 0) out.push([start, samples.length - 1]);
    return out;
  };
  const nicerPasses = runs((s) => s.nicer);
  const gaussPasses = runs(flagged);
  assert.ok(nicerPasses.length >= 60, `${nicerPasses.length} NICER passes in six days`);
  assert.ok(nicerPasses.every(([a, b]) => gaussPasses.some(([c, d]) => c <= b && d >= a)));
});

test("SAA: the thresholds and the altitude band are applied as published (GAU-141)", () => {
  const t = Date.parse("2026-01-19T12:00:00Z");
  const core = saaContext(t, { latDeg: -30, lonDeg: -45, altKm: 420 });
  assert.equal(core.tier, "core");
  assert.ok(core.fieldNt! <= SAA_CORE_NT);
  const quiet = saaContext(t, { latDeg: 45, lonDeg: 10, altKm: 420 });
  assert.equal(quiet.tier, "outside");
  assert.ok(quiet.fieldNt! > SAA_EXTENDED_NT);
  const high = saaContext(t, { latDeg: -30, lonDeg: -45, altKm: 550 });
  assert.equal(high.tier, null);
  assert.match(high.reason!, /not applied at 550 km/);
  assert.ok(high.fieldNt! > 0, "|B| is still known above the band");
});
