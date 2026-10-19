import assert from "node:assert/strict";
import test from "node:test";
import { vec } from "../physics/coordinates.js";
import type { ParticleReading, ScaleReading } from "../types.js";
import {
  checkChannelRows,
  checkFieldMagnitude,
  checkProtonSpectrum,
  compareScales,
  expireCheck,
  fieldSampleProblem,
  FLAT_RUN,
  type FieldSample,
} from "./sense-checks.js";

const END = Date.parse("2026-10-19T08:40:00Z");

// Real RTSW minutes: SOLAR1 2026-10-19 07:45 (Bt 0.02 nT below |B|: rounding), IMAP 2026-10-19 08:42,
// and IMAP 2026-10-18 10:07 (Bt 0.87 nT above |B|: the field turned within the minute).
const rounding: FieldSample = { t: END, bt: 4.66, magneticFieldGse: vec(3.23, -1.83, 2.85), magneticFieldGsm: vec(3.23, -0.26, 3.34) };
const imap: FieldSample = { t: END, bt: 4.05, magneticFieldGse: vec(1.68, -2.22, 2.95), magneticFieldGsm: vec(1.68, -0.48, 3.64) };
const turning: FieldSample = { t: END, bt: 3.23, magneticFieldGse: vec(0.86, -1.41, 1.68), magneticFieldGsm: vec(0.86, -0.35, 2.09) };

test("field: Bt at or above |B| passes, including real minutes within rounding", () => {
  assert.equal(fieldSampleProblem(imap), null);
  assert.equal(fieldSampleProblem(rounding), null);
  assert.equal(fieldSampleProblem(turning), null, "Bt well above |<B>| is physical, not an error");
  const check = checkFieldMagnitude([rounding, imap].map((s, i) => ({ ...s, t: END - i * 60_000 })), "IMAP", END);
  assert.equal(check.status, "pass");
  assert.equal(check.reason, "IMAP Bt and |B| agree in all 2 samples of the last 30 min");
});

test("field: Bt below the magnitude of its own components is flagged with a reason", () => {
  const bad: FieldSample = { t: END, bt: 2.0, magneticFieldGse: vec(3, 4, 0), magneticFieldGsm: vec(3, 0, 4) };
  assert.match(fieldSampleProblem(bad) ?? "", /Bt 2\.00 nT is below \|B\| 5\.00 nT/);

  const series = [{ ...bad, t: END - 120_000 }, { ...imap, t: END - 60_000 }, imap];
  const check = checkFieldMagnitude(series, "SOLAR1", END);
  assert.equal(check.status, "flag");
  assert.equal(check.checked, 3);
  assert.equal(check.flagged, 1, "the bad minute is counted, not dropped");
  assert.match(check.reason, /SOLAR1 field inconsistent in 1 of 3 samples .* at 08:38 UTC: Bt 2\.00/);
});

test("field: GSE and GSM magnitudes that differ are flagged; a frame change can't alter |B|", () => {
  const rotatedWrong: FieldSample = { t: END, bt: 5.1, magneticFieldGse: vec(3, 4, 0), magneticFieldGsm: vec(3, 4, 3) };
  assert.match(fieldSampleProblem(rotatedWrong) ?? "", /5\.00 nT in GSE but 5\.83 nT in GSM/);
});

test("field: no samples in the window is unknown, not pass", () => {
  assert.equal(checkFieldMagnitude([], "SOLAR1", END).status, "unknown");
  const old = { ...imap, t: END - 31 * 60_000 };
  assert.equal(checkFieldMagnitude([old], "SOLAR1", END).status, "unknown");
  const unpublished: FieldSample = { t: END, bt: null, magneticFieldGse: vec(1, 1, 1), magneticFieldGsm: null };
  assert.equal(checkFieldMagnitude([unpublished], "SOLAR1", END).status, "unknown", "nothing to compare against");
});

const p = (energy: string, value: number): ParticleReading => ({ value, energy, satellite: "GOES-18", timestamp: "2026-10-19T08:40:00.000Z" });

test("protons: integral flux that falls with energy passes, including background noise", () => {
  // GOES-18 at 08:40 UTC on 2026-10-19: background, channels within 5 % of each other.
  const quiet = checkProtonSpectrum([p(">=10 MeV", 0.267), p(">=50 MeV", 0.254), p(">=100 MeV", 0.238)]);
  assert.equal(quiet.status, "pass");
  assert.equal(checkProtonSpectrum([p(">=10 MeV", 150), p(">=50 MeV", 12), p(">=100 MeV", 2)]).status, "pass");
});

