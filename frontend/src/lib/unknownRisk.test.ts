import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UndetectedObjectsAlert } from "../components/UndetectedObjectsAlert.tsx";
import { driverReadings, measuredDrivers, weatherRisk } from "./measured.ts";
import { ssaStatus } from "./ssaStatus.ts";
import type { SpaceObjectDetectionAlert } from "./types/space-object.ts";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const live = {
  timestamp: ago(30_000),
  indices: { kp: 3.3, dst: -10 },
  magneticField: { x: 1, y: 2, z: -4, bt: 5 },
  solarWind: { speed: 480, density: 5, dynamicPressure: 2 },
  quality: { outlier: false, stale: false, interpolated: false, extrapolated: false, lowConfidence: false, tier: 0 },
} as unknown as Parameters<typeof weatherRisk>[0];

test("unknown heliophysics risk has no threat score, never 0 (GAU-81)", () => {
  for (const [why, point] of [
    ["no feed", null],
    ["stale", { ...live!, quality: { ...live!.quality, stale: true } }],
    ["tier 3", { ...live!, quality: { ...live!.quality, tier: 3 } }],
    ["missing Kp", { ...live!, indices: { ...live!.indices, kp: undefined as unknown as number } }],
  ] as const) {
    const risk = weatherRisk(point, NOW);
    assert.equal(risk.label, "Unknown", why);
    assert.equal(risk.score, null, `${why}: an unknown risk is not a score of 0`);
  }
});

test("measured heliophysics risk keeps its score and level (GAU-81)", () => {
  const risk = weatherRisk(live, NOW);
  assert.equal(risk.score, 54);
  assert.equal(risk.label, "Active Warning");
  assert.equal(weatherRisk({ ...live!, indices: { ...live!.indices, kp: 0 }, solarWind: { ...live!.solarWind, speed: 300 } }, NOW).label, "Stable");
});

test("a stopped feed's last point ages into unknown, never shown as current (GAU-81)", () => {
  // Polling failures keep the last point in place, still unflagged: the client must age it.
  const frozen = { ...live!, timestamp: ago(2 * 3_600_000) };
  assert.equal(measuredDrivers(frozen, NOW), null, "2 h old is not a current measurement");
  assert.equal(weatherRisk(frozen, NOW).score, null, "2 h old gives no threat score");
  assert.equal(measuredDrivers({ ...live!, timestamp: "not a time" }, NOW), null, "no valid time is not current");
  assert.notEqual(measuredDrivers({ ...live!, timestamp: ago(14 * 60_000) }, NOW), null, "within the 15 min cap is current");
});

test("Kp and Bz cards show Stale with the data's age, never the old number (GAU-81)", () => {
  const frozen = driverReadings({ ...live!, timestamp: ago(2 * 3_600_000) }, NOW);
  for (const reading of [frozen.kp, frozen.bz]) {
    assert.equal(reading.text, "Stale");
    assert.equal(reading.current, false);
    assert.equal(reading.note, "Data age 2h00m");
  }

  const flagged = driverReadings({ ...live!, quality: { ...live!.quality, stale: true } }, NOW);
  assert.equal(flagged.kp.text, "Stale", "a backend stale flag wins over a recent time");
  assert.equal(flagged.bz.note, "Data age 30.0s");
  for (const view of [frozen, flagged]) {
    assert.doesNotMatch(`${view.kp.text} ${view.bz.text}`, /3\.3|-4/, "old values are not shown");
  }

  assert.equal(driverReadings({ ...live!, timestamp: "not a time" }, NOW).kp.note, "Reading has no valid time");
});

test("Kp and Bz cards: current values, missing field and no feed (GAU-81)", () => {
  assert.deepEqual(driverReadings(live, NOW), {
    kp: { text: "3.3", current: true, note: null },
    bz: { text: "-4.0 nT", current: true, note: null },
  });
  const noKp = driverReadings({ ...live!, indices: { ...live!.indices, kp: undefined as unknown as number } }, NOW);
  assert.equal(noKp.kp.text, "Unknown", "a missing Kp is not n/a or 0");
  assert.equal(noKp.bz.text, "-4.0 nT");
  assert.deepEqual(driverReadings(null, NOW).kp, { text: "Unknown", current: false, note: "No reading yet" });
});

test("SSA panel with no detection source says unknown, never nominal (GAU-81)", () => {
  const html = renderToStaticMarkup(createElement(UndetectedObjectsAlert, { alert: null }));
  assert.match(html, /unknown/i);
  assert.doesNotMatch(html, /nominal/i);
  assert.doesNotMatch(html, /accounted for/i);
  assert.doesNotMatch(html, /no anomalies/i);

  const header = ssaStatus(null);
  assert.equal(header.state, "unknown");
  assert.match(header.label, /UNKNOWN/);
  assert.doesNotMatch(header.label, /NOMINAL|ACTIVE/);
});

test("SSA panel still shows a real detection alert (GAU-81)", () => {
  const alert: SpaceObjectDetectionAlert = {
    timestamp: "2026-10-12T00:00:00Z",
    severity: "high",
    description: "Two uncatalogued returns near 36,000 km.",
    candidateCount: 2,
    candidates: [
      { id: "C-1", name: "Candidate 1", orbitType: "GEO", altitude: 35786, category: "unknown" },
      { id: "C-2", name: "Candidate 2", orbitType: "GEO", altitude: 35790, category: "unknown" },
    ],
  };
  const html = renderToStaticMarkup(createElement(UndetectedObjectsAlert, { alert }));
  assert.match(html, /untracked object alert/i); // the brand heading is sentence case
  assert.match(html, /Two uncatalogued returns/);
  assert.doesNotMatch(html, /SSA_UNKNOWN/);
  assert.deepEqual(ssaStatus(alert), {
    state: "alert",
    label: "UNTRACKED OBJECTS DETECTED: 2",
    detail: "Two uncatalogued returns near 36,000 km.",
  });
});
