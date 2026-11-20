import type Database from "better-sqlite3";
import express from "express";
import type { AuthenticatedRequest, AuthRole } from "../auth.js";

const ROLES: ReadonlySet<string> = new Set<AuthRole>(["user", "staff", "operator", "admin"]);

export interface AdminUserRow {
  id: string;
  name: string | null;
  email: string | null;
  role: AuthRole;
  passkeys: number;
  /** Whether the user has an operator pattern (backend/pattern/). */
  pattern: boolean;
}

export interface AdminUsersDeps {
  /** Clears a user's operator pattern so they set a new one; false if they had none. */
  clearPattern?: (userId: string) => Promise<boolean>;
}

function roleOf(value: unknown): AuthRole {
  const role = typeof value === "string" ? value.toLowerCase() : "";
  if (role === "viewer") return "user";
  return ROLES.has(role) ? (role as AuthRole) : "user";
}

/**
 * Admin role management at /api/admin/users (GAU-235), on the better-auth
 * database. Policy (backend/rbac.ts): listing is admin; a change is admin plus
 * a passkey touch in the last 5 minutes (step-up), checked before this router
 * runs. `npm run auth:set-role` stays the way in for the first admin.
 *
 * Guards against locking the team out: no one changes their own role here,
 * and the last admin can't be demoted. Logs carry user IDs, never emails.
 * An operator who forgets their pattern asks an admin to clear it (step-up too);
 * an admin who forgets theirs uses `npm run auth:clear-pattern -- <email>`.
 */
export function createAdminUsersRouter(db: Database.Database, deps: AdminUsersDeps = {}) {
  const router = express.Router();

  router.get("/", (_req, res) => {
    const patterns = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'operator_pattern'").get() !== undefined;
    const rows = db
      .prepare(
        `SELECT u.id, u.name, u.email, u.role,
                (SELECT count(*) FROM passkey p WHERE p.userId = u.id) AS passkeys,
                ${patterns ? "EXISTS (SELECT 1 FROM operator_pattern o WHERE o.userId = u.id)" : "0"} AS pattern
           FROM user u ORDER BY lower(u.email)`,
      )
      .all() as Array<Omit<AdminUserRow, "role" | "pattern"> & { role: unknown; pattern: number }>;
    res.json({
      users: rows.map((row) => ({ ...row, role: roleOf(row.role), passkeys: Number(row.passkeys), pattern: Boolean(row.pattern) })),
    });
  });

  router.post("/:id/pattern/clear", async (req: AuthenticatedRequest<{ id: string }>, res) => {
    const actor = req.auth?.userId;
    const target = req.params.id;
    if (!deps.clearPattern) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (target === actor) {
      res.status(409).json({ error: "Change your own pattern from your account page, or ask another admin." });
      return;
    }
    if (!db.prepare("SELECT 1 FROM user WHERE id = ?").get(target)) {
      res.status(404).json({ error: "No such user" });
      return;
    }
    const cleared = await deps.clearPattern(target);
    console.info(`[admin] ${actor} cleared the operator pattern of ${target} (passkey step-up)`);
    res.json({ id: target, cleared });
  });

  router.post("/:id/role", (req: AuthenticatedRequest<{ id: string }>, res) => {
    const actor = req.auth?.userId;
    const target = req.params.id;
    const next = typeof req.body?.role === "string" ? req.body.role.toLowerCase() : "";
    if (!ROLES.has(next)) {
      res.status(400).json({ error: "role must be user, staff, operator or admin" });
      return;
    }
    if (target === actor) {
      res.status(409).json({ error: "Ask another admin to change your own role." });
      return;
    }
    const row = db.prepare("SELECT role FROM user WHERE id = ?").get(target) as { role: unknown } | undefined;
    if (!row) {
      res.status(404).json({ error: "No such user" });
      return;
    }
    const previous = roleOf(row.role);
    const change = db.transaction(() => {
      if (previous === "admin" && next !== "admin") {
        const admins = db.prepare("SELECT count(*) AS n FROM user WHERE lower(role) = 'admin'").get() as { n: number };
        if (admins.n <= 1) return false;
      }
      db.prepare("UPDATE user SET role = ? WHERE id = ?").run(next, target);
      return true;
    });
    if (!change()) {
      res.status(409).json({ error: "Keep at least one admin." });
      return;
    }
    // Existing sessions pick the new role up on their next request (backend/auth.ts reads it per request).
    console.info(`[admin] ${actor} changed ${target} from ${previous} to ${next} (passkey step-up)`);
    res.json({ id: target, role: next, previous });
  });

  return router;
}
