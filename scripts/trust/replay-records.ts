/**
 * Trust records for a file of inferences, against a cached storm replayed through the live
 * pipeline (GAU-57; groundwork for the PR-03 replay pilot):
 *   npm run trust:replay -- jan-2026 inferences.json [--out records.jsonl]
 *
 * `inferences.json` is a JSON array (or JSONL) of trust-record requests:
 *   {"time": "...", "spacecraftId": "...", "modelId": "...", "output": ..., "confidence": 0.9,
 *    "ephemeris": {"latDeg": ..., "lonDeg": ..., "altKm": ...}}
 * Invalid requests are reported with their errors and skipped; nothing is defaulted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArchive, replayArchive } from "../../backend/replay/replay.js";
import { EnvironmentHistory } from "../../backend/trust/environment.js";
import { buildTrustRecord, parseTrustRequest } from "../../backend/trust/record.js";
import type { CanonicalSpaceWeatherPoint } from "../../backend/types.js";

const [eventId, inputPath, ...rest] = process.argv.slice(2);
const outAt = rest.indexOf("--out");
const outPath = outAt >= 0 ? rest[outAt + 1] : null;
if (!eventId || !inputPath) {
  console.error("usage: npm run trust:replay -- <event id> <inferences.json|.jsonl> [--out records.jsonl]");
  process.exit(2);
}

const text = readFileSync(inputPath, "utf8").trim();
const raw: unknown[] = text.startsWith("[") ? JSON.parse(text) : text.split("\n").filter(Boolean).map((l) => JSON.parse(l));

const archive = loadArchive(join(dirname(fileURLToPath(import.meta.url)), "../../backend/replay/events", `${eventId}.json.gz`));
const points: CanonicalSpaceWeatherPoint[] = [];
await replayArchive(archive, { points });
const history = new EnvironmentHistory(points, `replay ${eventId}`);
// The replay ends when the archive does: nothing after it can be "now" for these records.
const nowMs = Date.parse(archive.end);

const lines: string[] = [];
const counts: Record<string, number> = {};
raw.forEach((item, i) => {
  const parsed = parseTrustRequest(item);
  if ("errors" in parsed) {
    console.error(`inference ${i}: skipped: ${parsed.errors.join("; ")}`);
    counts.invalid = (counts.invalid ?? 0) + 1;
    return;
  }
  const record = buildTrustRecord(parsed.request, history, { nowMs });
  counts[record.verdict.value] = (counts[record.verdict.value] ?? 0) + 1;
  lines.push(JSON.stringify(record));
});

if (outPath) writeFileSync(outPath, lines.join("\n") + "\n");
else process.stdout.write(lines.join("\n") + "\n");
console.error(`${eventId}: ${lines.length} records (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")})`);
