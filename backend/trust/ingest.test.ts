import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadArchive, replayArchive } from "../replay/replay.js";
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import { EnvironmentHistory } from "./environment.js";
import { ingestLog, MAPPING_SCHEMA, parseCsv, type LogMapping } from "./ingest.js";
import { buildTrustRecord } from "./record.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
// A synthetic log (CRLF line ends), one row per rejection rule; not customer data.
const csv = readFileSync(here("fixtures/generic-inferences.csv"));
const mapping = JSON.parse(readFileSync(here("mappings/generic-csv.json"), "utf8")) as LogMapping;

test("ingest: valid rows become requests with file hash, row number and mapping version (GAU-66)", () => {
  const report = ingestLog(csv, mapping);
  const sha = createHash("sha256").update(csv).digest("hex");
  assert.deepEqual(report.file, { sha256: sha, bytes: csv.length, rows: 9 });
  assert.deepEqual(report.accepted.map((a) => a.request.ingest.row), [1, 2, 6]);
  const first = report.accepted[0].request;
  assert.equal(first.time, "2026-01-19T02:10:00.000Z");
  assert.equal(first.spacecraftId, "DEMO-SAT-1");
  assert.deepEqual(first.output, { label: "clear" });
  assert.equal(first.confidence, 0.94);
  assert.deepEqual(first.ephemeris, { latDeg: 12.4, lonDeg: 101.7, altKm: 525 });
  assert.deepEqual(first.ingest, { fileSha256: sha, row: 1, mappingId: "generic-csv", mappingVersion: "0.1.0" });
  assert.equal(report.accepted[1].request.ephemeris, null, "empty position cells mean no ephemeris, not 0,0,0");
  assert.deepEqual(report.accepted[2].request.output, { label: 'vessel, small "fishing"' }, "quoted comma and escaped quotes");
});

test("ingest: malformed, duplicate and out-of-order rows are rejected with reasons, never dropped (GAU-66)", () => {
  const { rejected, accepted, file } = ingestLog(csv, mapping);
  assert.equal(accepted.length + rejected.length, file.rows, "every row accounted for");
  assert.deepEqual(rejected, [
    { row: 3, errors: ["duplicate of row 2 (same spacecraft, model and time)"] },
    { row: 4, errors: ["out of order: earlier than row 2 for spacecraft DEMO-SAT-1"] },
    { row: 5, errors: ['time "2026-01-19T05:00:00" has no time zone; set assumeUtc in the mapping only if the customer confirms UTC'] },
    { row: 7, errors: ["confidence must be a number from 0 to 1"] },
    { row: 8, errors: ['time "not-a-time" is not an ISO 8601 date and time'] },
    { row: 9, errors: ["row has 4 fields, the header has 8"] },
  ]);
});

test("ingest: the same bytes and mapping give the same result; a changed byte changes the hash (GAU-66)", () => {
  assert.deepEqual(ingestLog(csv, mapping), ingestLog(csv, mapping));
  const changed = Buffer.from(csv.toString("utf8").replace("0.94", "0.95"));
  assert.notEqual(ingestLog(changed, mapping).file.sha256, ingestLog(csv, mapping).file.sha256);
});

test("ingest: a mapping naming a missing column, or an invalid mapping, fails the whole file with the reason (GAU-66)", () => {
  assert.throws(() => ingestLog(csv, { ...mapping, columns: { ...mapping.columns, confidence: "conf" } }), /the header has no column "conf" named in the mapping/);
  assert.throws(() => ingestLog(csv, { ...mapping, version: "" }), /Mapping not usable: version is required/);
  assert.throws(() => ingestLog(csv, { ...mapping, columns: { ...mapping.columns, altKm: undefined } }), /latDeg, lonDeg and altKm go together/);
  assert.throws(() => ingestLog(Buffer.from('a,b\n"open'), { ...mapping, columns: { time: "a", spacecraftId: "b", modelId: "b" } }), /a quoted field never closes/);
});

test("ingest: JSONL with epoch-millisecond times and per-file constants (GAU-66)", () => {
  const jsonl: LogMapping = {
    schema: MAPPING_SCHEMA,
    id: "jsonl-ms",
    version: "1",
    format: "jsonl",
    timeFormat: "unix-ms",
    columns: { time: "t", output: "pred", confidence: "p" },
    constants: { spacecraftId: "AVERA-1", modelId: "atlas-v2" },
  };
  const t = Date.parse("2026-01-19T02:10:00Z");
  const text = [JSON.stringify({ t, pred: "cloud", p: 0.9 }), "{not json", JSON.stringify({ t: t + 60_000, pred: "clear", p: 0.8 })].join("\n");
  const r = ingestLog(Buffer.from(text), jsonl);
  assert.deepEqual(r.accepted.map((a) => [a.request.time, a.request.output, a.request.spacecraftId]), [
    ["2026-01-19T02:10:00.000Z", "cloud", "AVERA-1"],
    ["2026-01-19T02:11:00.000Z", "clear", "AVERA-1"],
  ]);
  assert.deepEqual(r.rejected, [{ row: 2, errors: ["row is not valid JSON"] }]);
});

test("ingest: CSV parsing follows RFC 4180 (quotes, escaped quotes, CRLF, empty fields) (GAU-66)", () => {
  assert.deepEqual(parseCsv('a,"b,c","say ""hi"""\r\n,,\r\nx'), { rows: [["a", "b,c", 'say "hi"'], ["", "", ""], ["x"]] });
});

test("ingest: an ingested log becomes trust records that carry their provenance, through the replayed storm (GAU-66)", async () => {
  const points: CanonicalSpaceWeatherPoint[] = [];
  const archive = loadArchive(here("../replay/events/jan-2026.json.gz"));
  await replayArchive(archive, { end: "2026-01-19T05:30:00Z", points });
  const history = new EnvironmentHistory(points, "replay jan-2026");
  const records = ingestLog(csv, mapping).accepted.map((a) => buildTrustRecord(a.request, history, { nowMs: Date.parse(archive.end) }));
  assert.deepEqual(records.map((r) => [r.inference.ingest?.row, r.environment.radiation.value?.label, r.verdict.value]), [
    [1, "S1", "consistent"],
    [2, "S2", "degraded-context"],
    [6, "S2", "degraded-context"],
  ]);
  assert.equal(records[0].inference.ingest?.mappingVersion, "0.1.0");
});
