/**
 * Admin-only, read-only view of the funding tracker (investors, grant and programme applications,
 * bids). Mounted at /api/admin/funding behind the session and API_POLICY (admin only).
 *
 *   GET /   the export named by FUNDING_TRACKER_CSV, parsed and summarised (backend/funding/tracker.ts)
 *
 * The export is a CSV file on this machine, outside the repository (the repository is public; the
 * same rule as signing keys, backend/trust/signing.ts readSigningKeyFile). It is read on each
 * request and never cached, stored, written or sent anywhere else. There is no write route and no
 * upload route. Nothing from the file is logged: a failure logs a fixed code, never a path or a cell.
 * A failure answers 200 with `error`, so a missing file reads as the state it is, not as a server fault.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { MAX_TRACKER_BYTES, parseTracker, type TrackerFailure, type TrackerSummary } from "./tracker.js";

export const FUNDING_TRACKER_ENV = "FUNDING_TRACKER_CSV";
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export type FundingErrorCode = TrackerFailure | "not-absolute" | "inside-repo" | "missing" | "not-a-file" | "unreadable";

/** What the page shows for each failure. Fixed sentences: no path and nothing from the file. */
const MESSAGES: Record<FundingErrorCode, string> = {
  "not-absolute": `${FUNDING_TRACKER_ENV} must be an absolute path to the CSV export.`,
  "inside-repo": `${FUNDING_TRACKER_ENV} points inside the repository, which is public: keep the export outside it.`,
  missing: "The export is not where the setting says it is: export the sheet again, or correct the path.",
  "not-a-file": `${FUNDING_TRACKER_ENV} must name a file, not a folder.`,
  unreadable: "The export could not be read by the backend: check the file's permissions.",
  "too-large": `The export is over ${MAX_TRACKER_BYTES / (1024 * 1024)} MB: export only the tracker tab.`,
  "not-csv": "The file is not a CSV export: in the sheet use File, Download, Comma-separated values.",
  "no-name-column": "The export has no Name column, so its rows can't be told apart.",
};

export type FundingAnswer =
  | { configured: false }
  | { configured: true; error: { code: FundingErrorCode; message: string } }
  | ({ configured: true; exportedAt: string; today: string; readableByOthers: boolean } & TrackerSummary);

type Loaded = { ok: true; text: string; mtimeMs: number; readableByOthers: boolean } | { ok: false; code: FundingErrorCode };

/** The export's bytes, read through a size cap, or why not. Never throws and never names the path. */
export function readTrackerFile(path: string, repoRoot: string): Loaded {
  if (!isAbsolute(path)) return { ok: false, code: "not-absolute" };
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { ok: false, code: "missing" };
  }
  // Symlinks are resolved first, so a link outside the repository to a file inside it is refused too.
  const inRepo = relative(realpathSync(repoRoot), real);
  if (!inRepo.startsWith("..") && !isAbsolute(inRepo)) return { ok: false, code: "inside-repo" };
  let fd: number | undefined;
  try {
    fd = openSync(real, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ok: false, code: "not-a-file" };
    if (stat.size > MAX_TRACKER_BYTES) return { ok: false, code: "too-large" };
    // One byte over the cap is asked for, so a file that grew after the stat is still refused.
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_TRACKER_BYTES) + 1);
    let length = 0;
    for (;;) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
      if (length === buffer.length) break;
    }
    if (length > MAX_TRACKER_BYTES) return { ok: false, code: "too-large" };
    return { ok: true, text: buffer.subarray(0, length).toString("utf8"), mtimeMs: stat.mtimeMs, readableByOthers: (stat.mode & 0o077) !== 0 };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return { ok: false, code: code === "ENOENT" ? "missing" : code === "EISDIR" ? "not-a-file" : "unreadable" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
/** The host's calendar day: the reader and the host are the same person's machine. */
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function createFundingRouter(deps: { path?: () => string | undefined; repoRoot?: string; now?: () => number; log?: (line: string) => void } = {}) {
  const pathOf = deps.path ?? (() => process.env[FUNDING_TRACKER_ENV]);
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const router = express.Router();

  router.get("/", (_req: Request, res: Response) => {
    res.setHeader("cache-control", "no-store");
    const path = (pathOf() ?? "").trim();
    if (path === "") {
      res.json({ configured: false } satisfies FundingAnswer);
      return;
    }
    const refuse = (code: FundingErrorCode) => {
      log(`[funding] the tracker export can't be shown (${code})`); // the code only: no path, no contents
      res.json({ configured: true, error: { code, message: MESSAGES[code] } } satisfies FundingAnswer);
    };
    let answer: FundingAnswer | FundingErrorCode;
    try {
      const file = readTrackerFile(path, repoRoot);
      const today = localDay(now());
      const parsed = file.ok ? parseTracker(file.text, today) : null;
      if (!file.ok) answer = file.code;
      else if (!parsed?.ok) answer = parsed?.failure ?? "unreadable";
      else answer = { configured: true, exportedAt: new Date(file.mtimeMs).toISOString(), today, readableByOthers: file.readableByOthers, ...parsed.summary };
    } catch {
      answer = "unreadable"; // the error is dropped unread: its message could carry the path or a cell
    }
    if (typeof answer === "string") refuse(answer);
    else res.json(answer);
  });

  return router;
}
