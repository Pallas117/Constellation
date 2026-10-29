import type { ArchiveResult } from "./local-db.js";

/**
 * Scheduled telemetry retention (GAU-157 follow-up). Josh 2026-10-29: keep about 3 days live
 * (40,000 lines at ~13,000 a day) and keep every archive. Runs inside the backend because
 * archiveOld's lock is in-process: a separate job could lose lines appended during the swap.
 *
 *   GAUSS_TELEMETRY_KEEP_LINES      lines left in telemetry.jsonl (default 40000, floor 25000:
 *                                   the restart reload reads up to 20,000)
 *   GAUSS_TELEMETRY_ARCHIVE_HOURS   hours between runs (default 24; 0 turns retention off)
 */
export interface RetentionConfig {
  keepLines: number;
  everyMs: number;
  firstDelayMs: number;
}

export const RETENTION_KEEP_LINES = 40_000;
export const RETENTION_MIN_KEEP_LINES = 25_000;
const HOUR_MS = 60 * 60 * 1000;

export function retentionFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionConfig {
  const keep = Number(env.GAUSS_TELEMETRY_KEEP_LINES ?? RETENTION_KEEP_LINES);
  const hours = Number(env.GAUSS_TELEMETRY_ARCHIVE_HOURS ?? 24);
  return {
    keepLines: Math.max(RETENTION_MIN_KEEP_LINES, Number.isFinite(keep) ? Math.floor(keep) : RETENTION_KEEP_LINES),
    everyMs: Number.isFinite(hours) && hours > 0 ? hours * HOUR_MS : 0,
    // Not at boot: a restart (deploy, failover) should come up first; the trim can wait.
    firstDelayMs: 10 * 60 * 1000,
  };
}

interface Archiver {
  archiveOld(keepLines: number): Promise<ArchiveResult>;
}

interface Log {
  log(msg: string): void;
  error(msg: string, err?: unknown): void;
}

/** Starts the schedule; returns a stop function. With everyMs 0 it does nothing. */
export function startTelemetryRetention(db: Archiver, cfg: RetentionConfig, log: Log = console): () => void {
  if (cfg.everyMs <= 0) return () => {};
  let running = false;
  let interval: NodeJS.Timeout | null = null;
  const run = async () => {
    if (running) return; // a slow run (first one streams the whole backlog) is never doubled
    running = true;
    try {
      const r = await db.archiveOld(cfg.keepLines);
      if (r.archivedLines > 0) {
        log.log(`[retention] archived ${r.archivedLines} telemetry lines to ${r.archive}; ${r.keptLines} kept`);
      }
    } catch (err) {
      // The live file is untouched on failure (archiveTelemetry verifies before swapping).
      log.error("[retention] telemetry archive failed; live file unchanged", err);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => {
    void run();
    interval = setInterval(() => void run(), cfg.everyMs);
    interval.unref();
  }, cfg.firstDelayMs);
  first.unref();
  return () => {
    clearTimeout(first);
    if (interval) clearInterval(interval);
  };
}
