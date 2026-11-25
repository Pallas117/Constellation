import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildStops, inSaa, replayDrivers, replayScales, sampleIndexAt, standoff, stopIndexAt, type WalkthroughData } from './storm-walkthrough.ts';

const data = JSON.parse(readFileSync(new URL('../../data/walkthrough/may-2024.json', import.meta.url), 'utf8')) as WalkthroughData;

test('walkthrough: the stops are found in the May 2024 data, in time order (GAU-229)', () => {
  const stops = buildStops(data);
  assert.deepEqual(stops.map((s) => s.id), ['quiet', 'shock', 'squeeze', 'saa', 'peak', 'pilot']);
  const start = Date.parse(data.start);
  const end = Date.parse(data.end);
  for (const s of stops) assert.ok(s.atMs >= start && s.atMs <= end, s.id);
  assert.ok(stops[1].atMs < stops[2].atMs && stops[2].atMs < stops[4].atMs);
});

test('walkthrough: the shock stop quotes the measured jump, not typed numbers', () => {
  const shock = buildStops(data)[1];
  assert.match(shock.body, /460 to 673 km\/s/);
  assert.match(shock.body, /16:40 UT/);
  // The arrival time is Gauss's propagation, not an observed sudden commencement.
  assert.match(shock.body, /Gauss's propagation to Earth puts its arrival at about \d\d:\d\d UT/);
});

test('walkthrough: the squeeze reaches inside geostationary orbit and says the model is extrapolated', () => {
  const sq = buildStops(data)[2];
  const i = sampleIndexAt(data, sq.atMs);
  const { r0, extrapolated } = standoff(data.samples[i]);
  assert.ok(r0 < 6.6);
  assert.equal(extrapolated, true);
  assert.match(sq.body, /extrapolated/);
  // Past the dayside magnetopause is the magnetosheath (shocked solar wind), and only near noon.
  assert.match(sq.body, /dayside, near local noon, cross it into the magnetosheath/);
  assert.doesNotMatch(sq.body, /solar wind itself/);
});

test('walkthrough: the peak stop names the model Dst and ties the oval to the Kp maximum', () => {
  const pk = buildStops(data)[4];
  const s = data.samples[sampleIndexAt(data, pk.atMs)];
  assert.equal(pk.title, 'Ring-current estimate bottoms out');
  assert.match(pk.body, /a model, not the observed Dst index/);
  assert.equal(s.dst, Math.min(...data.samples.map((x) => x.dst)));
  assert.equal(s.kp, Math.max(...data.samples.map((x) => x.kp ?? -1)));
  assert.match(pk.body, /lowest latitude/);
  // Below the storm's Kp maximum, the oval claim is dropped.
  const lowered = { ...data, samples: data.samples.map((x) => (x === s ? { ...x, kp: 7 } : x)) };
  assert.doesNotMatch(buildStops(lowered)[4].body, /lowest latitude/);
});

test('walkthrough: replayed S, G and R levels come from the sample and say they are a replay', () => {
  const s = data.samples.find((x) => x.S === 'S2');
  assert.ok(s);
  const r = replayScales(s);
  assert.deepEqual([r.radiation.level, r.radiation.label], [2, 'S2']);
  assert.equal(r.geomagnetic.label, s.G);
  assert.equal(r.radioBlackout.label, s.R);
  for (const x of [r.radiation, r.geomagnetic, r.radioBlackout]) assert.match(x.basis, /^Replay \d\d:\d\d UT/);
  assert.equal(replayScales({ ...s, S: 'S?' }).radiation.level, null);
});

test('walkthrough: the SAA stop puts the teaching satellite inside the anomaly core', () => {
  const saa = buildStops(data)[3];
  assert.equal(inSaa(data, saa.atMs), 'core');
  assert.equal(saa.showSaa, true);
});

test('walkthrough: replay drivers are labelled replay and carry measured values only', () => {
  const s = data.samples[100];
  const d = replayDrivers(s);
  assert.equal(d.mode, 'replay');
  assert.equal(d.drivers?.kp, s.kp);
  assert.equal(d.ageMin, null);
});

test('walkthrough: sample lookup holds the last measurement until the next', () => {
  const t0 = Date.parse(data.samples[10].t);
  assert.equal(sampleIndexAt(data, t0 + 4 * 60_000), 10);
  assert.equal(sampleIndexAt(data, t0 - 1), 9);
  assert.equal(stopIndexAt(buildStops(data), Date.parse(data.start)), 0);
});

test('walkthrough: a storm without a shock throws instead of borrowing the May story', () => {
  const calm = { ...data, samples: data.samples.map((s) => ({ ...s, l1: { ...s.l1, speed: 400 } })) };
  assert.throws(() => buildStops(calm), /no solar wind shock/);
});
