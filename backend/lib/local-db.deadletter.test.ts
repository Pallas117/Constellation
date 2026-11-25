import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decodeLine, encodeLine, rotateFiles, storeLimitsFromEnv } from "./local-db.js";

async function freshDb(): Promise<{ db: import("./local-db.js").BedrockDB; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-dlq-"));
  process.env.GAUSS_BEDROCK_DIR = dir;
  const mod = await import(`./local-db.js?dlq=${encodeURIComponent(dir)}`);
  return { db: new mod.BedrockDB(), dir };
}

test("checksum: a written line verifies, a changed one does not, an old unchecked line passes (Zone C)", () => {
  const line = encodeLine({ type: "mms", timestamp: "2026-11-26T00:00:00Z", data: { bz_nT: -4.5 } });
  const ok = decodeLine(line);
  assert.ok(ok.ok && ok.checked);
  assert.deepEqual(ok.ok && ok.record, { type: "mms", timestamp: "2026-11-26T00:00:00Z", data: { bz_nT: -4.5 } });
  assert.deepEqual(decodeLine(line.replace("-4.5", "-9.5")), { ok: false, reason: "checksum_mismatch" });
  assert.deepEqual(decodeLine("{not json"), { ok: false, reason: "invalid_json" });
  assert.deepEqual(decodeLine("[1,2]"), { ok: false, reason: "not_an_object" });
  const legacy = decodeLine(JSON.stringify({ type: "old" }));
  assert.ok(legacy.ok && !legacy.checked);
});

test("dead letter: a bad row lands in the dead-letter file with its reason and valid rows still append (Zone C)", async () => {
  const { db, dir } = await freshDb();
  await db.appendTelemetryStrict({ type: "a", n: 1 });
  const file = path.join(dir, "telemetry.jsonl");
  const good = (await fs.readFile(file, "utf8")).trim();
  await fs.appendFile(file, good.replace('"n":1', '"n":2') + "\n{broken\n", "utf8"); // flipped value, torn line
  await db.appendTelemetryStrict({ type: "a", n: 3 });

  const first = await db.getRecent(10);
  assert.deepEqual(first.map((r) => r.n), [1, 3], "both bad lines left out, valid ones kept, no throw");
  assert.equal(db.lastSkippedLines, 2);
  assert.equal(db.deadLettered, 2);
  await db.getRecent(10); // same bad lines read again: not logged twice
  assert.equal(db.deadLettered, 2);

  const dlq = (await fs.readFile(path.join(dir, "telemetry.deadletter.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(dlq.map((e) => e.reason).sort(), ["checksum_mismatch", "invalid_json"]);
  assert.ok(dlq.every((e) => typeof e.at === "string" && typeof e.line === "string" && e.line_sha256.length === 64));
  assert.equal(db.stats().deadLettered, 2);
});

test("dead letter: a very long bad line is cut, not stored whole (Zone C)", async () => {
  const { db, dir } = await freshDb();
  await fs.writeFile(path.join(dir, "telemetry.jsonl"), "{" + "x".repeat(100_000) + "\n", "utf8");
  await db.getRecent(5);
  const [entry] = (await fs.readFile(path.join(dir, "telemetry.deadletter.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(entry.line.length, 2048);
  assert.equal(entry.line_chars, 100_001);
});

test("size cap: the live file rotates at the cap, keeps N files, and reads span the rotation (Zone C)", async () => {
  const { db, dir } = await freshDb();
  db.maxBytes = 4096;
  db.keepFiles = 3;
  for (let i = 0; i < 200; i += 1) await db.appendTelemetryStrict({ type: "t", i, pad: "p".repeat(100) });
  const names = (await fs.readdir(dir)).filter((n) => n.startsWith("telemetry.jsonl")).sort();
  assert.deepEqual(names, ["telemetry.jsonl", "telemetry.jsonl.1", "telemetry.jsonl.2"], "never more than keepFiles files");
  for (const n of names) assert.ok((await fs.stat(path.join(dir, n))).size <= 4096, `${n} within the cap`);
  assert.ok(db.rotations >= 2);
  const recent = await db.getRecent(5);
  assert.deepEqual(recent.map((r) => r.i), [195, 196, 197, 198, 199], "newest records, oldest first");
  assert.equal(db.deadLettered, 0);
});

test("size cap: right after a rotation a read still returns recent history from the rotated file (Zone C)", async () => {
  const { db } = await freshDb();
  db.maxBytes = 1024 * 1024;
  db.keepFiles = 2;
  for (let i = 0; i < 5; i += 1) await db.appendTelemetryStrict({ type: "t", i });
  await db.appendTelemetryStrict({ type: "t", i: 5, pad: "x".repeat(db.maxBytes) }); // forces a rotation first
  const recent = await db.getRecent(10);
  assert.deepEqual(recent.map((r) => r.i), [0, 1, 2, 3, 4, 5]);
});

test("size cap env: floor, ceiling and junk fall back to safe values (Zone C)", () => {
  assert.deepEqual(storeLimitsFromEnv({}), { maxBytes: 256 * 1024 * 1024, keepFiles: 4 });
  assert.deepEqual(storeLimitsFromEnv({ GAUSS_TELEMETRY_MAX_BYTES: "10", GAUSS_TELEMETRY_KEEP_FILES: "1" }), { maxBytes: 1024 * 1024, keepFiles: 2 });
  assert.equal(storeLimitsFromEnv({ GAUSS_TELEMETRY_KEEP_FILES: "500" }).keepFiles, 20);
  assert.deepEqual(storeLimitsFromEnv({ GAUSS_TELEMETRY_MAX_BYTES: "abc", GAUSS_TELEMETRY_KEEP_FILES: "x" }), { maxBytes: 256 * 1024 * 1024, keepFiles: 4 });
});

test("rotateFiles shifts names up and removes the oldest (Zone C)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-rot-"));
  const f = path.join(dir, "x.jsonl");
  await fs.writeFile(f, "live");
  await fs.writeFile(`${f}.1`, "one");
  await rotateFiles(f, 2);
  assert.equal(await fs.readFile(`${f}.1`, "utf8"), "live");
  await assert.rejects(fs.stat(f));
  await assert.rejects(fs.stat(`${f}.2`));
});
