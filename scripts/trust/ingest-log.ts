/**
 * Ingest a customer inference log and build its trust records (PR-03a, GAU-66):
 *   npm run trust:ingest -- <log.csv|.json|.jsonl> <mapping.json> --replay <event> [--out records.jsonl] [--report report.json]
 *     [--pack pack.json [--pdf pack.pdf] [--from <ISO> --to <ISO>] [--previous-pack previous.json]]
 *
 * The report lists every rejected row with its reasons; nothing is dropped silently. Records
 * carry each row's provenance (file SHA-256, row number, mapping id and version). The
 * environment comes from a cached storm replayed through the live pipeline (`--replay`), so a
 * past window is judged by what Gauss would have known at the time.
 *
 * `--pack` also writes the evidence pack for the analysis window (PR-04, GAU-60; default: the
 * replayed event's window) and `--pdf` its PDF. Accepted rows outside the window are listed in
 * the pack as not used, with the reason. `--previous-pack` chains it to the last pack, after
 * checking that one. Check a pack with `npm run trust:verify -- pack.json`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArchive, replayArchive } from "../../backend/replay/replay.js";
import { EnvironmentHistory } from "../../backend/trust/environment.js";
import { buildEvidencePack, verifyEvidencePack, type EvidencePack } from "../../backend/trust/evidence.js";
import { renderEvidencePdf } from "../../backend/trust/evidence-pdf.js";
import { ingestLog, type LogMapping } from "../../backend/trust/ingest.js";
import { buildTrustRecord, DEFAULT_POLICY, TRUST_RECORD_SCHEMA } from "../../backend/trust/record.js";
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

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const archivePath = join(root, "backend/replay/events", `${eventId}.json.gz`);
const archive = loadArchive(archivePath);
const points: CanonicalSpaceWeatherPoint[] = [];
await replayArchive(archive, { points });
const history = new EnvironmentHistory(points, `replay ${eventId}`);
const nowMs = Date.parse(archive.end);
const records = report.accepted.map((a) => buildTrustRecord(a.request, history, { nowMs, policy: DEFAULT_POLICY }));

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

const packPath = opt("--pack");
if (packPath) {
  const window = { from: opt("--from") ?? archive.start, to: opt("--to") ?? archive.end };
  const [fromMs, toMs] = [Date.parse(window.from), Date.parse(window.to)];
  const inWindow = (t: string) => Date.parse(t) >= fromMs && Date.parse(t) <= toMs;
  const outside = report.accepted.filter((a) => !inWindow(a.request.time));
  const previous = opt("--previous-pack");
  let previousPackHash: string | null = null;
  if (previous) {
    const prior = JSON.parse(readFileSync(previous, "utf8")) as EvidencePack;
    const problems = verifyEvidencePack(prior);
    if (problems.length) {
      console.error(`${previous} does not verify, so it can't start a chain: ${problems.join("; ")}`);
      process.exit(1);
    }
    previousPackHash = prior.packHash;
  }
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  let commit = "unknown";
  try {
    commit = git("rev-parse", "HEAD") + (git("status", "--porcelain", "--untracked-files=no") ? "+modified" : "");
  } catch {
    // not a git checkout: the pack says so
  }
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const pack = buildEvidencePack(
    records.filter((r) => inWindow(r.inference.time)),
    {
      window,
      generatedAtMs: nowMs,
      inputs: {
        log: {
          fileSha256: report.file.sha256,
          bytes: report.file.bytes,
          rows: report.file.rows,
          mappingId: report.mapping.id,
          mappingVersion: report.mapping.version,
          rejected: [
            ...report.rejected,
            ...outside.map((a) => ({ row: a.request.ingest.row, errors: [`outside the analysis window ${window.from} to ${window.to}`] })),
          ].sort((a, b) => a.row - b.row),
        },
        environment: { source: history.label, archiveSha256: sha(readFileSync(archivePath)) },
        policy: DEFAULT_POLICY,
        software: {
          name: "Gauss",
          commit,
          requirementsVersion: (JSON.parse(readFileSync(join(root, "requirements/requirements.json"), "utf8")) as { version: string }).version,
          trustRecordSchema: TRUST_RECORD_SCHEMA,
        },
        previousPackHash,
      },
    },
  );
  writeFileSync(packPath, JSON.stringify(pack, null, 2) + "\n");
  const pdfPath = opt("--pdf");
  if (pdfPath) writeFileSync(pdfPath, renderEvidencePdf(pack));
  console.error(`evidence pack ${pack.packId}: ${pack.records.length} records, pack hash ${pack.packHash}${pdfPath ? `; PDF ${pdfPath}` : ""}`);
}
