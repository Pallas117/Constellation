/**
 * Cache the inputs for the offline replay:
 *   npm run replay:fetch -- may-2024 [oct-2024 …]        a named storm (GAU-138; also the GAU-154 holdout ids)
 *   npm run replay:fetch -- --window <fromISO> <toISO> --id <slug> [--title <text>] [--out <path.json.gz>]
 *                                                         a customer's own dates (GAU-59)
 *
 * Reads the archived SWPC real-time products from NASA CCMC iSWA (HAPI) and writes
 * backend/replay/events/<id>.json.gz, or `--out` (customer windows belong outside the repository).
 * A window is at most 31 days per archive; longer periods are split into <slug>-p1, -p2 … (with
 * `--out`, the file name gets the same suffix). Run once per window; the replay and its tests
 * never touch the network. Source, terms and the Kyoto Dst exclusion: backend/replay/fetch-archive.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { fetchArchive, MAX_WINDOW_DAYS, pieceIds, splitWindow, validateSlug, validateWindow } from "../../backend/replay/fetch-archive.js";
import { eventById } from "../../backend/replay/events.js";
import { holdoutById } from "../../backend/replay/holdout.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "../../backend/replay/events");
const args = process.argv.slice(2);
const usage = () => {
  console.error("usage: npm run replay:fetch -- <event id> [...]\n       npm run replay:fetch -- --window <fromISO> <toISO> --id <slug> [--title <text>] [--out <path.json.gz>]");
  process.exit(2);
};
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function write(path: string, archive: Awaited<ReturnType<typeof fetchArchive>>) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(JSON.stringify(archive), { level: 9 }));
  const counts = (["mag", "plasma", "protons", "electrons", "xrays", "kp"] as const).map((k) => `${k} ${archive[k].length}`);
  console.log(`${archive.id}: ${counts.join(", ")} → ${path}`);
}

try {
  const w = args.indexOf("--window");
  if (w >= 0) {
    const [fromText, toText] = [args[w + 1], args[w + 2]];
    const slug = opt("--id");
    if (!fromText || !toText || !slug || fromText.startsWith("--") || toText.startsWith("--")) usage();
    const { from, to } = validateWindow(fromText, toText);
    validateSlug(slug!);
    const pieces = splitWindow(from, to);
    const ids = pieceIds(slug!, pieces.length);
    if (pieces.length > 1) console.error(`${from} to ${to} is over ${MAX_WINDOW_DAYS} days: fetching ${pieces.length} archives (${ids.join(", ")})`);
    const out = opt("--out");
    if (out && !out.endsWith(".json.gz")) throw new Error("--out must end in .json.gz");
    for (const [i, piece] of pieces.entries()) {
      const archive = await fetchArchive({ id: ids[i], title: opt("--title") ?? `Customer window ${piece.start} to ${piece.end}`, ...piece });
      const path = out
        ? pieces.length === 1
          ? resolve(out)
          : join(parse(resolve(out)).dir, `${parse(parse(out).name).name}-p${i + 1}.json.gz`)
        : join(OUT, `${ids[i]}.json.gz`);
      write(path, archive);
    }
  } else {
    const ids = args.filter((a) => !a.startsWith("--"));
    if (ids.length === 0) usage();
    for (const id of ids) {
      const event = eventById(id) ?? holdoutById(id); // holdout storms: GAU-154
      if (!event) throw new Error(`unknown event ${id}`);
      write(join(OUT, `${id}.json.gz`), await fetchArchive(event));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "replay:fetch failed");
  process.exit(1);
}
