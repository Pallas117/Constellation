import assert from "node:assert/strict";
import test from "node:test";
import { PipelineTimer, StageTimeoutError } from "./pipeline-timing.js";

const FRESH = 10 * 60_000;
const MAX_AGE = 15 * 60_000;

function clockAt(start: number) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test("pipeline timer: rolling last/p50/p95/max per stage", () => {
  const clock = clockAt(0);
  const timer = new PipelineTimer(clock.now);
  for (const ms of [10, 20, 30, 40, 1000]) timer.record("nowcast", ms);
  timer.tickStarted();
  timer.tickFinished();
  const stage = timer.snapshot(5000, new Date(0).toISOString(), FRESH, MAX_AGE).stages.find((s) => s.stage === "nowcast");
  assert.ok(stage);
  assert.equal(stage.lastMs, 1000);
  assert.equal(stage.p50Ms, 30);
  assert.equal(stage.p95Ms, 1000);
  assert.equal(stage.maxMs, 1000);
  assert.equal(stage.overBudget, true, "1000ms nowcast exceeds its 250ms budget");
});

test("pipeline timer: a stage past its timeout is abandoned and counted", async () => {
  const timer = new PipelineTimer();
  await assert.rejects(
    timer.time("noaa", () => new Promise((resolve) => setTimeout(resolve, 200)), 20),
    StageTimeoutError,
  );
  await assert.rejects(timer.time("esa", () => { throw new Error("boom"); }));
  const stages = timer.snapshot(5000, null, FRESH, MAX_AGE).stages;
  assert.equal(stages.find((s) => s.stage === "noaa")?.timeouts, 1);
  assert.equal(stages.find((s) => s.stage === "esa")?.errors, 1);
});

test("pipeline timer: status follows data age and loop liveness", () => {
  const clock = clockAt(Date.parse("2026-10-11T12:00:00Z"));
  const timer = new PipelineTimer(clock.now);
  const measuredAt = (ageMs: number) => new Date(clock.now() - ageMs).toISOString();

  assert.equal(timer.snapshot(5000, measuredAt(0), FRESH, MAX_AGE).status, "stalled", "no tick yet");

  timer.tickStarted();
  clock.advance(100);
  timer.tickFinished();
  assert.equal(timer.snapshot(5000, measuredAt(60_000), FRESH, MAX_AGE).status, "fresh");
  assert.equal(timer.snapshot(5000, measuredAt(FRESH + 1), FRESH, MAX_AGE).status, "degraded");
  assert.equal(timer.snapshot(5000, measuredAt(MAX_AGE + 1), FRESH, MAX_AGE).status, "stale");
  assert.equal(timer.snapshot(5000, null, FRESH, MAX_AGE).status, "stale", "no measurement is never fresh");

  clock.advance(15_001);
  assert.equal(timer.snapshot(5000, measuredAt(1000), FRESH, MAX_AGE).status, "stalled", "3 missed ticks");
});
