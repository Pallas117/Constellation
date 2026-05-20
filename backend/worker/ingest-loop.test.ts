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
