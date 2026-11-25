import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import Database from "better-sqlite3";
import { getMigrations } from "better-auth/db/migration";

// Threat model TM-01, through the real server: password sign-in behind CyberTiger and the per-account backoff
// (backend/auth-backoff.ts). In process only: a throwaway auth database (never .auth.db) and an ephemeral loopback
// port (never the live backend on :3001). The test talks over loopback; X-Forwarded-For (trusted from a loopback
// peer, as from the local proxy) makes a request an outside address, and no X-Forwarded-For is a direct local caller.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gauss-auth-backoff-"));
const ORIGIN = "http://localhost:8080"; // trusted by CORS and better-auth's origin check
process.env.AUTH_DB_PATH = path.join(tmp, "auth.db");
process.env.AUTH_REQUIRED = "true";
process.env.ALLOWED_ORIGINS = ORIGIN;
process.env.BETTER_AUTH_SECRET = "test-only-secret-0123456789abcdef0123456789";

// Both read the environment above when first imported.
const { auth } = await import("./better-auth.js");
const { DIRECT_LOCAL_HEADER } = await import("./auth-backoff.js");
const { startBackend, stopBackend } = await import("./server.js");

const PASSWORD = "a-long-test-password";
const UNPAUSE = "/api/security/account-backoff/unpause";
const SIGN_IN = "/api/auth/sign-in/email";
let base = "";
let db: Database.Database;
const cookies: Record<string, string> = {};

function call(method: string, route: string, opts: { from?: string; cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json", ...opts.headers };
  if (opts.from) headers["x-forwarded-for"] = opts.from;
  if (opts.cookie) headers.cookie = opts.cookie;
  return fetch(`${base}${route}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}

const signIn = (email: string, password: string, from?: string, headers?: Record<string, string>) =>
  call("POST", SIGN_IN, { from, headers, body: { email, password } });

before(async () => {
  await (await getMigrations(auth.options)).runMigrations();
  db = new Database(process.env.AUTH_DB_PATH);
  const { port } = await startBackend({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${port}`;

  // Accounts are made from the machine itself (a direct local caller), like the owner's console.
  for (const name of ["admin", "user", "owner"]) {
    const email = `${name}@example.com`;
    const signUp = await call("POST", "/api/auth/sign-up/email", { body: { email, password: PASSWORD, name } });
    assert.equal(signUp.status, 200, `sign-up ${name}: ${await signUp.text()}`);
  }
  // The same UPDATE `npm run auth:set-role` runs.
  assert.equal(db.prepare("UPDATE user SET role = 'admin' WHERE email = ?").run("admin@example.com").changes, 1);
  for (const name of ["admin", "user"]) {
    const r = await signIn(`${name}@example.com`, PASSWORD);
    assert.equal(r.status, 200, `sign-in ${name}: ${await r.text()}`);
    cookies[name] = r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    assert.match(cookies[name], /session_token=/, `sign-in ${name} set no session cookie`);
  }
});

after(async () => {
  await stopBackend();
  db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("wrong-password sign-ins from an outside address count toward CyberTiger's IP block, and the account pause's 429s do not", async () => {
  const guesser = "203.0.113.10";
  const bystander = "203.0.113.11";
  const victim = "victim@example.com"; // no such account: the pause works the same

  // Five wrong passwords for one email: four from the guesser, one from another address. Each is a 401.
  for (let i = 0; i < 4; i++) assert.equal((await signIn(victim, `guess-${i}`, guesser)).status, 401, `guess ${i + 1}`);
  assert.equal((await signIn(victim, "guess-4", "203.0.113.12")).status, 401);

  // The email is now paused. The bystander's tries get the backoff's 429 with Retry-After, not a 401.
  for (let i = 0; i < 4; i++) {
    const paused = await signIn(victim, PASSWORD, bystander);
    assert.equal(paused.status, 429);
    assert.match(paused.headers.get("retry-after") ?? "", /^[1-9]\d*$/, "Retry-After in whole seconds");
    const text = JSON.stringify(await paused.json());
    assert.match(text, /Too many failed sign-ins/);
    assert.doesNotMatch(text, /CyberTiger|passkey/i);
  }

  // The guesser's four sign-in 401s were counted: three more 401s leave it one short of the eight that block...
  const signedOut = (from: string) => call("GET", "/api/auth/list-sessions", { from });
  const reachable = (from: string) => call("GET", "/api/auth/get-session", { from });
  for (let i = 0; i < 3; i++) assert.equal((await signedOut(guesser)).status, 401);
  assert.equal((await reachable(guesser)).status, 200, "seven failures: not blocked yet");
  // ...and the eighth blocks the address, on /api/auth and /api alike.
  assert.equal((await signedOut(guesser)).status, 401);
  const blocked = await reachable(guesser);
  assert.equal(blocked.status, 429);
  assert.match(JSON.stringify(await blocked.json()), /CyberTiger/);
  assert.equal((await signIn(victim, "guess-5", guesser)).status, 429, "a blocked address can't keep guessing");

  // The bystander's four 429s were not counted as failures: it still has all eight before a block.
  for (let i = 0; i < 7; i++) assert.equal((await signedOut(bystander)).status, 401);
  assert.equal((await reachable(bystander)).status, 200, "seven failures of its own: the 429s added none");
  assert.equal((await signedOut(bystander)).status, 401);
  assert.equal((await reachable(bystander)).status, 429);
});

test("a paused account: the owner on the machine itself still signs in, a client can't claim to be local, and only an admin can unpause", async () => {
  const owner = "owner@example.com";
  // One wrong password from each of five outside addresses pauses the owner's password sign-in.
  for (let i = 1; i <= 5; i++) assert.equal((await signIn(owner, `guess-${i}`, `198.51.100.${i}`)).status, 401);
  assert.equal((await signIn(owner, PASSWORD, "198.51.100.6")).status, 429, "paused for outside addresses, even with the right password");

  // An outside client sending the server's own "local" marker is still paused: the server overwrites it.
  const spoofed = await signIn(owner, PASSWORD, "198.51.100.7", { [DIRECT_LOCAL_HEADER]: "1" });
  assert.equal(spoofed.status, 429, "a client-sent header is never trusted");

  // The owner at the machine (direct local caller, CyberTiger's rule) is not paused.
  assert.equal((await signIn(owner, PASSWORD)).status, 200);
  assert.equal((await signIn(owner, PASSWORD, "198.51.100.8")).status, 429, "and that did not lift the pause for outside addresses");

  // Unpause is admin only: no session 401, a user 403, a bad body 400.
  assert.equal((await call("POST", UNPAUSE, { body: { email: owner } })).status, 401);
  assert.equal((await call("POST", UNPAUSE, { cookie: cookies.user, body: { email: owner } })).status, 403);
  assert.equal((await signIn(owner, PASSWORD, "198.51.100.9")).status, 429, "still paused after the refused tries");
  assert.equal((await call("POST", UNPAUSE, { cookie: cookies.admin, body: {} })).status, 400);
  assert.equal((await call("POST", UNPAUSE, { cookie: cookies.admin, body: { email: "x".repeat(321) } })).status, 400);

  const cleared = await call("POST", UNPAUSE, { cookie: cookies.admin, body: { email: owner } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { ok: true, cleared: true });
  assert.equal((await signIn(owner, PASSWORD, "198.51.100.10")).status, 200, "the owner can sign in from outside again");
  const again = await call("POST", UNPAUSE, { cookie: cookies.admin, body: { email: owner } });
  assert.deepEqual(await again.json(), { ok: true, cleared: false }, "nothing left to clear");
});
