import assert from "node:assert/strict";
import test from "node:test";
import { vec, type Vector3 } from "../physics/coordinates.js";
import {
  arrivingNow,
  buildL1Series,
  checkDensity,
  dynamicPressureNpa,
  meanDrivers,
  travelSeconds,
  type L1Sample,
} from "./rtsw-series.js";

const T0 = Date.parse("2026-10-12T06:00:00Z");
const tag = (ms: number, offsetS = 0) => new Date(ms + offsetS * 1000).toISOString().slice(0, 19);
const noConvert = (v: Vector3) => v;

/** RTSW-shaped rows, newest first, one per spacecraft per minute. */
function rtsw(minutes: number, opts: { solar1Density?: number; imapDensity?: number; active?: string | null; speed?: number } = {}) {
  const wind: Record<string, unknown>[] = [];
  const mag: Record<string, unknown>[] = [];
  const active = opts.active === undefined ? "SOLAR1" : opts.active;
  for (let i = minutes - 1; i >= 0; i -= 1) {
    const t = T0 + i * 60_000;
    const speed = opts.speed ?? 500;
    wind.push(
      { time_tag: tag(t), source: "SOLAR1", active: active === "SOLAR1", proton_speed: speed, proton_density: opts.solar1Density ?? 3, proton_vx_gse: -speed, proton_vy_gse: 10, proton_vz_gse: -5, proton_vx_gsm: -speed, proton_vy_gsm: 8, proton_vz_gsm: -7 },
      { time_tag: tag(t, 3), source: "IMAP", active: active === "IMAP", proton_speed: speed + 5, proton_density: opts.imapDensity ?? 3.1 },
      { time_tag: tag(t), source: "ACE", active: active === "ACE", proton_speed: speed - 5, proton_density: 0.0 },
    );
    mag.push(
      { time_tag: tag(t, 1), source: "SOLAR1", active: active === "SOLAR1", bx_gse: 2, by_gse: -1, bz_gse: -4, bx_gsm: 2, by_gsm: -1.5, bz_gsm: -3.8 },
      { time_tag: tag(t, 2), source: "IMAP", active: active === "IMAP", bx_gse: 2.1, by_gse: -1, bz_gse: -4.1, bx_gsm: 2.1, by_gsm: -1.4, bz_gsm: -3.9 },
    );
  }
  return { wind, mag };
}

test("RTSW series: active spacecraft, one paired sample per minute, oldest first", () => {
  const { wind, mag } = rtsw(5);
  const series = buildL1Series(wind, mag);
  assert.equal(series.length, 5);
  assert.ok(series.every((s) => s.spacecraft === "SOLAR1"));
  assert.ok(series[0].t < series[4].t);
  assert.deepEqual({ ...series[0].magneticFieldGsm! }, { x: 2, y: -1.5, z: -3.8 }, "published GSM is kept");
  assert.equal(series[0].t, T0, "older of the paired wind and mag times");
});

test("RTSW series: fill densities (ACE 0.0), nulls and out-of-range speeds are rejected", () => {
  const { wind, mag } = rtsw(3, { active: "ACE" });
  const series = buildL1Series(wind, mag);
  assert.equal(series.length, 3);
  assert.ok(series.every((s) => s.spacecraft === "IMAP"), "active ACE only has fills: fall back to the newest valid spacecraft");
  const bad = [
    { time_tag: tag(T0), source: "SOLAR1", active: true, proton_speed: null, proton_density: 4 },
    { time_tag: tag(T0 + 60_000), source: "SOLAR1", active: true, proton_speed: 9999, proton_density: 4 },
  ];
  assert.equal(buildL1Series(bad, mag).length, 0);
});

test("RTSW series: with no active spacecraft, the newest complete record's spacecraft is used", () => {
  const { wind, mag } = rtsw(3, { active: null });
  const series = buildL1Series(wind, mag);
  assert.ok(series.length > 0);
  assert.ok(series.every((s) => s.spacecraft === "IMAP"), "IMAP's records are the newest (3 s later)");
});

test("density cross-check flags a 4x disagreement between L1 spacecraft and ignores ACE fills", () => {
  const { wind } = rtsw(40, { solar1Density: 0.75, imapDensity: 3 });
  const check = checkDensity(wind, "SOLAR1", T0 + 39 * 60_000);
  assert.ok(check);
  assert.equal(check.reference, "IMAP");
  assert.equal(check.ratio, 0.25);
  assert.equal(check.minutes, 30);
});

test("density cross-check passes when spacecraft agree within 2x", () => {
  const { wind } = rtsw(40, { solar1Density: 3, imapDensity: 4 });
  assert.equal(checkDensity(wind, "SOLAR1", T0 + 39 * 60_000), null);
});

test("travel time L1 -> Earth follows the sunward flow speed", () => {
  const s = { velocityGse: vec(-500, 0, 0), speed: 500 } as L1Sample;
  assert.equal(travelSeconds(s), 3000);
});

test("5-min driver mean uses published GSM and protons-only dynamic pressure", () => {
  const { wind, mag } = rtsw(10);
  const series = buildL1Series(wind, mag);
  const mean = meanDrivers(series, T0 + 9 * 60_000, () => {
    throw new Error("must not convert when GSM is published");
  });
  assert.ok(mean);
  assert.equal(mean.samples, 5);
  assert.equal(mean.bz, -3.8);
  assert.ok(Math.abs(mean.dynamicPressure - dynamicPressureNpa(3, 500)) < 1e-12);
});

test("arriving now: the L1 sample measured one travel time ago, as a 5-min mean", () => {
  const { wind, mag } = rtsw(180); // 3 h at 500 km/s: 50 min travel
  const series = buildL1Series(wind, mag);
  const now = T0 + 179 * 60_000;
  const arriving = arrivingNow(series, now, noConvert);
  assert.ok(arriving);
  assert.equal(arriving.observedAt, new Date(now - 50 * 60_000).toISOString());
  assert.equal(arriving.arrivedAt, new Date(now).toISOString());
  assert.equal(arriving.travelSeconds, 3000);
  assert.equal(arriving.samples, 5);
});

test("arriving now: null when the series doesn't reach back one travel time, or has a gap there", () => {
  const { wind, mag } = rtsw(30);
  const series = buildL1Series(wind, mag);
  assert.equal(arrivingNow(series, T0 + 29 * 60_000, noConvert), null, "30 min of data, 50 min travel");
  assert.equal(arrivingNow(series, T0 + 6 * 3_600_000, noConvert), null, "series ended hours ago");
});

test("RTSW series: the proton temperature is carried; fills and missing values read null (GAU-154)", () => {
  const t = (i: number) => tag(T0 + i * 60_000);
  const wind = [
    { time_tag: t(0), source: "SOLAR1", active: true, proton_speed: 450, proton_density: 4, proton_temperature: 95_000 },
    { time_tag: t(1), source: "SOLAR1", active: true, proton_speed: 450, proton_density: 4, proton_temperature: -9999 },
    { time_tag: t(2), source: "SOLAR1", active: true, proton_speed: 450, proton_density: 4 },
  ];
  const mag = [0, 1, 2].map((i) => ({ time_tag: t(i), source: "SOLAR1", active: true, bt: 5, bx_gse: 3, by_gse: 0, bz_gse: -4, bx_gsm: 3, by_gsm: 0.5, bz_gsm: -3.97 }));
  assert.deepEqual(buildL1Series(wind, mag).map((s) => s.temperature), [95_000, null, null]);
});
