/**
 * Ingest a customer inference log and build its trust records (PR-03a, GAU-66):
 *   npm run trust:ingest -- <log.csv|.json|.jsonl> <mapping.json> --replay <event> [--out records.jsonl] [--report report.json]
 *
 * The report lists every rejected row with its reasons; nothing is dropped silently. Records
 * carry each row's provenance (file SHA-256, row number, mapping id and version). The
 * environment comes from a cached storm replayed through the live pipeline (`--replay`), so a
 * past window is judged by what Gauss would have known at the time.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArchive, replayArchive } from "../../backend/replay/replay.js";
import { EnvironmentHistory } from "../../backend/trust/environment.js";
import { ingestLog, type LogMapping } from "../../backend/trust/ingest.js";
import { buildTrustRecord } from "../../backend/trust/record.js";
import type { CanonicalSpaceWeatherPoint } from "../../backend/types.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const [logPath, mappingPath] = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const eventId = opt("--replay");
if (!logPath || !mappingPath || !eventId) {
  console.error("usage: npm run trust:ingest -- <log> <mapping.json> --replay <event id> [--out records.jsonl] [--report report.json]");
  process.exit(2);
}

const mapping = JSON.parse(readFileSync(mappingPath, "utf8")) as LogMapping;
const report = ingestLog(readFileSync(logPath), mapping);

const archive = loadArchive(join(dirname(fileURLToPath(import.meta.url)), "../../backend/replay/events", `${eventId}.json.gz`));
const points: CanonicalSpaceWeatherPoint[] = [];
await replayArchive(archive, { points });
const history = new EnvironmentHistory(points, `replay ${eventId}`);
const nowMs = Date.parse(archive.end);
const records = report.accepted.map((a) => buildTrustRecord(a.request, history, { nowMs }));

const verdicts: Record<string, number> = {};
for (const r of records) verdicts[r.verdict.value] = (verdicts[r.verdict.value] ?? 0) + 1;
const summary = { file: report.file, mapping: report.mapping, accepted: report.accepted.length, rejected: report.rejected, verdicts };

const outPath = opt("--out");
const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
if (outPath) writeFileSync(outPath, lines);
else process.stdout.write(lines);
const reportPath = opt("--report");
if (reportPath) writeFileSync(reportPath, JSON.stringify(summary, null, 2) + "\n");
console.error(
  `${logPath}: ${report.file.rows} rows, ${report.accepted.length} accepted, ${report.rejected.length} rejected; ` +
    `verdicts ${Object.entries(verdicts).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`,
);
for (const r of report.rejected) console.error(`  row ${r.row}: ${r.errors.join("; ")}`);
