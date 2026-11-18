/**
 * Write the guided storm walkthrough's data (GAU-229) from the cached replay archive, offline:
 *   npm run replay:walkthrough [-- <event id>]   (default may-2024)
 *
 * Output: frontend/src/data/walkthrough/<id>.json. replay.test.ts fails when the committed file
 * no longer matches the replay, so rerun this after any intended change to the replay output.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArchive, replayArchive } from "../../backend/replay/replay.js";
import { walkthroughData } from "../../backend/replay/walkthrough.js";
import type { CanonicalSpaceWeatherPoint } from "../../backend/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const id = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "may-2024";
const archive = loadArchive(join(ROOT, "backend/replay/events", `${id}.json.gz`));
const points: CanonicalSpaceWeatherPoint[] = [];
const { records, summary } = await replayArchive(archive, { points });
const data = walkthroughData(archive, { records, points, summary });
const out = join(ROOT, "frontend/src/data/walkthrough", `${id}.json`);
writeFileSync(out, `${JSON.stringify(data)}\n`);
console.error(`${id}: ${data.samples.length} samples every ${data.stepMin} min -> ${out}`);
