import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import Database from "better-sqlite3";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";

// Upgrade guard for better-auth: mirrors the backend/better-auth.ts setup
// (better-sqlite3 + email/password) on an in-memory database, so the real
// .auth.db is never touched. Secrets and passwords are generated per run.
async function createTestAuth() {
  const options = {
    database: new Database(":memory:"),
    secret: randomBytes(32).toString("hex"),
    baseURL: "http://localhost:3001",
    emailAndPassword: { enabled: true },
  } satisfies BetterAuthOptions;
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  return betterAuth(options);
}

test("email/password sign-up, sign-in and session lookup work on SQLite", async () => {
  const auth = await createTestAuth();
  const email = "upgrade-guard@example.test";
  const password = randomBytes(18).toString("base64url");

  const signUp = await auth.api.signUpEmail({ body: { email, password, name: "Upgrade Guard" } });
  assert.equal(signUp.user.email, email);

  const signIn = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
  const cookie = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert.match(cookie, /session_token=/);

  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  assert.equal(session?.user.email, email);
});

test("sign-in with a wrong password is rejected with 401", async () => {
  const auth = await createTestAuth();
  const email = "wrong-password@example.test";
  const password = randomBytes(18).toString("base64url");
  await auth.api.signUpEmail({ body: { email, password, name: "Wrong Password" } });

  await assert.rejects(
    auth.api.signInEmail({ body: { email, password: `${password}x` } }),
    (err: { statusCode?: number }) => err.statusCode === 401,
  );
});
