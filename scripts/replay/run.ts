/**
 * Replay cached storms through the live pipeline, offline (GAU-138):
 *   npm run replay -- may-2024 [oct-2024 …] [--records <dir>] [--update-golden]
 *
 * Prints each summary. --records writes the per-minute records as JSONL; --update-golden
 * rewrites backend/replay/golden/<id>.json (only after checking why the output changed).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArchive, replayArchive } from "../../backend/replay/replay.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../backend/replay");
const args = process.argv.slice(2);
const updateGolden = args.includes("--update-golden");
const recordsAt = args.indexOf("--records");
const recordsDir = recordsAt >= 0 ? args[recordsAt + 1] : null;
const ids = args.filter((a, i) => !a.startsWith("--") && (recordsAt < 0 || i !== recordsAt + 1));
if (ids.length === 0) {
  console.error("usage: npm run replay -- <event id> [...] [--records <dir>] [--update-golden]");
  process.exit(2);
}

for (const id of ids) {
  const started = performance.now();
  const { records, summary } = await replayArchive(loadArchive(join(ROOT, "events", `${id}.json.gz`)));
  console.log(JSON.stringify(summary, null, 2));
  console.error(`${id}: ${records.length} minutes in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  if (recordsDir) {
    mkdirSync(recordsDir, { recursive: true });
    writeFileSync(join(recordsDir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  if (updateGolden) {
    mkdirSync(join(ROOT, "golden"), { recursive: true });
    writeFileSync(join(ROOT, "golden", `${id}.json`), JSON.stringify(summary, null, 2) + "\n");
  }
}
