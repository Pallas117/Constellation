/**
 * The browser "Wire your logs" preview (frontend/src/lib/log-wiring.ts) must judge rows exactly as
 * the real ingest does. This runs both on the shipped fixture and on rows that break each rule.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildMapping, detectFormat, ingestCommand, mappingId, previewLog, readLog, sniffTime, suggestMapping, wiringProblems, type FieldKey, type ReadLog, type WiringMapping } from "../../frontend/src/lib/log-wiring.js";
import { ingestLog, mappingProblems, type LogMapping } from "./ingest.js";

const fixture = readFileSync(new URL("./fixtures/generic-inferences.csv", import.meta.url), "utf8");
const shipped = JSON.parse(readFileSync(new URL("./mappings/generic-csv.json", import.meta.url), "utf8")) as LogMapping;

const read = (text: string, name: string): ReadLog => {
  const r = readLog(text, detectFormat(name, text));
  assert.ok(!("error" in r), JSON.stringify(r));
  return r as ReadLog;
};

/** Accepted rows and each rejected row's reasons, from the backend ingest. */
const backend = (text: string, m: WiringMapping) => {
  const rep = ingestLog(Buffer.from(text), m as unknown as LogMapping);
  return { accepted: rep.accepted.map((a) => a.request.ingest.row), rejected: rep.rejected };
};
const browser = (log: ReadLog, m: WiringMapping) => {
  const p = previewLog(log.records, m);
  return { accepted: p.accepted, rejected: p.rejected };
};

test("the suggested mapping for the fixture is the shipped generic-csv mapping", () => {
  const log = read(fixture, "log.csv");
  const s = suggestMapping(log.headers, log.records);
  // `output` may be one column or a list of one; both name the same column.
  const list = (v: unknown) => [v].flat();
  for (const [k, v] of Object.entries(shipped.columns)) assert.deepEqual(list(s.columns[k as FieldKey]), list(v), k);
  assert.equal(s.timeFormat, "iso");
  assert.equal(s.needsUtcConfirmation, false);
  const m = buildMapping({ format: "csv", timeFormat: s.timeFormat, assumeUtc: false, columns: s.columns, constants: {}, id: "fixture" });
  assert.deepEqual(wiringProblems(m, log.headers), []);
  assert.deepEqual(mappingProblems(m), [], "the backend accepts the mapping the wizard builds");
});

test("preview and backend agree on the fixture, row for row", () => {
  const log = read(fixture, "log.csv");
  const m = buildMapping({ format: "csv", timeFormat: "iso", assumeUtc: false, columns: shipped.columns, constants: {}, id: "fixture" });
  const be = backend(fixture, m);
  const br = browser(log, m);
  assert.equal(br.accepted, be.accepted.length);
  assert.deepEqual(br.rejected, be.rejected);
  assert.ok(be.rejected.some((r) => r.errors[0].startsWith("duplicate")), "the fixture has a duplicate");
  assert.ok(be.rejected.some((r) => r.errors[0].startsWith("out of order")), "the fixture has an out-of-order row");
});

test("preview and backend agree on every row rule", () => {
  const csv = [
    "t,sat,model,label,score,lat,lon,alt",
    "2026-01-19T02:00:00Z,S1,m1,a,0.5,10,20,500", // good
    "2026-01-19T02:01:00,S1,m1,a,0.5,,,", // no zone
    "yesterday,S1,m1,a,0.5,,,", // not a time
    "2026-01-19T02:02:00Z,,m1,a,0.5,,,", // no spacecraft
    "2026-01-19T02:03:00Z,S1,,a,0.5,,,", // no model
    "2026-01-19T02:04:00Z,S1,m1,a,1.5,,,", // confidence out of range
    "2026-01-19T02:05:00Z,S1,m1,a,high,,,", // confidence not a number
    "2026-01-19T02:06:00Z,S1,m1,a,0.5,95,20,500", // latitude
    "2026-01-19T02:07:00Z,S1,m1,a,0.5,10,400,500", // longitude
    "2026-01-19T02:08:00Z,S1,m1,a,0.5,10,20,50", // altitude
    "2026-01-19T02:09:00Z,S1,m1,a,0.5,10,,", // partial position
    "2026-01-19T02:10:00Z,S1,m1,a", // short row
    "2026-01-19T01:00:00Z,S1,m1,a,0.5,,,", // out of order
    "2026-01-19T02:00:00Z,S1,m1,a,0.5,10,20,500", // duplicate of row 1
  ].join("\n");
  const log = read(csv, "x.csv");
  const cols = { time: "t", spacecraftId: "sat", modelId: "model", output: "label", confidence: "score", latDeg: "lat", lonDeg: "lon", altKm: "alt" };
  const m = buildMapping({ format: "csv", timeFormat: "iso", assumeUtc: false, columns: cols, constants: {}, id: "rules" });
  const be = backend(csv, m);
  assert.equal(be.accepted.length, 1, "only the first row is good");
  assert.deepEqual(browser(log, m), { accepted: be.accepted.length, rejected: be.rejected });
});