test("protons: a spectrum that rises with energy is flagged with both channels", () => {
  const check = checkProtonSpectrum([p(">=10 MeV", 3), p(">=50 MeV", 12), p(">=100 MeV", 2)]);
  assert.equal(check.status, "flag");
  assert.match(check.reason, />=50 MeV 12 pfu exceeds >=10 MeV 3\.0 pfu/);
  assert.equal(checkProtonSpectrum([p(">=10 MeV", 3), null, null]).status, "unknown", "one channel can't be compared");
});

const rows = (energy: string, values: Array<number | null>, unitStep = 5) =>
  values.map((flux, i) => ({ time_tag: new Date(END - (values.length - 1 - i) * unitStep * 60_000).toISOString(), energy, flux, satellite: 18 }));

test("channels: a fill as the newest sample is flagged; older fills are reported, not hidden", () => {
  const newestFill = checkChannelRows(rows(">=10 MeV", [0.25, 0.26, -1e5]), [">=10 MeV"], "goes-proton-channels", "pfu");
  assert.equal(newestFill.status, "flag");
  assert.match(newestFill.reason, /newest >=10 MeV sample \(08:40 UTC\) is a fill value; 1 fill value in the file skipped/);

  const olderFill = checkChannelRows(rows(">=10 MeV", [0.25, null, 0.26, 0.27]), [">=10 MeV"], "goes-proton-channels", "pfu");
  assert.equal(olderFill.status, "pass");
  assert.match(olderFill.reason, /1 fill value in the file skipped/);
  assert.equal(olderFill.flagged, 1);
});

test("channels: a flat-lined channel is flagged as saturated or stuck", () => {
  const flat = checkChannelRows(rows(">=50 MeV", [0.3, ...Array(FLAT_RUN).fill(4210.5)]), [">=50 MeV"], "goes-proton-channels", "pfu");
  assert.equal(flat.status, "flag");
  assert.match(flat.reason, />=50 MeV has read exactly 4210\.5 pfu for 4 samples: saturated or stuck/);
  assert.equal(checkChannelRows([], [">=10 MeV"], "goes-proton-channels", "pfu").status, "unknown");
});

const scale = (label: string, basis = "test"): ScaleReading => ({
  level: label.endsWith("?") ? null : (Number(label.slice(1)) as ScaleReading["level"]),
  label,
  basis,
  observedAt: null,
});

test("NOAA scales: agreement passes; a disagreement is flagged with both values and Gauss's basis", () => {
  const noaa = { R: 0, S: 2, G: 1, observedAt: "2026-10-19T08:35:00.000Z" };
  const agree = compareScales({ ...noaa, S: 0, G: 0 }, { R: scale("R0"), S: scale("S0"), G: scale("G0") }, END);
  assert.equal(agree.status, "pass");
  assert.equal(agree.reason, "NOAA agrees: R0 S0 G0");

  const differ = compareScales(noaa, { R: scale("R0"), S: scale("S1", "GOES >=10 MeV protons 85 pfu"), G: scale("G?") }, END);
  assert.equal(differ.status, "flag");
  assert.match(differ.reason, /NOAA S2, Gauss S1 \(GOES >=10 MeV protons 85 pfu\); G not compared/);
});

test("NOAA scales: missing or over an hour old is unknown, never agreement", () => {
  assert.equal(compareScales(null, { S: scale("S0") }, END).status, "unknown");
  const old = { R: 0, S: 0, G: 0, observedAt: "2026-10-19T07:00:00.000Z" };
  assert.equal(compareScales(old, { R: scale("R0"), S: scale("S0"), G: scale("G0") }, END).status, "unknown");
});

test("a check from an old fetch expires to unknown", () => {
  const pass = checkProtonSpectrum([p(">=10 MeV", 1), p(">=50 MeV", 0.5)]);
  assert.equal(expireCheck(pass, END + 10 * 60_000, 30 * 60_000, "GOES data").status, "pass");
  const expired = expireCheck(pass, END + 31 * 60_000, 30 * 60_000, "GOES data");
  assert.equal(expired.status, "unknown");
  assert.equal(expired.reason, "GOES data older than 30 min");
});
