import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { IcmeInterval, L1Structures, ShockCandidate } from "../physics/l1-structures.js";
import { HOLDOUT_EVENTS, type HoldoutEvent } from "./holdout.js";
import { holdoutScorecard, holdoutTotals, scoreHoldout } from "./holdout-score.js";

const event: HoldoutEvent = {
  id: "test",
  title: "test",
  start: "2025-01-01T00:00:00Z",
  end: "2025-01-02T00:00:00Z",
  expect: "",
  target: { disturbance: "2025-01-01T06:00:00Z", shock: true, icmeStart: "2025-01-01T10:00:00Z", icmeEnd: "2025-01-02T10:00:00Z", quality: "1", dV: 100, mc: 2 },
  others: [{ disturbance: "2024-12-31T12:00:00Z", shock: false, icmeStart: "2024-12-31T18:00:00Z", icmeEnd: "2025-01-01T02:00:00Z", quality: "3", dV: 0, mc: 1 }],
};
const none: L1Structures = {
  shocks: [],
  fieldOnlyDiscontinuities: [],
  sustainedSouthward: [],
  magnetopauseInsideGeo: [],
  icmeCandidates: [],
  fastFlows: [],
  coverage: { speed: 1, density: 1, bt: 1, bz: 1, temperature: 1 },
  notes: [],
};
const shockAt = (time: string, earthArrival: string): ShockCandidate => ({
  kind: "fast-forward shock candidate",
  time,
  earthArrival,
  shockSpeedKmS: 600,
  deltaSpeedKmS: 100,
  densityRatio: 2,
  fieldRatio: 2,
  confidence: "high",
});
const icmeFrom = (start: string, end: string): IcmeInterval => ({
  kind: "ICME candidate",
  start,
  end,
  hours: 6,
  signatures: ["low proton beta"],
  medianTemperatureRatio: 0.9,
  medianProtonBeta: 0.05,
  minBzNt: -5,
  maxBtNt: 15,
  confidence: "medium",
});

test("holdout scoring: a shock within 30 min and an ICME start within 2 h are hits; outside, misses", () => {
  const hit = scoreHoldout(event, { ...none, shocks: [shockAt("2025-01-01T05:20:00Z", "2025-01-01T06:25:00Z")], icmeCandidates: [icmeFrom("2025-01-01T11:30:00Z", "2025-01-01T20:00:00Z")] });
  assert.deepEqual([hit.shock, hit.icme], [{ hit: true, arrivalErrorMin: 25 }, { hit: true, startErrorMin: 90 }]);
  const miss = scoreHoldout(event, { ...none, shocks: [shockAt("2025-01-01T05:30:00Z", "2025-01-01T06:35:00Z")], icmeCandidates: [icmeFrom("2025-01-01T12:30:00Z", "2025-01-01T20:00:00Z")] });
  assert.deepEqual([miss.shock?.hit, miss.icme?.hit], [false, false]);
  const nothing = scoreHoldout(event, none);
  assert.deepEqual([nothing.shock, nothing.icme], [{ hit: false, arrivalErrorMin: null }, { hit: false, startErrorMin: null }]);
});

test("holdout scoring: candidates matching nothing catalogued are false alarms; a neighbouring ICME isn't", () => {
  const r = scoreHoldout(event, {
    ...none,
    shocks: [shockAt("2025-01-01T01:00:00Z", "2025-01-01T01:40:00Z")],
    icmeCandidates: [icmeFrom("2024-12-31T20:00:00Z", "2025-01-01T01:00:00Z"), icmeFrom("2025-01-02T14:00:00Z", "2025-01-02T20:00:00Z")],
  });
  assert.deepEqual(r.falseShocks, ["2025-01-01T01:00:00Z"]);
  // The first candidate overlaps the previous catalogued ICME, so only the second is false.
  assert.deepEqual(r.falseIcmes, ["2025-01-02T14:00:00Z"]);
});

test("holdout scoring: on a quiet day every candidate is a false alarm, and totals add up", () => {
  const quiet: HoldoutEvent = { ...event, id: "quiet", target: null, others: [] };
  const q = scoreHoldout(quiet, { ...none, shocks: [shockAt("2025-01-01T03:00:00Z", "2025-01-01T03:40:00Z")] });
  assert.deepEqual([q.kind, q.shock, q.icme, q.falseShocks.length], ["quiet", null, null, 1]);
  const t = holdoutTotals([scoreHoldout(event, none), q]);
  assert.deepEqual(t, {
    shocks: { expected: 1, hit: 0, missed: 1, falseAlarms: 1 },
    icmes: { expected: 1, hit: 0, missed: 1, falseAlarms: 0 },
    quietDays: 1,
    quietDayFalseAlarms: 1,
  });
});

test("holdout: the detectors' scorecard on the GAU-154 holdout set is unchanged (npm run replay:holdout -- --update if intended)", () => {
  const committed = JSON.parse(readFileSync(fileURLToPath(new URL("golden/holdout-scorecard.json", import.meta.url)), "utf8"));
  assert.deepEqual(holdoutScorecard(), committed);
  assert.equal(committed.scores.length, HOLDOUT_EVENTS.length);
});