test("zone-less times need confirmation, then agree with the backend", () => {
  const csv = "t,sat,model\n2026-01-19 02:00:00,S1,m1\n2026-01-19 02:01:00,S1,m1\n";
  const log = read(csv, "x.csv");
  const s = suggestMapping(log.headers, log.records);
  assert.equal(s.needsUtcConfirmation, true);
  const base = { format: "csv" as const, timeFormat: s.timeFormat, columns: s.columns, constants: {}, id: "z" };
  const without = buildMapping({ ...base, assumeUtc: false });
  assert.equal(browser(log, without).accepted, 0);
  assert.equal(backend(csv, without).accepted.length, 0);
  const withUtc = buildMapping({ ...base, assumeUtc: true });
  assert.equal(browser(log, withUtc).accepted, 2);
  assert.equal(backend(csv, withUtc).accepted.length, 2);
});

test("epoch seconds and milliseconds are told apart and read the same as the backend", () => {
  assert.deepEqual(sniffTime(["1768788000", "1768788060"]), { timeFormat: "unix-s", assumeUtc: false });
  assert.deepEqual(sniffTime(["1768788000000"]), { timeFormat: "unix-ms", assumeUtc: false });
  assert.equal(sniffTime(["hello"]), null);
  for (const [unit, a, b] of [["unix-s", "1768788000", "1768788060"], ["unix-ms", "1768788000000", "1768788060000"]] as const) {
    const csv = `ts,satellite,model_name\n${a},S1,m1\n${b},S1,m1\n`;
    const log = read(csv, "e.csv");
    const s = suggestMapping(log.headers, log.records);
    assert.equal(s.timeFormat, unit);
    const m = buildMapping({ format: "csv", timeFormat: s.timeFormat, assumeUtc: false, columns: s.columns, constants: {}, id: "e" });
    assert.deepEqual(browser(log, m).accepted, backend(csv, m).accepted.length);
  }
});

test("JSONL and JSON logs are read, and a missing spacecraft can be a constant", () => {
  const rows = [
    { timestamp: "2026-01-19T02:00:00Z", model: "m1", prediction: "ship", conf: 0.7 },
    { timestamp: "2026-01-19T02:01:00Z", model: "m1", prediction: "none", conf: 0.9 },
  ];
  for (const [name, text] of [["a.jsonl", rows.map((r) => JSON.stringify(r)).join("\n")], ["a.json", JSON.stringify(rows)]] as const) {
    const log = read(text, name);
    const s = suggestMapping(log.headers, log.records);
    assert.equal(s.columns.time, "timestamp");
    assert.equal(s.columns.spacecraftId, undefined);
    const bare = buildMapping({ format: log.format, timeFormat: "iso", assumeUtc: false, columns: s.columns, constants: {}, id: "j" });
    assert.ok(wiringProblems(bare, log.headers).some((p) => /spacecraft/.test(p)));
    const m = buildMapping({ format: log.format, timeFormat: "iso", assumeUtc: false, columns: s.columns, constants: { spacecraftId: "SAT-9" }, id: "j" });
    assert.deepEqual(wiringProblems(m, log.headers), []);
    assert.deepEqual(browser(log, m), { accepted: backend(text, m).accepted.length, rejected: backend(text, m).rejected });
  }
});

test("file-level problems are said in plain words", () => {
  assert.deepEqual(readLog("", "csv"), { error: "The file is empty." });
  assert.match((readLog('a,b\n"x', "csv") as { error: string }).error, /never closes/);
  assert.match((readLog("{nope", "json") as { error: string }).error, /not valid JSON/);
  assert.match((readLog('{"a":1}', "json") as { error: string }).error, /array/);
  const bom = "﻿" + fixture;
  assert.equal((readLog(bom, "csv") as ReadLog).headers[0], "inference_time", "a byte-order mark does not break the first header");
});

test("a wrong column name is reported before any row is judged", () => {
  const log = read(fixture, "log.csv");
  const m = buildMapping({ format: "csv", timeFormat: "iso", assumeUtc: false, columns: { ...shipped.columns, time: "when" }, constants: {}, id: "bad" });
  assert.ok(wiringProblems(m, log.headers).some((p) => p.includes('"when"')));
});

test("the command quotes paths and the id is shell- and file-safe", () => {
  assert.equal(mappingId("Kepler Orin log (Nov).csv"), "kepler-orin-log-nov");
  assert.equal(mappingId("???"), "customer-log");
  assert.equal(ingestCommand("my log.csv", "map.json"), "npm run trust:ingest -- 'my log.csv' 'map.json' --replay jan-2026");
  assert.equal(ingestCommand("it's.csv", "m.json"), "npm run trust:ingest -- 'it'\\''s.csv' 'm.json' --replay jan-2026");
});
