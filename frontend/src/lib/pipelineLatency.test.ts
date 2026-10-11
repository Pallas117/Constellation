import assert from "node:assert/strict";
import test from "node:test";
import { describePipeline, formatDuration } from "./pipelineLatency.ts";
import type { PipelineLatencySnapshot } from "./types/space-weather.ts";

const base: PipelineLatencySnapshot = {
  generatedAt: "2026-10-11T12:00:00.000Z",
  status: "fresh",
  tickIntervalMs: 5000,
  ticks: 10,
  skippedTicks: 0,
  lastTickAt: "2026-10-11T12:00:00.000Z",
  lastTickAgeMs: 1000,
  dataTimestamp: "2026-10-11T11:59:00.000Z",
  dataAgeMs: 60_000,
  freshMs: 600_000,
  maxAgeMs: 900_000,
  stages: [
    { stage: "noaa", lastMs: 850, p50Ms: 800, p95Ms: 900, maxMs: 950, budgetMs: 8000, overBudget: false, samples: 5, errors: 0, timeouts: 0, lastAt: "" },
    { stage: "tick", lastMs: 900, p50Ms: 400, p95Ms: 1200, maxMs: 1300, budgetMs: 5000, overBudget: false, samples: 10, errors: 0, timeouts: 0, lastAt: "" },
  ],
};

test("HUD shows the backend pipeline verdict, data age and slowest stage", () => {
  const view = describePipeline(base);
  assert.equal(view.label, "FRESH");
  assert.equal(view.tone, "nominal");
  assert.equal(view.dataAge, "1m00s");
  assert.equal(view.tick, "900ms / p95 1.2s");
  assert.equal(view.slowest, "NOAA 850ms");
});

test("HUD never shows stale or missing data as fresh", () => {
  assert.equal(describePipeline(null).tone, "unknown");
  assert.equal(describePipeline(null).label, "NO_TELEMETRY");
  const stale = describePipeline({ ...base, status: "stale", dataAgeMs: 1_000_000 });
  assert.equal(stale.label, "STALE");
  assert.equal(stale.tone, "critical");
  const none = describePipeline({ ...base, dataAgeMs: null, dataTimestamp: null });
  assert.equal(none.label, "STALE", "no measurement cannot be fresh even if the backend said so");
});

test("HUD keeps ageing a snapshot between polls", () => {
  // 9 minutes after the poll the data crosses the 10-minute live threshold...
  assert.equal(describePipeline(base, 9 * 60_000 + 1).label, "STALLED", "no new tick for 9 min means the loop stalled");
  // ...and a short poll gap only ages the data.
  const aged = describePipeline({ ...base, dataAgeMs: 599_000 }, 2_000);
  assert.equal(aged.label, "DEGRADED");
  assert.equal(aged.dataAge, "10m01s");
});

test("durations format for a glanceable HUD", () => {
  assert.equal(formatDuration(null), "---");
  assert.equal(formatDuration(42), "42ms");
  assert.equal(formatDuration(4200), "4.2s");
  assert.equal(formatDuration(61_000), "1m01s");
  assert.equal(formatDuration(3_660_000), "1h01m");
});
