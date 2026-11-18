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

test("tail read touches only a bounded chunk of a file far larger than the tail (REQ-PER-001)", async () => {
  // ~12 MB file; the last 10 lines live in the final 64 KB chunk, so one read should suffice.
  const line = JSON.stringify({ pad: "x".repeat(110) });
  const lineBytes = Buffer.byteLength(line) + 1;
  const file = await tmpFile((line + "\n").repeat(100_000));
  const fileBytes = lineBytes * 100_000;

  // Count bytes through the FileHandle read seam (no change to production code).
  const probe = await fs.open(file, "r");
  const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<{ bytesRead: number }> };
  await probe.close();
  const realRead = proto.read;
  let bytesRead = 0;
  proto.read = async function (this: unknown, ...args: unknown[]) {
    const result = await realRead.apply(this, args);
    bytesRead += result.bytesRead;
    return result;
  };
  let tail: string[];
  try {
    tail = await readTailLines(file, 10);
  } finally {
    proto.read = realRead;
  }
  assert.equal(tail.length, 10);
  assert.ok(bytesRead > 0, "the seam saw the read");
  assert.ok(fileBytes > 100 * 64 * 1024, "the file is far larger than one chunk");
  assert.ok(bytesRead <= 2 * 64 * 1024, `read ${bytesRead} of ${fileBytes} bytes`);
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

test("GAU-244: points are stored under what they are; only usable observations come back as canonical history", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-kinds-"));
  process.env.GAUSS_BEDROCK_DIR = dir;
  const { BedrockDB } = await import(`./local-db.js?kinds=${encodeURIComponent(dir)}`);
  const { goodPoint } = await import("./canonical-check.test.js");
  const db = new BedrockDB();
  const t = (min: number) => new Date(Date.parse("2026-11-17T10:00:00Z") + min * 60_000).toISOString();
  assert.equal(await db.appendCanonicalStrict(goodPoint({ timestamp: t(1), observedAt: t(0) })), "canonical");
  assert.equal(await db.appendCanonicalStrict(goodPoint({ timestamp: t(2), observedAt: t(1), solarWind: { speed: 64_483, density: 4, dynamicPressure: 1 } })), "canonical-rejected");
  assert.equal(await db.appendCanonicalStrict(goodPoint({ timestamp: t(3), observedAt: undefined, quality: { stale: true } })), "canonical-stale");
  assert.equal(db.rejectedPoints, 1, "only the impossible point counts as rejected; a stale tick is not an error");
  assert.equal(db.failedWrites, 0);

  const lines = (await fs.readFile(path.join(dir, "telemetry.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.type), ["canonical", "canonical-rejected", "canonical-stale"], "nothing silently dropped");
  assert.match(lines[1].problems.join(" "), /speed 64483/, "the reasons are kept with the refused point");
  const history = await db.getCanonicalSince(Date.parse("2026-11-17T00:00:00Z"), 100);
  assert.deepEqual(history.map((p: { timestamp: string }) => p.timestamp), [t(1)], "reload sees only the usable observation");
});
