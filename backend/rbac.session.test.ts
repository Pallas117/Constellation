import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";
import type { AuthRole } from "./auth.js";

// End to end over real sessions: sign in through better-auth, then call
// role-gated routes over HTTP (session cookie -> auth.api.getSession ->
// roleFromUser -> enforceApiPolicy). In process only: a throwaway auth database
// (never .auth.db) and an ephemeral loopback port (never the live backend on
// :3001). No x-forwarded-for, so CyberTiger sees a direct local client and
// never auto-blocks on the 401/403s below.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gauss-rbac-session-"));
const ORIGIN = "http://localhost:8080"; // trusted by CORS and better-auth's origin check
process.env.AUTH_DB_PATH = path.join(tmp, "auth.db");
process.env.AUTH_REQUIRED = "true";
process.env.ALLOWED_ORIGINS = ORIGIN;
process.env.BETTER_AUTH_SECRET = "test-only-secret-0123456789abcdef0123456789";
// POST /api/ai/nowcast/train runs `python3 <TRAINING_SCRIPT_PATH>`: an empty
// file here, so the admin call starts no real training.
process.env.TRAINING_SCRIPT_PATH = path.join(tmp, "noop.py");
fs.writeFileSync(process.env.TRAINING_SCRIPT_PATH, "");

// Both read the environment above when first imported.
const { auth } = await import("./better-auth.js");
const { startBackend, stopBackend } = await import("./server.js");

const ROLES: AuthRole[] = ["user", "staff", "operator", "admin"];
const PASSWORD = "a-long-test-password";
const USER_ROUTE = "/api/feed/sources/status"; // user; echoes the caller's userId and role
const OPERATOR_ROUTE = "/api/rag/query"; // operator; an empty query is a 400 before the memory service
const ADMIN_ROUTE = "/api/ai/nowcast/train"; // admin

type Session = { email: string; userId: string; cookie: string };
const sessions = {} as Record<AuthRole, Session>;
let base = "";
let db: Database.Database;

function call(method: string, route: string, cookie?: string, body?: unknown) {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

/** The same UPDATE `npm run auth:set-role` runs. */
function setRole(email: string, role: AuthRole) {
  assert.equal(db.prepare("UPDATE user SET role = ? WHERE lower(email) = lower(?)").run(role, email).changes, 1);
}

before(async () => {
  await (await getMigrations(auth.options)).runMigrations();
  db = new Database(process.env.AUTH_DB_PATH);
  const { port } = await startBackend({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${port}`;

  for (const role of ROLES) {
    const email = `${role}@example.com`;
    const signUp = await call("POST", "/api/auth/sign-up/email", undefined, { email, password: PASSWORD, name: role });
    assert.equal(signUp.status, 200, `sign-up ${role}: ${await signUp.text()}`);
    setRole(email, role);

    const signIn = await call("POST", "/api/auth/sign-in/email", undefined, { email, password: PASSWORD });
    assert.equal(signIn.status, 200, `sign-in ${role}: ${await signIn.text()}`);
    const cookie = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    assert.match(cookie, /session_token=/, `sign-in ${role} set no session cookie`);
    const { id } = db.prepare("SELECT id FROM user WHERE email = ?").get(email) as { id: string };
    sessions[role] = { email, userId: id, cookie };
  }
});

after(async () => {
  await stopBackend();
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("real sessions: no session, or a tampered session cookie, is 401 on a user route", async () => {
  assert.equal((await call("GET", USER_ROUTE)).status, 401);
  const tampered = sessions.admin.cookie.replace(/session_token=[^.;]+/, "session_token=forged");
  assert.notEqual(tampered, sessions.admin.cookie);
  assert.equal((await call("GET", USER_ROUTE, tampered)).status, 401);
});

test("real sessions: every role's session reaches a user route as that user and role", async () => {
  for (const role of ROLES) {
    const response = await call("GET", USER_ROUTE, sessions[role].cookie);
    assert.equal(response.status, 200, role);
    const body = (await response.json()) as { auth: { userId: string | null; role: string | null } };
    assert.deepEqual(body.auth, { userId: sessions[role].userId, role });
  }
});

test("real sessions: an operator route refuses user and staff and admits operator and admin", async () => {
  for (const role of ["user", "staff"] as const) {
    assert.equal((await call("POST", OPERATOR_ROUTE, sessions[role].cookie, {})).status, 403, role);
  }
  // 400 "Missing query": past the policy, rejected by the handler itself.
  for (const role of ["operator", "admin"] as const) {
    assert.equal((await call("POST", OPERATOR_ROUTE, sessions[role].cookie, {})).status, 400, role);
  }
});

test("real sessions: an admin route refuses operator and below and admits admin", async () => {
  for (const role of ["user", "staff", "operator"] as const) {
    assert.equal((await call("POST", ADMIN_ROUTE, sessions[role].cookie)).status, 403, role);
  }
  const response = await call("POST", ADMIN_ROUTE, sessions.admin.cookie);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { started: boolean }).started, true);
});

test("real sessions: a demotion applies to an existing session on its next request", async () => {
  setRole(sessions.admin.email, "staff");
  try {
    assert.equal((await call("POST", ADMIN_ROUTE, sessions.admin.cookie)).status, 403);
    assert.equal((await call("POST", OPERATOR_ROUTE, sessions.admin.cookie, {})).status, 403);
  } finally {
    setRole(sessions.admin.email, "admin");
  }
});

test("real sessions: signing out ends the session", async () => {
  const { cookie } = sessions.operator;
  assert.equal((await call("POST", "/api/auth/sign-out", cookie, {})).status, 200);
  assert.equal((await call("GET", USER_ROUTE, cookie)).status, 401);
});
