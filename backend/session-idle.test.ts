import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { SessionIdle, sessionTokenFromCookie, tokenKey } from "./session-idle.js";
import { auth, COOKIE_ATTRIBUTES, SESSION_POLICY } from "./better-auth.js";

const MIN = 60_000;

test("idle: a session quiet for more than 30 min is idle; activity keeps it alive", () => {
  let t = 0;
  const idle = new SessionIdle({ now: () => t });
  assert.equal(idle.touch("tok"), "ok");
  t += 29 * MIN;
  assert.equal(idle.touch("tok"), "ok", "a request within 30 min resets the clock");
  t += 30 * MIN;
  assert.equal(idle.touch("tok"), "ok", "exactly 30 min is still allowed");
  t += 30 * MIN + 1;
  assert.equal(idle.touch("tok"), "idle");
  assert.equal(idle.idleMinutes, 30);
});

test("idle: a session ended here is remembered for 2 h, then forgotten; tokens are held only as hashes", () => {
  let t = 0;
  const idle = new SessionIdle({ now: () => t });
  idle.touch("tok");
  idle.end("tok");
  assert.equal(idle.wasEnded("tok"), true);
  assert.equal(idle.wasEnded("other"), false);
  assert.equal(idle.wasEnded(null), false);
  assert.deepEqual(idle.size, { active: 0, ended: 1 });
  t += 2 * 60 * MIN + 1;
  assert.equal(idle.wasEnded("tok"), false);
  assert.match(tokenKey("tok"), /^[0-9a-f]{64}$/);
});

test("idle: both maps are bounded", () => {
  const idle = new SessionIdle({ maxTracked: 2 });
  for (const tok of ["a", "b", "c"]) idle.touch(tok);
  for (const tok of ["d", "e", "f"]) idle.end(tok);
  assert.deepEqual(idle.size, { active: 2, ended: 2 });
});

test("idle: the session token is read from better-auth's cookie, plain or __Secure-, signed and URL-encoded", () => {
  assert.equal(sessionTokenFromCookie("a=1; better-auth.session_token=abc123.c2ln%2Bbg%3D%3D; b=2"), "abc123");
  assert.equal(sessionTokenFromCookie("__Secure-better-auth.session_token=xyz.sig"), "xyz");
  assert.equal(sessionTokenFromCookie("other=1"), null);
  assert.equal(sessionTokenFromCookie(undefined), null);
  assert.equal(sessionTokenFromCookie("better-auth.session_token=%E0%A4%A"), null, "bad encoding is ignored");
});

test("production pins the session lifetime and cookie attributes instead of library defaults (TM-04)", () => {
  assert.deepEqual({ ...auth.options.session }, { expiresIn: 12 * 60 * 60, updateAge: 15 * 60 });
  assert.deepEqual({ ...auth.options.advanced?.defaultCookieAttributes }, { httpOnly: true, sameSite: "lax", path: "/" });
  assert.equal(auth.options.advanced?.useSecureCookies, undefined, "Secure is left to better-auth's per-request https check");
});

test("sign-in cookies: HttpOnly, SameSite=Lax, 12 h; Secure only when the configured URL is https", async () => {
  const signUpOn = async (baseURL: string, email: string) => {
    const instance = betterAuth({
      database: new Database(":memory:"),
      baseURL,
      secret: "test-only-secret-0123456789abcdef0123456789",
      trustedOrigins: [baseURL],
      emailAndPassword: { enabled: true },
      session: SESSION_POLICY,
      advanced: { defaultCookieAttributes: COOKIE_ATTRIBUTES },
    });
    await (await getMigrations(instance.options)).runMigrations();
    const res = await instance.handler(
      new Request(`${baseURL}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: baseURL },
        body: JSON.stringify({ email, password: "a-long-correct-password-42", name: "Test" }),
      }),
    );
    assert.equal(res.status, 200);
    return res.headers.getSetCookie().find((c) => /session_token=/.test(c)) ?? "";
  };

  const plain = await signUpOn("http://localhost:3001", "plain@example.com");
  assert.match(plain, /HttpOnly/i);
  assert.match(plain, /SameSite=Lax/i);
  assert.match(plain, /Max-Age=43200/i, "12 h");
  assert.match(plain, /Path=\//);
  assert.doesNotMatch(plain, /;\s*Secure/i, "plain http: browsers would drop a Secure cookie");

  const secure = await signUpOn("https://gauss.example.test", "secure@example.com");
  assert.match(secure, /^__Secure-/, "https: the __Secure- prefix");
  assert.match(secure, /;\s*Secure/i, "https: Secure");
  assert.match(secure, /HttpOnly/i);
});
