import assert from "node:assert/strict";
import test from "node:test";
import type { ArchiveResult } from "./local-db.js";
import { RETENTION_KEEP_LINES, RETENTION_MIN_KEEP_LINES, retentionFromEnv, startTelemetryRetention } from "./telemetry-retention.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = { log: () => {}, error: () => {} };

function fakeDb(delayMs = 0, fail = false) {
  const calls: number[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  return {
    calls,
    get maxConcurrent() {
      return maxConcurrent;
    },
    async archiveOld(keepLines: number): Promise<ArchiveResult> {
      calls.push(keepLines);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(delayMs);
      concurrent -= 1;
      if (fail) throw new Error("disk full");
      return { archivedLines: 1, keptLines: keepLines, archive: "/tmp/a.jsonl.gz", manifest: null };
    },
  };
}

test("retention defaults: 3 days live (40,000 lines), daily, first run 10 min after start", () => {
  const cfg = retentionFromEnv({});
  assert.equal(cfg.keepLines, RETENTION_KEEP_LINES);
  assert.equal(cfg.everyMs, 24 * 60 * 60 * 1000);
  assert.equal(cfg.firstDelayMs, 10 * 60 * 1000);
});

test("retention env: a keep below the reload floor is raised; 0 hours turns it off; junk falls back", () => {
  assert.equal(retentionFromEnv({ GAUSS_TELEMETRY_KEEP_LINES: "5000" }).keepLines, RETENTION_MIN_KEEP_LINES);
  assert.equal(retentionFromEnv({ GAUSS_TELEMETRY_KEEP_LINES: "abc" }).keepLines, RETENTION_KEEP_LINES);
  assert.equal(retentionFromEnv({ GAUSS_TELEMETRY_ARCHIVE_HOURS: "0" }).everyMs, 0);
  assert.equal(retentionFromEnv({ GAUSS_TELEMETRY_ARCHIVE_HOURS: "6" }).everyMs, 6 * 60 * 60 * 1000);
});

test("retention runs after the first delay, repeats, and stops", async () => {
  const db = fakeDb();
  const stop = startTelemetryRetention(db, { keepLines: 40_000, everyMs: 30, firstDelayMs: 10 }, quiet);
  await sleep(5);
  assert.equal(db.calls.length, 0, "not at boot");
  await sleep(90);
  stop();
  const n = db.calls.length;
  assert.ok(n >= 2, `ran ${n} times`);
  assert.ok(db.calls.every((k) => k === 40_000));
  await sleep(60);
  assert.equal(db.calls.length, n, "nothing after stop");
});

test("retention never overlaps a slow run, and a failure is logged, not thrown", async () => {
  const slow = fakeDb(80);
  const stop = startTelemetryRetention(slow, { keepLines: 40_000, everyMs: 10, firstDelayMs: 1 }, quiet);
  await sleep(120);
  stop();
  assert.equal(slow.maxConcurrent, 1);

  const errors: string[] = [];
  const failing = fakeDb(0, true);
  const stop2 = startTelemetryRetention(failing, { keepLines: 40_000, everyMs: 1000, firstDelayMs: 1 }, { log: () => {}, error: (m) => errors.push(m) });
  await sleep(20);
  stop2();
  assert.equal(errors.length, 1);
  assert.match(errors[0], /live file unchanged/);
});

test("retention off: nothing scheduled", async () => {
  const db = fakeDb();
  const stop = startTelemetryRetention(db, { keepLines: 40_000, everyMs: 0, firstDelayMs: 1 }, quiet);
  await sleep(10);
  stop();
  assert.equal(db.calls.length, 0);
});
