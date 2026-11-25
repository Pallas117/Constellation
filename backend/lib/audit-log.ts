/**
 * Append-only audit log (Zone E, first step): who did what, to what, with which result.
 *
 * - SQLite in its own file (default `data/audit/audit.db`, `AUDIT_DB_PATH` overrides), never `.auth.db`.
 *   Uses Node's built-in `node:sqlite` (no new dependency, no native build).
 * - Each row stores the previous row's hash and its own SHA-256 over (previous hash + its fields), so an
 *   edited, inserted or removed middle row breaks the chain and `verify()` names the first bad row.
 *   Removing rows from the END is not detectable from the file alone (see open risk in the PR).
 * - UPDATE and DELETE are refused by triggers; the class has no update or delete method.
 * - The writer copies only the fixed fields below. Request bodies, emails, session tokens and other
 *   secrets are never stored: callers pass ids and short labels, and anything else is dropped.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type AuditResult = "ok" | "denied" | "failed";
const RESULTS: ReadonlySet<string> = new Set<AuditResult>(["ok", "denied", "failed"]);

/** The fields a caller may record. Anything else on the object passed in is ignored. */
export interface AuditEntryInput {
  /** better-auth user id of the actor (not the email). */
  actorId: string | null;
  /** Role the actor had at the time (user/staff/operator/admin). */
  role: string | null;
  /** Dotted action name, e.g. `cybertiger.block`. */
  action: string;
  /** What the action was applied to: an id or a pseudonymised label, never free text or a body. */
  target: string | null;
  result: AuditResult;
  /** CyberTiger request id (`x-request-id`), to join with the security event stream. */
  requestId: string | null;
}

export interface AuditRow extends AuditEntryInput {
  seq: number;
  /** ISO 8601 UTC. */
  time: string;
  prevHash: string;
  rowHash: string;
}

export type AuditVerifyResult = { ok: true; rows: number } | { ok: false; rows: number; firstBadSeq: number; reason: string };

export const AUDIT_GENESIS_HASH = "0".repeat(64);

const ACTION_RE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+){0,4}$/;
const ID_RE = /^[A-Za-z0-9_.:@/-]{1,128}$/;
const ROLE_RE = /^[a-z]{1,16}$/;

function checked(value: string | null | undefined, re: RegExp, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !re.test(value)) {
    throw new TypeError(`audit: invalid ${field}`);
  }
  return value;
}

/** Hash input: the previous hash and the fields in a fixed order, JSON-encoded so separators can't be forged. */
export function auditRowHash(prevHash: string, row: Omit<AuditRow, "prevHash" | "rowHash">): string {
  const canonical = JSON.stringify([
    prevHash,
    row.seq,
    row.time,
    row.actorId,
    row.role,
    row.action,
    row.target,
    row.result,
    row.requestId,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** Pseudonymous label for an IP address target (SHA-256 prefix), so the log holds no raw client addresses. */
export function ipTarget(ip: string): string {
  return `ip:${createHash("sha256").update(ip.trim()).digest("hex").slice(0, 16)}`;
}

interface DbRow {
  seq: number;
  time: string;
  actor_id: string | null;
  role: string | null;
  action: string;
  target: string | null;
  result: string;
  request_id: string | null;
  prev_hash: string;
  row_hash: string;
}

const toRow = (r: DbRow): AuditRow => ({
  seq: Number(r.seq),
  time: r.time,
  actorId: r.actor_id,
  role: r.role,
  action: r.action,
  target: r.target,
  result: r.result as AuditResult,
  requestId: r.request_id,
  prevHash: r.prev_hash,
  rowHash: r.row_hash,
});

export class AuditLog {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.now = now;
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS audit_log (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        time       TEXT NOT NULL,
        actor_id   TEXT,
        role       TEXT,
        action     TEXT NOT NULL,
        target     TEXT,
        result     TEXT NOT NULL CHECK (result IN ('ok', 'denied', 'failed')),
        request_id TEXT,
        prev_hash  TEXT NOT NULL,
        row_hash   TEXT NOT NULL UNIQUE
      );
      CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
        BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    `);
  }

  /** The one writer. Validates the fields, links the row to the previous one and stores it. */
  append(input: AuditEntryInput): AuditRow {
    const action = checked(input.action, ACTION_RE, "action");
    if (!action || action.length > 64) throw new TypeError("audit: invalid action");
    if (!RESULTS.has(input.result)) throw new TypeError("audit: invalid result");
    const fields = {
      actorId: checked(input.actorId, ID_RE, "actorId"),
      role: checked(input.role, ROLE_RE, "role"),
      action,
      target: checked(input.target, ID_RE, "target"),
      result: input.result,
      requestId: checked(input.requestId, ID_RE, "requestId"),
    };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db.prepare("SELECT seq, row_hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as
        | { seq: number; row_hash: string }
        | undefined;
      const prevHash = last?.row_hash ?? AUDIT_GENESIS_HASH;
      const seq = last ? Number(last.seq) + 1 : 1;
      const time = this.now().toISOString();
      const rowHash = auditRowHash(prevHash, { seq, time, ...fields });
      this.db
        .prepare(
          `INSERT INTO audit_log (seq, time, actor_id, role, action, target, result, request_id, prev_hash, row_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(seq, time, fields.actorId, fields.role, fields.action, fields.target, fields.result, fields.requestId, prevHash, rowHash);
      this.db.exec("COMMIT");
      return { seq, time, ...fields, prevHash, rowHash };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Newest first, capped at 1000 rows. */
  recent(limit = 100): AuditRow[] {
    const n = Math.max(1, Math.min(Math.trunc(limit) || 1, 1000));
    return (this.db.prepare("SELECT * FROM audit_log ORDER BY seq DESC LIMIT ?").all(n) as unknown as DbRow[]).map(toRow);
  }

  /** Walks the whole chain in order; reports the first row whose link, hash or sequence is wrong. */
  verify(): AuditVerifyResult {
    let prev = AUDIT_GENESIS_HASH;
    let expectedSeq = 1;
    let rows = 0;
    for (const raw of this.db.prepare("SELECT * FROM audit_log ORDER BY seq ASC").iterate() as Iterable<DbRow>) {
      const row = toRow(raw);
      rows += 1;
      const bad = (reason: string): AuditVerifyResult => ({ ok: false, rows, firstBadSeq: row.seq, reason });
      if (row.seq !== expectedSeq) return bad("sequence gap");
      if (row.prevHash !== prev) return bad("previous hash does not match");
      if (auditRowHash(prev, row) !== row.rowHash) return bad("row hash does not match its fields");
      prev = row.rowHash;
      expectedSeq += 1;
    }
    return { ok: true, rows };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Records an action without ever breaking the request it belongs to: a failed write is logged by
 * error name only (no fields, which could hold ids) and the caller carries on.
 */
export function recordAudit(log: AuditLog | null, entry: AuditEntryInput): void {
  if (!log) return;
  try {
    log.append(entry);
  } catch (error) {
    console.error(`[audit] write failed (${error instanceof Error ? error.name : "unknown"}) for ${entry.action}`);
  }
}
