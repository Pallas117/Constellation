import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { archiveTelemetry, DEFAULT_KEEP_LINES } from "./local-db.js";

const rec = (i: number) =>
  JSON.stringify({ type: "canonical", data: { timestamp: new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString(), i } });

async function setup(n: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-archive-"));
  const file = path.join(dir, "telemetry.jsonl");
  const all = Array.from({ length: n }, (_, i) => rec(i));
  await fs.writeFile(file, all.map((l) => l + "\n").join(""), "utf8");
  return { dir, file, archiveDir: path.join(dir, "archive"), all };
}

test("archives all but the newest lines into a verified gzip with a fixity manifest, then keeps the tail (GAU-157)", async () => {
  const { file, archiveDir, all } = await setup(1000);
  const r = await archiveTelemetry(file, archiveDir, 300);
  assert.equal(r.archivedLines, 700);
  assert.equal(r.keptLines, 300);

  const kept = (await fs.readFile(file, "utf8")).trimEnd().split("\n");
  assert.deepEqual(kept, all.slice(700), "the live file keeps exactly the newest 300 lines, in order");

  const gz = await fs.readFile(r.archive!);
  const raw = gunzipSync(gz).toString("utf8");
  assert.equal(raw, all.slice(0, 700).map((l) => l + "\n").join(""), "nothing removed is missing from the archive");

  const m = JSON.parse(await fs.readFile(`${r.archive}.manifest.json`, "utf8"));
  assert.equal(m.format, "gauss-telemetry-archive/1");
  assert.equal(m.lines, 700);
  assert.equal(m.raw_bytes, Buffer.byteLength(raw));
  assert.equal(m.raw_sha256, crypto.createHash("sha256").update(raw).digest("hex"));
  assert.equal(m.gzip_sha256, crypto.createHash("sha256").update(gz).digest("hex"));
  assert.equal(m.first_timestamp, JSON.parse(all[0]).data.timestamp);
  assert.equal(m.last_timestamp, JSON.parse(all[699]).data.timestamp);
  assert.deepEqual(r.manifest, m);

  const leftovers = (await fs.readdir(path.dirname(file))).filter((f) => f.includes("archiving"));
  assert.deepEqual(leftovers, [], "no temporary tail file left behind");
  assert.deepEqual((await fs.readdir(archiveDir)).filter((f) => f.endsWith(".part")), []);
});

test("nothing is archived or rewritten when the file already fits; a missing file is a no-op (GAU-157)", async () => {
  const { file, archiveDir } = await setup(50);
  const before = await fs.stat(file);
  const r = await archiveTelemetry(file, archiveDir, 50);
  assert.deepEqual(r, { archivedLines: 0, keptLines: 50, archive: null, manifest: null });
  assert.equal((await fs.stat(file)).ino, before.ino, "file untouched");
  await assert.rejects(fs.stat(archiveDir), "no archive folder created");

  const missing = await archiveTelemetry(path.join(path.dirname(file), "nope.jsonl"), archiveDir, 10);
  assert.deepEqual(missing, { archivedLines: 0, keptLines: 0, archive: null, manifest: null });
});

test("if the archive can't be written, the live file is left exactly as it was (GAU-157)", async () => {
  const { dir, file } = await setup(200);
  const blocked = path.join(dir, "archive-is-a-file");
  await fs.writeFile(blocked, "x");
  const before = await fs.readFile(file);
  await assert.rejects(archiveTelemetry(file, blocked, 10));
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual((await fs.readdir(dir)).filter((f) => f.includes("archiving")), []);
});

test("a half-written last line is kept in the live file, not archived or lost (GAU-157)", async () => {
  const { file, archiveDir, all } = await setup(20);
  await fs.appendFile(file, '{"type":"canon', "utf8");
  const r = await archiveTelemetry(file, archiveDir, 5);
  assert.equal(r.archivedLines, 16);
  const kept = (await fs.readFile(file, "utf8")).trimEnd().split("\n");
  assert.deepEqual(kept, [...all.slice(16), '{"type":"canon']);
});

test("appends made while archiveOld runs wait for it and are not lost; the default keeps 30k lines (GAU-157)", async () => {
  assert.equal(DEFAULT_KEEP_LINES, 30_000);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bedrock-archive-lock-"));
  await fs.writeFile(path.join(dir, "telemetry.jsonl"), Array.from({ length: 500 }, (_, i) => rec(i) + "\n").join(""), "utf8");
  process.env.GAUSS_BEDROCK_DIR = dir;
  const { BedrockDB } = await import(`./local-db.js?archive-lock=${encodeURIComponent(dir)}`);
  const db = new BedrockDB();
  const archiving = db.archiveOld(100);
  const appends = Array.from({ length: 25 }, (_, i) => db.appendTelemetryStrict({ type: "canonical", data: { late: i } }));
  const [r] = await Promise.all([archiving, ...appends]);
  assert.equal(r.archivedLines, 400);
  const kept = (await fs.readFile(path.join(dir, "telemetry.jsonl"), "utf8")).trimEnd().split("\n");
  assert.equal(kept.length, 125, "100 kept lines + every append made during the swap");
  assert.deepEqual(kept.slice(100).map((l) => JSON.parse(l).data.late), Array.from({ length: 25 }, (_, i) => i));
  assert.equal(db.failedWrites, 0);
});
