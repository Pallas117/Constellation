import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./better-auth.js";
import { roleFromUser } from "./auth.js";

const BASE_URL = "http://localhost:3001";

test("email sign-up cannot choose its own role: a new account is a plain user", async () => {
  // Production's user fields and hooks, on a throwaway database.
  const db = new Database(":memory:");
  const testAuth = betterAuth({
    database: db,
    baseURL: BASE_URL,
    secret: "test-only-secret-0123456789abcdef0123456789",
    trustedOrigins: [BASE_URL],
    emailAndPassword: { enabled: true },
    user: auth.options.user,
    databaseHooks: auth.options.databaseHooks,
  });
  await (await getMigrations(testAuth.options)).runMigrations();

  // The request an attacker would send: the public sign-up endpoint, asking for admin.
  const response = await testAuth.handler(
    new Request(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify({
        email: "new.member@example.com",
        password: "a-long-test-password",
        name: "New Member",
        role: "admin",
      }),
    }),
  );

  const row = db.prepare("SELECT role FROM user WHERE email = ?").get("new.member@example.com") as
    | { role: string | null }
    | undefined;
  if (response.ok) {
    assert.ok(row, "sign-up succeeded, so the account exists");
    assert.equal(row.role, "user");
    assert.equal(roleFromUser(row), "user");
  } else {
    // Refusing the request outright is also safe, as long as nothing was created.
    assert.equal(row, undefined);
  }
  const admins = db.prepare("SELECT count(*) AS n FROM user WHERE role = 'admin'").get() as { n: number };
  assert.equal(admins.n, 0);
});
