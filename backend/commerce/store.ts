import Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPlan, type Plan } from "./plans.js";

export interface Org {
  id: string;
  name: string;
  plan: Plan;
  createdAt: string;
}

export interface ApiKeyInfo {
  id: string;
  orgId: string;
  name: string;
  /** Shown in UIs so people can tell keys apart; not enough to use the key. */
  prefix: string;
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export type PilotInterest = "data-api" | "connectivity" | "both";

export interface PilotRequest {
  id: string;
  name: string;
  email: string;
  company: string;
  interest: PilotInterest;
  useCase: string;
  createdAt: string;
}

export interface UsageRow {
  day: string;
  keyId: string;
  endpoint: string;
  count: number;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const nowIso = () => new Date().toISOString();

/**
 * Organisations, their plans and members, API keys (stored only as SHA-256),
 * and per-key daily usage. SQLite, separate from the auth database.
 */
export class CommerceStore {
  private db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    }
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orgs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        plan TEXT NOT NULL CHECK (plan IN ('free','pilot','enterprise')),
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS org_members (
        org_id TEXT NOT NULL REFERENCES orgs(id), user_id TEXT NOT NULL,
        PRIMARY KEY (org_id, user_id));
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL REFERENCES orgs(id), name TEXT NOT NULL,
        prefix TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS pilot_requests (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, company TEXT NOT NULL,
        interest TEXT NOT NULL, use_case TEXT NOT NULL, ip_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (
        day TEXT NOT NULL, key_id TEXT NOT NULL REFERENCES api_keys(id), endpoint TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, key_id, endpoint));
    `);
  }

  // ---- organisations ----

  createOrg(name: string, plan: Plan): Org {
    const org = { id: randomUUID(), name: name.trim(), plan, createdAt: nowIso() };
    this.db.prepare("INSERT INTO orgs (id, name, plan, created_at) VALUES (?, ?, ?, ?)").run(org.id, org.name, org.plan, org.createdAt);
    return org;
  }

  getOrg(id: string): Org | undefined {
    const row = this.db.prepare("SELECT id, name, plan, created_at FROM orgs WHERE id = ?").get(id) as
      | { id: string; name: string; plan: string; created_at: string }
      | undefined;
    return row && isPlan(row.plan) ? { id: row.id, name: row.name, plan: row.plan, createdAt: row.created_at } : undefined;
  }

  listOrgs(): Org[] {
    return (this.db.prepare("SELECT id FROM orgs ORDER BY name").all() as { id: string }[])
      .map((r) => this.getOrg(r.id))
      .filter((o): o is Org => Boolean(o));
  }

  setPlan(orgId: string, plan: Plan): boolean {
    return this.db.prepare("UPDATE orgs SET plan = ? WHERE id = ?").run(plan, orgId).changes === 1;
  }

  addMember(orgId: string, userId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO org_members (org_id, user_id) VALUES (?, ?)").run(orgId, userId);
  }

  removeMember(orgId: string, userId: string): boolean {
    return this.db.prepare("DELETE FROM org_members WHERE org_id = ? AND user_id = ?").run(orgId, userId).changes === 1;
  }

  isMember(orgId: string, userId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ?").get(orgId, userId));
  }

  orgsFor(userId: string): Org[] {
    return (this.db.prepare("SELECT org_id FROM org_members WHERE user_id = ?").all(userId) as { org_id: string }[])
      .map((r) => this.getOrg(r.org_id))
      .filter((o): o is Org => Boolean(o));
  }

  // ---- API keys ----

  /** Returns the plain key exactly once; only its hash is stored. */
  createKey(orgId: string, name: string, createdBy: string): { key: string; info: ApiKeyInfo } {
    const id = randomUUID();
    const prefix = randomBytes(4).toString("hex");
    const key = `gk_${prefix}_${randomBytes(32).toString("base64url")}`;
    const info: ApiKeyInfo = {
      id,
      orgId,
      name: name.trim().slice(0, 80) || "API key",
      prefix: `gk_${prefix}`,
      createdBy,
      createdAt: nowIso(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.db
      .prepare("INSERT INTO api_keys (id, org_id, name, prefix, key_hash, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, orgId, info.name, info.prefix, hash(key), createdBy, info.createdAt);
    return { key, info };
  }

  listKeys(orgId: string): ApiKeyInfo[] {
    return (
      this.db
        .prepare("SELECT id, org_id, name, prefix, created_by, created_at, last_used_at, revoked_at FROM api_keys WHERE org_id = ? ORDER BY created_at")
        .all(orgId) as Array<Record<string, string | null>>
    ).map((r) => ({
      id: r.id!,
      orgId: r.org_id!,
      name: r.name!,
      prefix: r.prefix!,
      createdBy: r.created_by!,
      createdAt: r.created_at!,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
    }));
  }

  revokeKey(orgId: string, keyId: string): boolean {
    return (
      this.db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND org_id = ? AND revoked_at IS NULL").run(nowIso(), keyId, orgId).changes === 1
    );
  }

  /** The active key and its organisation, or undefined for unknown/revoked keys. */
  resolveKey(raw: string): { keyId: string; org: Org } | undefined {
    if (!/^gk_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/.test(raw)) return undefined;
    const row = this.db.prepare("SELECT id, org_id FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL").get(hash(raw)) as
      | { id: string; org_id: string }
      | undefined;
    const org = row ? this.getOrg(row.org_id) : undefined;
    return row && org ? { keyId: row.id, org } : undefined;
  }

  // ---- pilot requests (leads from the public landing page) ----

  /** The requester's IP is kept only as a hash, for abuse checks. */
  addPilotRequest(input: Omit<PilotRequest, "id" | "createdAt">, ip: string): PilotRequest {
    const request = { ...input, id: randomUUID(), createdAt: nowIso() };
    this.db
      .prepare("INSERT INTO pilot_requests (id, name, email, company, interest, use_case, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(request.id, request.name, request.email, request.company, request.interest, request.useCase, hash(ip), request.createdAt);
    return request;
  }

  listPilotRequests(): PilotRequest[] {
    return (
      this.db.prepare("SELECT id, name, email, company, interest, use_case, created_at FROM pilot_requests ORDER BY created_at DESC").all() as Array<
        Record<string, string>
      >
    ).map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      company: r.company,
      interest: r.interest as PilotInterest,
      useCase: r.use_case,
      createdAt: r.created_at,
    }));
  }

  // ---- usage metering ----

  recordUse(keyId: string, endpoint: string, at = new Date()): void {
    const day = at.toISOString().slice(0, 10);
    this.db
      .prepare(
        "INSERT INTO usage (day, key_id, endpoint, count) VALUES (?, ?, ?, 1) ON CONFLICT(day, key_id, endpoint) DO UPDATE SET count = count + 1",
      )
      .run(day, keyId, endpoint);
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(at.toISOString(), keyId);
  }

  /** Requests made today (UTC) by all of an organisation's keys: the daily quota counter. */
  orgUsageOn(orgId: string, day: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(u.count), 0) AS n FROM usage u JOIN api_keys k ON k.id = u.key_id WHERE k.org_id = ? AND u.day = ?")
      .get(orgId, day) as { n: number };
    return row.n;
  }

  /** Per-day, per-key, per-endpoint counts for invoicing and pilot evidence. Days are inclusive YYYY-MM-DD. */
  usage(orgId: string, fromDay: string, toDay: string): UsageRow[] {
    return (
      this.db
        .prepare(
          "SELECT u.day, u.key_id, u.endpoint, u.count FROM usage u JOIN api_keys k ON k.id = u.key_id WHERE k.org_id = ? AND u.day BETWEEN ? AND ? ORDER BY u.day, u.key_id, u.endpoint",
        )
        .all(orgId, fromDay, toDay) as Array<{ day: string; key_id: string; endpoint: string; count: number }>
    ).map((r) => ({ day: r.day, keyId: r.key_id, endpoint: r.endpoint, count: r.count }));
  }
}
