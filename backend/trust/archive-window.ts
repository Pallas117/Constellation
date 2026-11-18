/**
 * Which replay archive an ingest run uses, and which of the log's rows it can judge (GAU-59).
 * `--replay <slug>` names an archive in backend/replay/events; `--archive <path>` is one outside
 * the repository (customer windows). A row outside the archive's window has no environment to
 * be judged against, so it is reported per row instead of silently getting an "unknown".
 */
import { join } from "node:path";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The archive file for exactly one of `replay` (an allowlisted slug, never a path) or `archive` (a path). */
export function archivePathFor(root: string, replay: string | undefined, archive: string | undefined): string {
  if (Boolean(replay) === Boolean(archive)) throw new Error("give exactly one of --replay <slug> and --archive <path>");
  if (archive) return archive;
  if (!SLUG.test(replay!)) throw new Error(`invalid --replay id "${replay}": use a-z, 0-9 and - only (for a file elsewhere, use --archive <path>)`);
  return join(root, "backend/replay/events", `${replay}.json.gz`);
}

/** Rows of `rows` whose time is outside [start, end] (inclusive), with the reason in plain words. */
export function outsideWindow<T extends { row: number; time: string }>(rows: T[], start: string, end: string, what: string): { row: number; errors: string[] }[] {
  const [a, b] = [Date.parse(start), Date.parse(end)];
  return rows
    .filter((r) => !(Date.parse(r.time) >= a && Date.parse(r.time) <= b))
    .map((r) => ({ row: r.row, errors: [`outside the ${what} ${start} to ${end} (row time ${r.time})`] }));
}
