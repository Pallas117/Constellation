import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readTailLines } from "./local-db.js";

async function tmpFile(content: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-tail-"));
  const file = path.join(dir, "telemetry.jsonl");
  await fs.writeFile(file, content, "utf8");
  return file;
}

test("tail read returns the last lines in order without reading the whole file (GAU-117)", async () => {
  // ~3 MB: many 64 KB chunks, so lines are split across chunk boundaries.
  const lines = Array.from({ length: 30_000 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(90) }));
  const file = await tmpFile(lines.join("\n") + "\n");
  const tail = await readTailLines(file, 1000);
  assert.equal(tail.length, 1000);
  assert.equal(JSON.parse(tail[0]).i, 29_000);
  assert.equal(JSON.parse(tail[999]).i, 29_999);
  assert.deepEqual(await readTailLines(file, 0), []);
  const all = await readTailLines(file, 50_000);
  assert.equal(all.length, 30_000, "asking for more than exists returns everything");
  assert.equal(JSON.parse(all[0]).i, 0);
});

test("tail read keeps multi-byte UTF-8 intact across chunk boundaries (GAU-117)", async () => {
  const lines = Array.from({ length: 5_000 }, (_, i) => JSON.stringify({ i, s: "Ω≈µ°–".repeat(7) }));
  const file = await tmpFile(lines.join("\n"));
  const tail = await readTailLines(file, 5_000);
  assert.equal(tail.length, 5_000);
  assert.ok(tail.every((l) => JSON.parse(l).s === "Ω≈µ°–".repeat(7)));
});

test("bedrock skips corrupt and torn lines instead of returning nothing (GAU-117)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-db-"));
  const now = Date.parse("2026-10-12T10:00:00Z");
  const point = (h: number) =>
    JSON.stringify({ type: "canonical", timestamp: "", data: { timestamp: new Date(now - h * 3_600_000).toISOString(), h } });
  const content = [point(30), point(20), "{not json", JSON.stringify({ type: "mms", data: {} }), point(2), point(1), '{"type":"canonical","da'].join("\n");
  await fs.writeFile(path.join(dir, "telemetry.jsonl"), content, "utf8");
  process.env.GAUSS_BEDROCK_DIR = dir;
  const { BedrockDB } = await import(`./local-db.js?dir=${encodeURIComponent(dir)}`);
  const db = new BedrockDB();
  const recent = await db.getRecent(100);
  assert.equal(recent.length, 5);
  assert.equal(db.lastSkippedLines, 2, "the corrupt line and the torn final write");
  const since = await db.getCanonicalSince(now - 24 * 3_600_000, 100);
  assert.deepEqual(since.map((p: { h: number }) => p.h), [20, 2, 1], "last 24 h, canonical only, oldest first");
});

test("FMEA: best-effort appends never reject (no unhandled rejection); strict appends do; both count (GAU-121)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-fail-"));
  await fs.mkdir(path.join(dir, "telemetry.jsonl")); // EISDIR on every append
  process.env.GAUSS_BEDROCK_DIR = dir;
  const { BedrockDB } = await import(`./local-db.js?fail=${encodeURIComponent(dir)}`);
  const db = new BedrockDB();
  await db.appendTelemetry({ type: "device-heartbeat" }); // must resolve
  await assert.rejects(db.appendTelemetryStrict({ type: "canonical" }));
  assert.equal(db.failedWrites, 2);
});
