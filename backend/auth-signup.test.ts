import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";

// Sign-up is invite-only (SIGNUP_ALLOWED_EMAILS, backend/sso-policy.ts). The
// list is read when backend/better-auth.ts is first imported, so set it first.
// Padding and mixed case here are part of the test.
process.env.SIGNUP_ALLOWED_EMAILS = " New.Member@Example.com , invited@example.com ";
const { auth } = await import("./better-auth.js");
const { roleFromUser } = await import("./auth.js");

const BASE_URL = "http://localhost:3001";
const SECRET = "test-only-secret-0123456789abcdef0123456789";
const PASSWORD = "a-long-test-password";

/** Production's user fields and hooks, on a throwaway database. */
async function throwawayAuth() {
  const db = new Database(":memory:");
  const testAuth = betterAuth({
    database: db,
    baseURL: BASE_URL,
    secret: SECRET,
    trustedOrigins: [BASE_URL],
    emailAndPassword: { enabled: true },
    user: auth.options.user,
    hooks: auth.options.hooks,
    databaseHooks: auth.options.databaseHooks,
  });
  await (await getMigrations(testAuth.options)).runMigrations();
  return { db, testAuth };
}

function post(testAuth: { handler: (request: Request) => Promise<Response> }, route: string, body: unknown) {
  return testAuth.handler(
    new Request(`${BASE_URL}/api/auth${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL },
      body: JSON.stringify(body),
    }),
  );
}

function userCount(db: Database.Database): number {
  return (db.prepare("SELECT count(*) AS n FROM user").get() as { n: number }).n;
}

test("email sign-up cannot choose its own role: a new account is a plain user", async () => {
  const { db, testAuth } = await throwawayAuth();

  // The request an attacker would send: the public sign-up endpoint, asking for
  // admin. The address is invited, so only the role guard stands in the way.
  const response = await post(testAuth, "/sign-up/email", {
    email: "new.member@example.com",
    password: PASSWORD,
    name: "New Member",
    role: "admin",
  });

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

test("email sign-up is invite-only: an invited address gets an account with the role user", async () => {
  const { db, testAuth } = await throwawayAuth();

  const response = await post(testAuth, "/sign-up/email", {
    email: "invited@example.com",
    password: PASSWORD,
    name: "Invited",
  });

  assert.equal(response.status, 200);
  const row = db.prepare("SELECT role FROM user WHERE email = ?").get("invited@example.com") as
    | { role: string | null }
    | undefined;
  assert.ok(row, "the invited address has an account");
  assert.equal(roleFromUser(row), "user");
});

test("email sign-up is invite-only: an address off the list gets 403 and no account row", async () => {
  const { db, testAuth } = await throwawayAuth();

  for (const email of [
    "stranger@example.com",
    "invited@example.com.evil.io",
    "someone@lightbound.uk", // the SSO domain does not open email sign-up
  ]) {
    const response = await post(testAuth, "/sign-up/email", { email, password: PASSWORD, name: "Stranger" });
    assert.equal(response.status, 403, email);
    const text = await response.text();
    assert.match(text, /invitation only/);
    assert.equal(text.includes(email), false, "the refusal does not echo the address");
  }
  // A body without a usable email is refused too, never created.
  const noEmail = await post(testAuth, "/sign-up/email", { password: PASSWORD, name: "Nobody" });
  assert.equal(noEmail.status, 403);

  assert.equal(userCount(db), 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM account").get() as { n: number }).n, 0);
});

test("email sign-up allowlist ignores case and surrounding whitespace", async () => {
  const { db, testAuth } = await throwawayAuth();

  // Listed as " New.Member@Example.com "; requested in another case.
  const response = await post(testAuth, "/sign-up/email", {
    email: "NEW.MEMBER@example.COM",
    password: PASSWORD,
    name: "New Member",
  });

  assert.equal(response.status, 200);
  const rows = db.prepare("SELECT role FROM user WHERE lower(email) = ?").all("new.member@example.com") as {
    role: string | null;
  }[];
  assert.equal(rows.length, 1);
  assert.equal(roleFromUser(rows[0]), "user");
});

test("invite-only sign-up leaves existing accounts able to sign in", async () => {
  const { db, testAuth } = await throwawayAuth();
  // An account from before the rule, whose address is not on the list: made
  // through the same database without the sign-up hooks.
  const before = betterAuth({
    database: db,
    baseURL: BASE_URL,
    secret: SECRET,
    trustedOrigins: [BASE_URL],
    emailAndPassword: { enabled: true },
    user: auth.options.user,
  });
  const legacy = { email: "legacy@example.com", password: PASSWORD };
  assert.equal((await post(before, "/sign-up/email", { ...legacy, name: "Legacy" })).status, 200);

  const signIn = await post(testAuth, "/sign-in/email", legacy);
  assert.equal(signIn.status, 200);
  assert.match(signIn.headers.getSetCookie().join("; "), /session_token=/);

  // Signing up again with that address is still refused, and adds nothing.
  assert.equal((await post(testAuth, "/sign-up/email", { ...legacy, name: "Legacy" })).status, 403);
  assert.equal(userCount(db), 1);
});

test("the user.create hook refuses an uninvited sign-up on its own, without the before-hook", async () => {
  // Production's databaseHooks only: no hooks.before middleware, so the
  // refusal below comes from user.create, where the row is written.
  const db = new Database(":memory:");
  const hookOnly = betterAuth({
    database: db,
    baseURL: BASE_URL,
    secret: SECRET,
    trustedOrigins: [BASE_URL],
    emailAndPassword: { enabled: true },
    user: auth.options.user,
    databaseHooks: auth.options.databaseHooks,
  });
  await (await getMigrations(hookOnly.options)).runMigrations();

  for (const email of ["stranger@example.com", "invited+x@example.com", "someone@lightbound.uk"]) {
    const response = await post(hookOnly, "/sign-up/email", { email, password: PASSWORD, name: "Stranger" });
    assert.equal(response.ok, false, email);
    assert.equal((await response.text()).includes(email), false, "the refusal does not echo the address");
  }
  assert.equal(userCount(db), 0);
  assert.equal((db.prepare("SELECT count(*) AS n FROM account").get() as { n: number }).n, 0);

  // The invited address still gets its account through the hook alone.
  const invited = await post(hookOnly, "/sign-up/email", { email: "invited@example.com", password: PASSWORD, name: "Invited" });
  assert.equal(invited.status, 200);
  assert.equal(userCount(db), 1);
});
