import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UndetectedObjectsAlert } from "../components/UndetectedObjectsAlert.tsx";
import { weatherRisk } from "./measured.ts";
import { ssaStatus } from "./ssaStatus.ts";
import type { SpaceObjectDetectionAlert } from "./types/space-object.ts";

const live = {
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
    const risk = weatherRisk(point);
    assert.equal(risk.label, "Unknown", why);
    assert.equal(risk.score, null, `${why}: an unknown risk is not a score of 0`);
  }
});

test("measured heliophysics risk keeps its score and level (GAU-81)", () => {
  const risk = weatherRisk(live);
  assert.equal(risk.score, 54);
  assert.equal(risk.label, "Active Warning");
  assert.equal(weatherRisk({ ...live!, indices: { ...live!.indices, kp: 0 }, solarWind: { ...live!.solarWind, speed: 300 } }).label, "Stable");
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
  assert.match(html, /UNTRACKED OBJECT ALERT/);
  assert.match(html, /Two uncatalogued returns/);
  assert.doesNotMatch(html, /SSA_UNKNOWN/);
  assert.deepEqual(ssaStatus(alert), {
    state: "alert",
    label: "UNTRACKED OBJECTS DETECTED: 2",
    detail: "Two uncatalogued returns near 36,000 km.",
  });
});
