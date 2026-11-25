/**
 * Runs the pilot ingest for the operator console's Evidence view (GAU-59) by starting the same
 * command a pilot operator types: `npm run trust:ingest -- <log> <mapping> --replay <event>
 * --pack ... `. Two reasons it is a separate process and not a function call:
 *   - the replay swaps the global `fetch` for the stored archive while it runs
 *     (backend/replay/replay.ts), which must never happen inside the live server;
 *   - the pack a buyer downloads from the console is then, byte for byte, the pack the CLI writes.
 *
 * The log and mapping live in a private temp directory only while the command runs. Nothing is
 * signed here: signing needs the key holder at the host (docs/EVIDENCE_SIGNING.md).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventById } from "../replay/events.js";
import type { EvidencePack } from "./evidence.js";
import { mappingProblems, type LogMapping } from "./ingest.js";
import type { TrustRecord } from "./record.js";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EVENTS_DIR = join(REPO_ROOT, "backend/replay/events");
const MAPPINGS_DIR = join(REPO_ROOT, "backend/trust/mappings");
const FIXTURES_DIR = join(REPO_ROOT, "backend/trust/fixtures");
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** A run that outlives this is stopped: the 26 h storm replays in well under it. */
export const PILOT_TIMEOUT_MS = 120_000;

export interface PilotInput {
  log: Buffer;
  mapping: LogMapping;
  /** A stored storm in backend/replay/events (see `pilotEvents`). */
  eventId: string;
}

export interface PilotSummary {
  file: { sha256: string; bytes: number; rows: number };
  mapping: { id: string; version: string };
  accepted: number;
  rejected: Array<{ row: number; errors: string[] }>;
  verdicts: Record<string, number>;
}

export interface PilotResult {
  summary: PilotSummary;
  /** Every accepted row's record, including any outside the pack's window. */
  records: TrustRecord[];
  pack: EvidencePack;
}

/** The run could not produce a pack; `message` is safe to show (no host paths). */
export class PilotError extends Error {}

export type PilotRunner = (input: PilotInput) => Promise<PilotResult>;

export interface PilotEvent {
  id: string;
  /** Null for a stored archive that has no catalogue entry. */
  title: string | null;
  start: string | null;
  end: string | null;
}

/** The stored storms a log can be replayed against, catalogue entries first. */
export function pilotEvents(): PilotEvent[] {
  return readdirSync(EVENTS_DIR)
    .filter((f) => f.endsWith(".json.gz"))
    .map((f) => f.slice(0, -".json.gz".length))
    .filter((id) => SLUG.test(id))
    .map((id) => {
      const e = eventById(id);
      return { id, title: e?.title ?? null, start: e?.start ?? null, end: e?.end ?? null };
    })
    .sort((a, b) => Number(b.title !== null) - Number(a.title !== null) || a.id.localeCompare(b.id));
}

/** The column mappings shipped with Gauss; a customer's own mapping is sent with the request. */
export function builtInMappings(): LogMapping[] {
  return readdirSync(MAPPINGS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(MAPPINGS_DIR, f), "utf8")) as LogMapping)
    .filter((m) => mappingProblems(m).length === 0);
}

/** The synthetic sample log (no customer data), so the flow can be shown without a customer file. */
export function sampleLog(): { name: string; mappingId: string; eventId: string; text: string } {
  return { name: "generic-inferences.csv", mappingId: "generic-csv", eventId: "jan-2026", text: readFileSync(join(FIXTURES_DIR, "generic-inferences.csv"), "utf8") };
}

/** Only what the command needs: no server secrets reach the child process. */
const childEnv = () => Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])));

export const runPilot: PilotRunner = async ({ log, mapping, eventId }) => {
  if (!pilotEvents().some((e) => e.id === eventId)) throw new PilotError(`unknown replay event "${eventId}"`);
  const problems = mappingProblems(mapping);
  if (problems.length) throw new PilotError(`the mapping can't be used: ${problems.join("; ")}`);

  const dir = mkdtempSync(join(tmpdir(), "gauss-pilot-")); // 0700, removed below
  const at = (name: string) => join(dir, name);
  try {
    writeFileSync(at("log"), log, { mode: 0o600 });
    writeFileSync(at("mapping.json"), JSON.stringify(mapping), { mode: 0o600 });
    const args = ["--import", "tsx", "scripts/trust/ingest-log.ts", at("log"), at("mapping.json"), "--replay", eventId];
    args.push("--out", at("records.jsonl"), "--report", at("report.json"), "--pack", at("pack.json"));
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: childEnv(), stdio: ["ignore", "ignore", "pipe"], timeout: PILOT_TIMEOUT_MS });
      let err = "";
      child.stderr.on("data", (d: Buffer) => {
        if (err.length < 16_384) err += d.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (c) => resolve({ code: c, stderr: err }));
    });
    if (code !== 0) {
      // The command's own last line says why (e.g. "Evidence pack not built: ..."); never the temp paths.
      const last = stderr.trim().split("\n").filter((l) => l.trim() && !/^\s+at |^node:|^Node\.js/.test(l)).pop() ?? "";
      throw new PilotError(code === null ? "the run took too long and was stopped" : (last.split(dir).join("").replace(/^Error: /, "").trim().slice(0, 600) || "the run failed"));
    }
    return {
      summary: JSON.parse(readFileSync(at("report.json"), "utf8")) as PilotSummary,
      records: readFileSync(at("records.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TrustRecord),
      pack: JSON.parse(readFileSync(at("pack.json"), "utf8")) as EvidencePack,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** The exact bytes `trust:ingest --pack` writes for a pack, so a download equals the CLI's file. */
export const packFileText = (pack: EvidencePack) => JSON.stringify(pack, null, 2) + "\n";
