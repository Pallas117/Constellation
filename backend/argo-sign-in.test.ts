import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "./better-auth.js";
import { roleFromUser } from "./auth.js";
import { argoSignIn, nameFromEmail, safeCallback, type AccessEnv } from "./argo-sign-in.js";
// The website's stand-in for Cloudflare Access: a local key pair that signs the JWT Access would send.
import { makeAccess } from "../website/test/fixtures/access.mjs";

const BASE_URL = "http://localhost:3001";

async function setup(env?: AccessEnv) {
  const access = await makeAccess();
  const db = new Database(":memory:");
  const testAuth = betterAuth({
    database: db,
    baseURL: BASE_URL,
    secret: "test-only-secret-0123456789abcdef0123456789",
    trustedOrigins: [BASE_URL],
    emailAndPassword: { enabled: true },
    user: auth.options.user,
    databaseHooks: auth.options.databaseHooks,
    plugins: [argoSignIn(env ?? access.env)],
  });
  await (await getMigrations(testAuth.options)).runMigrations();
  const signIn = (headers: Record<string, string> = {}, callback = "/operator") =>
    testAuth.handler(new Request(`${BASE_URL}/api/auth/argo/sign-in?callbackURL=${encodeURIComponent(callback)}`, { headers }));
  return { access, db, testAuth, signIn };
}

const users = (db: Database.Database) => db.prepare("SELECT email, role, emailVerified FROM user").all() as { email: string; role: string; emailVerified: number }[];

test("argo sign-in: a valid Access token starts a session and creates a plain user", async () => {
  const { access, db, testAuth, signIn } = await setup();
  const res = await signIn({ "cf-access-jwt-assertion": await access.sign("Ada.Lovelace@Example.test") });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/operator");
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, /better-auth\.session_token=/);
  assert.match(cookie, /HttpOnly/i);
  const [row] = users(db);
  assert.equal(row?.email, "ada.lovelace@example.test", "email lowercased");
  assert.equal(row?.role, "user", "starts at the lowest role");
  assert.equal(roleFromUser(row!), "user");
  assert.equal(row?.emailVerified, 1, "Access checked the address");
  // The cookie is an ordinary better-auth session: the app's own session lookup accepts it.
  const session = await testAuth.api.getSession({ headers: new Headers({ cookie: cookie.split(";")[0]! }) });
  assert.equal(session?.user.email, "ada.lovelace@example.test");
});

test("argo sign-in: an existing account keeps its role and is not duplicated", async () => {
  const { access, db, signIn } = await setup();
  await signIn({ "cf-access-jwt-assertion": await access.sign("op@example.test") });
  db.prepare("UPDATE user SET role = 'operator' WHERE email = ?").run("op@example.test");
  const res = await signIn({ "cf-access-jwt-assertion": await access.sign("op@example.test") });
  assert.equal(res.status, 302);
  assert.deepEqual(users(db).map((u) => [u.email, u.role]), [["op@example.test", "operator"]]);
});

test("argo sign-in: no session without a valid token", async () => {
  const { access, db, signIn } = await setup();
  const other = await makeAccess({ kid: "dev" }); // same kid, different key: a forged signature
  const now = Math.floor(Date.now() / 1000);
  const cases: [string, Record<string, string>][] = [
    ["no token", {}],
    ["bare email header", { "cf-access-authenticated-user-email": "boss@example.test" }],
    ["forged signature", { "cf-access-jwt-assertion": await other.sign("boss@example.test") }],
    ["wrong audience", { "cf-access-jwt-assertion": await access.sign("boss@example.test", { aud: ["another-app"] }) }],
    ["wrong issuer", { "cf-access-jwt-assertion": await access.sign("boss@example.test", { iss: "https://evil.example" }) }],
    ["expired", { "cf-access-jwt-assertion": await access.sign("boss@example.test", { exp: now - 10 }) }],
    ["not RS256", { "cf-access-jwt-assertion": await access.sign("boss@example.test", {}, { alg: "none" }) }],
  ];
  for (const [what, headers] of cases) {
    const res = await signIn(headers);
    assert.equal(res.status, 302, what);
    assert.equal(res.headers.get("location"), "/login?error=argo", what);
    assert.doesNotMatch(res.headers.get("set-cookie") ?? "", /session_token=[^;]+/, `${what}: no session`);
  }
  assert.equal(users(db).length, 0, "nothing created");
});

test("argo sign-in: off unless the Access team and audience are set", async () => {
  const { access, db, signIn } = await setup({});
  const res = await signIn({ "cf-access-jwt-assertion": await access.sign("boss@example.test") });
  assert.equal(res.headers.get("location"), "/login?error=argo");
  assert.equal(users(db).length, 0);
});

test("argo sign-in: a real team domain never accepts locally supplied keys", async () => {
  const access = await makeAccess();
  const prod = { ...access.env, ACCESS_TEAM_DOMAIN: "lightbound.cloudflareaccess.com" };
  const { db, testAuth } = await setup(prod);
  const fetchImpl = async () => new Response(JSON.stringify({ keys: [] }), { status: 200 });
  // Same plugin with a stubbed key fetch: the team publishes no key matching the local one, so the token fails.
  const strict = betterAuth({ ...testAuth.options, plugins: [argoSignIn(prod, fetchImpl as typeof fetch)] });
  const res = await strict.handler(new Request(`${BASE_URL}/api/auth/argo/sign-in`, {
    headers: { "cf-access-jwt-assertion": await access.sign("boss@example.test", { iss: "https://lightbound.cloudflareaccess.com" }) },
  }));
  assert.equal(res.headers.get("location"), "/login?error=argo");
  assert.equal(users(db).length, 0);
});

test("argo sign-in: only same-site callbacks", () => {
  assert.equal(safeCallback("/operator"), "/operator");
  assert.equal(safeCallback("/visualisation?x=1"), "/visualisation?x=1");
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "", undefined, 3])
    assert.equal(safeCallback(bad), "/login", String(bad));
  assert.equal(nameFromEmail("ada.lovelace@example.test"), "Ada Lovelace");
});
