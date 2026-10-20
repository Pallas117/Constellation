import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { archiveL1Samples } from "../replay/archive.js";
import { loadArchive } from "../replay/replay.js";
import { detectL1Structures, type L1Sample } from "./l1-structures.js";

const T0 = Date.parse("2026-01-01T00:00:00Z");
const minute = (i: number) => new Date(T0 + i * 60_000).toISOString();
/** `minutes` of steady slow wind, with `at(i)` overriding fields minute by minute. */
const series = (minutes: number, at: (i: number) => Partial<L1Sample> = () => ({})): L1Sample[] =>
  Array.from({ length: minutes }, (_, i) => ({ time: minute(i), speedKmS: 400, densityCm3: 5, btNt: 5, bzGsmNt: 0, ...at(i) }));

test("l1 structures: a clean fast-forward shock is found at the jump, with its arrival at Earth", () => {
  const r = detectL1Structures(series(120, (i) => (i >= 60 ? { speedKmS: 500, densityCm3: 10, btNt: 12 } : {})));
  assert.equal(r.shocks.length, 1);
  const [shock] = r.shocks;
  assert.equal(shock.time, minute(60));
  assert.deepEqual([shock.deltaSpeedKmS, shock.densityRatio, shock.fieldRatio], [100, 2, 2.4]);
  assert.equal(shock.confidence, "high");
  // Mass flux: Vsh = (10·500 − 5·400)/(10 − 5) = 600 km/s; 1.5e6 km at 600 km/s is 2500 s.
  assert.equal(shock.shockSpeedKmS, 600);
  assert.equal(shock.earthArrival, new Date(Date.parse(minute(60)) + 2_500_000).toISOString());
});

test("l1 structures: quiet, noisy wind and jumps below the thresholds give no candidates", () => {
  const quiet = detectL1Structures(
    series(600, (i) => ({
      speedKmS: 400 + 10 * Math.sin(i / 7),
      densityCm3: 5 + 0.5 * Math.sin(i / 3),
      btNt: 5 + 0.5 * Math.cos(i / 5),
      bzGsmNt: 2 * Math.sin(i / 11),
    })),
  );
  assert.deepEqual([quiet.shocks, quiet.sustainedSouthward, quiet.magnetopauseInsideGeo], [[], [], []]);
  // ΔV 30 km/s is under the 40 km/s threshold, however large the compression.
  const weak = detectL1Structures(series(120, (i) => (i >= 60 ? { speedKmS: 430, densityCm3: 10, btNt: 12 } : {})));
  assert.deepEqual(weak.shocks, []);
});

test("l1 structures: Ey above 5 mV/m for 3 h or more is sustained driving; 2 h is not", () => {
  // Bz -12 nT at 500 km/s: Ey = 6 mV/m.
  const south = (from: number, to: number) => (i: number) => (i >= from && i < to ? { speedKmS: 500, bzGsmNt: -12 } : {});
  const four = detectL1Structures(series(480, south(60, 300)));
  assert.equal(four.sustainedSouthward.length, 1);
  const [interval] = four.sustainedSouthward;
  assert.ok(Math.abs(interval.hours - 4) <= 0.2, `${interval.hours} h`);
  assert.deepEqual([interval.maxEyMvM, interval.minBzNt, interval.confidence], [6, -12, "medium"]);
  assert.deepEqual(detectL1Structures(series(480, south(60, 180))).sustainedSouthward, []);
});

test("l1 structures: a 20-minute gap is bridged; missing plasma lowers the confidence", () => {
  const driving = (i: number) => (i >= 60 && i < 300 ? { speedKmS: 500, bzGsmNt: -12 } : {});
  const gap = detectL1Structures(
    series(480, (i) => (i >= 150 && i < 170 ? { speedKmS: null, densityCm3: null, btNt: null, bzGsmNt: null } : driving(i))),
  );
  assert.equal(gap.sustainedSouthward.length, 1);
  // Two of the four hours without plasma: the last speed is carried, but the result is low confidence.
  const thin = detectL1Structures(series(480, (i) => (i >= 120 && i < 240 ? { ...driving(i), speedKmS: null } : driving(i))));
  assert.equal(thin.sustainedSouthward.length, 1);
  assert.equal(thin.sustainedSouthward[0].confidence, "low");
});

