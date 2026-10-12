import assert from "node:assert/strict";
import test from "node:test";
import { IngestionWorker } from "./ingest-loop.js";

type WorkerInternals = {
  shouldFetch: (key: string, cadenceMs: number) => boolean;
  couplingWindow: number[];
  trimCouplingWindow: () => void;
};

test("throttles NOAA fetches to once per 60s while worker ticks every 5s", () => {
  const worker = new IngestionWorker() as unknown as WorkerInternals;
  const realNow = Date.now;
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  Date.now = () => now;

  try {
    assert.equal(worker.shouldFetch("noaa", 60_000), true);

    for (let i = 0; i < 11; i += 1) {
      now += 5_000;
      assert.equal(
        worker.shouldFetch("noaa", 60_000),
        false,
        "NOAA should not refetch before cadence expires",
      );
    }

    now += 5_000;
    assert.equal(worker.shouldFetch("noaa", 60_000), true);
  } finally {
    Date.now = realNow;
  }
});

test("allows MMS survey fetch on each 5s cadence boundary", () => {
  const worker = new IngestionWorker() as unknown as WorkerInternals;
  const realNow = Date.now;
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  Date.now = () => now;

  try {
    assert.equal(worker.shouldFetch("mms", 5_000), true);
    assert.equal(worker.shouldFetch("mms", 5_000), false);

    now += 4_999;
    assert.equal(worker.shouldFetch("mms", 5_000), false);

    now += 1;
    assert.equal(worker.shouldFetch("mms", 5_000), true);
  } finally {
    Date.now = realNow;
  }
});

test("caps coupling window length to prevent unbounded memory growth", () => {
  const worker = new IngestionWorker() as unknown as WorkerInternals;
  worker.couplingWindow = Array.from({ length: 250 }, (_, i) => i);

  worker.trimCouplingWindow();

  assert.equal(worker.couplingWindow.length, 180);
  assert.equal(worker.couplingWindow[0], 70);
  assert.equal(worker.couplingWindow[179], 249);
});

type TimedWorker = {
  lastFetch: Map<string, number>;
  ticking: boolean;
  tick: () => Promise<{ pipeline?: { status: string; stages: Array<{ stage: string; lastMs: number; errors: number }> } }>;
  getPipelineLatency: () => { ticks: number; skippedTicks: number };
  start: () => void;
  stop: () => void;
};

async function withSlowFetch<T>(delayMs: number, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return new Response("unavailable", { status: 503 });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("tick reports per-stage latency, and sources are fetched in parallel", async () => {
  const worker = new IngestionWorker() as unknown as TimedWorker;
  const now = Date.now();
  // Only NOAA and ESA are due this tick; every request takes ~300ms and fails.
  for (const key of ["jaxa", "mms", "lasp", "ml-forecast"]) worker.lastFetch.set(key, now);

  const result = await withSlowFetch(300, () => worker.tick());
  const stages = new Map(result.pipeline?.stages.map((s) => [s.stage, s]));
  for (const stage of ["noaa", "esa", "nowcast", "aurora-grid", "persist", "tick"]) {
    assert.ok(stages.has(stage), `missing ${stage} timing`);
  }
  const noaa = stages.get("noaa")!.lastMs;
  const esa = stages.get("esa")!.lastMs;
  assert.ok(noaa >= 250 && esa >= 250, `slow fetches were timed (noaa ${noaa}ms, esa ${esa}ms)`);
  // The fetch phase is what remains of the tick after the sequential compute stages.
  const compute = ["nowcast", "aurora-grid", "persist"].reduce((sum, s) => sum + stages.get(s)!.lastMs, 0);
  const fetchPhase = stages.get("tick")!.lastMs - compute;
  assert.ok(
    fetchPhase < noaa + esa,
    `fetch phase ${fetchPhase}ms should be bounded by the slowest source, not the sum (${noaa + esa}ms)`,
  );
  assert.notEqual(result.pipeline?.status, "fresh", "failed sources cannot yield fresh data");
});

test("interval never stacks a tick on one still running", async () => {
  const worker = new IngestionWorker() as unknown as TimedWorker;
  const realSetInterval = globalThis.setInterval;
  let intervalFn: (() => void) | null = null;
  globalThis.setInterval = ((fn: () => void) => {
    intervalFn = fn;
    return realSetInterval(() => undefined, 1_000_000);
  }) as typeof setInterval;
  worker.tick = async () => ({}); // the first (retrying) tick
  try {
    worker.start();
    worker.ticking = true; // pretend a slow tick is in flight
    intervalFn!();
    intervalFn!();
    assert.equal(worker.getPipelineLatency().skippedTicks, 2);
  } finally {
    worker.stop();
    globalThis.setInterval = realSetInterval;
  }
});

test("forecast window: last 6 h of measured points, one per minute (GAU-115)", async () => {
  const { forecastWindow, FORECAST_WINDOW_MS } = await import("./ingest-loop.js");
  const now = Date.parse("2026-10-12T12:00:00Z");
  const point = (msAgo: number, stale = false) =>
    ({ timestamp: new Date(now - msAgo).toISOString(), quality: { stale } }) as unknown as Parameters<typeof forecastWindow>[0][number];
  const feed = [
    point(FORECAST_WINDOW_MS + 60_000), // older than the window
    ...Array.from({ length: 6 * 60 * 12 }, (_, i) => point(FORECAST_WINDOW_MS - 1 - i * 5_000)), // 6 h at 5 s
    point(30_000, true), // stale: not a measurement
    point(-60_000), // future: clock skew
  ];
  const window = forecastWindow(feed, now);
  assert.ok(window.length >= 359 && window.length <= 361, `~360 one-per-minute points, got ${window.length}`);
  assert.ok(window.every((p) => !p.quality.stale));
  const times = window.map((p) => Date.parse(p.timestamp));
  assert.ok(Math.min(...times) >= now - FORECAST_WINDOW_MS && Math.max(...times) <= now);
  const minutes = new Set(times.map((t) => Math.floor(t / 60_000)));
  assert.equal(minutes.size, window.length, "one point per minute");
});

test("the worker exposes its last forecast for the API to serve (GAU-115)", () => {
  const worker = new IngestionWorker() as unknown as { latestForecast: unknown; getLatestForecast: () => unknown };
  assert.equal(worker.getLatestForecast(), null);
  const f = { available: false, reason: "x" };
  worker.latestForecast = f;
  assert.equal(worker.getLatestForecast(), f);
});