test("l1 structures: high pressure and southward Bz put the Shue (1998) magnetopause inside GEO", () => {
  // n 30 cm^-3 at 700 km/s is 24.6 nPa; with Bz -20 nT, Shue gives about 5.5 Re.
  const r = detectL1Structures(series(180, (i) => (i >= 60 && i < 120 ? { speedKmS: 700, densityCm3: 30, bzGsmNt: -20, btNt: 25 } : {})));
  assert.equal(r.magnetopauseInsideGeo.length, 1);
  const [mp] = r.magnetopauseInsideGeo;
  assert.ok(mp.minStandoffRe > 5.4 && mp.minStandoffRe < 5.6, `${mp.minStandoffRe} Re`);
  assert.equal(mp.confidence, "high");
});

// Validation on the GAU-138 replay archives (SWPC RTSW as archived by NASA CCMC iSWA).
// Published times: the Richardson & Cane ICME list, https://izw1.caltech.edu/ACE/ASC/DATA/level3/icmetable2.htm
// (revised 23 July 2026, read 20 October 2026). Its "Disturbance" column is "the time of the
// associated geomagnetic storm sudden commencement (typically related to the arrival of a shock
// at Earth)", so L1 times are propagated to Earth with the nowcast's delay model first.
// Tolerance: 30 min, the study pack's golden case GC01 (it allows 45 min for October 2024).
const archive = (id: string) => archiveL1Samples(loadArchive(fileURLToPath(new URL(`../replay/events/${id}.json.gz`, import.meta.url))));
const minutesApart = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 60_000;

test("l1 structures, May 2024 replay: shock within 30 min of the published commencement, then driving and compression", () => {
  const r = detectL1Structures(archive("may-2024"));
  const [first] = r.shocks;
  assert.ok(first, "no shock found");
  assert.ok(minutesApart(first.earthArrival, "2024-05-10T17:05:00Z") <= 30, `arrival ${first.earthArrival}`);
  assert.notEqual(first.confidence, "low");
  // Nothing before it: the six-hour lead-in is quiet wind.
  assert.ok(first.time >= "2024-05-10T16:00:00Z", `first candidate ${first.time}`);
  assert.ok(r.sustainedSouthward.some((s) => s.minBzNt < -40), "no sustained driving with Bz below -40 nT");
  // Study pack GC03: magnetopause inside GEO, minimum under 5.5 Re (about 5 Re in the literature).
  assert.ok(Math.min(...r.magnetopauseInsideGeo.map((m) => m.minStandoffRe)) < 5.5);
});

test("l1 structures, October 2024 replay: shock within 30 min of the published commencement, then a long southward interval", () => {
  const r = detectL1Structures(archive("oct-2024"));
  const [first] = r.shocks;
  assert.ok(first, "no shock found");
  assert.ok(minutesApart(first.earthArrival, "2024-10-10T15:14:00Z") <= 30, `arrival ${first.earthArrival}`);
  assert.notEqual(first.confidence, "low");
  // Study pack GC06: sustained southward driving over 6 h, Bz below -40 nT.
  assert.ok(r.sustainedSouthward.some((s) => s.hours > 6 && s.minBzNt < -40));
});

test("l1 structures, January 2026 replay: no shock is invented when the plasma speed doesn't move (GAU-153)", () => {
  const samples = archive("jan-2026");
  // Published commencement 2026-01-19 19:17 UT (ΔV 670 km/s). In the archive, ACE's speed stays
  // within ~10 km/s (90% of minutes, 282–293) from 18:20 to 21:10 UT while |B| goes from about 9 to 55 nT: the plasma
  // reading doesn't follow the shock. The detector needs the speed jump, so it reports nothing.
  const window = samples.filter((s) => s.time >= "2026-01-19T18:20" && s.time < "2026-01-19T21:10");
  const speeds = window.map((s) => s.speedKmS).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const pct = (q: number) => speeds[Math.floor(q * (speeds.length - 1))];
  assert.ok(pct(0.95) - pct(0.05) < 15, `speed moved (${pct(0.05)}-${pct(0.95)} km/s); revisit this test`);
  assert.ok(Math.max(...window.map((s) => s.btNt ?? 0)) > 50);
  assert.deepEqual(detectL1Structures(samples).shocks, []);
});
