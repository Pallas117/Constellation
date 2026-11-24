import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { AccountBackoff, accountKey, backoffHooks } from "./auth-backoff.js";
import { auth, CLIENT_IP_HEADER } from "./better-auth.js";

const BASE_URL = "http://localhost:3001";
const MIN = 60_000;

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("backoff: five failures pause the email, each further pause doubles up to the cap, success clears it", () => {
  const c = clock();
  const b = new AccountBackoff({ now: c.now });
  for (let i = 0; i < 4; i++) assert.equal(b.fail("Ops@Example.com"), 0, `failure ${i + 1} starts no pause`);
  assert.equal(b.retryAfterSeconds("ops@example.com"), 0);
  assert.equal(b.fail(" ops@example.com "), MIN, "the fifth starts a 1 min pause (same email, any case or spaces)");
  assert.equal(b.retryAfterSeconds("OPS@example.com"), 60);
  c.advance(MIN);
  assert.equal(b.retryAfterSeconds("ops@example.com"), 0, "free again once the pause ends");
  const pauses: number[] = [];
  for (let round = 0; round < 6; round++) {
    let pause = 0;
    for (let i = 0; i < 5; i++) pause = b.fail("ops@example.com");
    pauses.push(pause);
    c.advance(pause);
  }
  assert.deepEqual(pauses, [2, 4, 8, 15, 15, 15].map((m) => m * MIN), "doubles, capped at 15 min");
  b.succeed("ops@example.com");
  assert.equal(b.size, 0);
  for (let i = 0; i < 4; i++) b.fail("ops@example.com");
  assert.equal(b.fail("ops@example.com"), MIN, "after a success it starts again from 1 min");
});

test("backoff: failures spread beyond the window don't add up; a quiet window resets the doubling", () => {
  const c = clock();
  const b = new AccountBackoff({ now: c.now });
  for (let i = 0; i < 10; i++) {
    assert.equal(b.fail("slow@example.com"), 0);
    c.advance(4 * MIN); // four failures per 15-minute window at most
  }
  for (let i = 0; i < 5; i++) b.fail("slow@example.com");
  c.advance(MIN + 16 * MIN); // the pause ends, then a whole quiet window passes
  for (let i = 0; i < 4; i++) b.fail("slow@example.com");
  assert.equal(b.fail("slow@example.com"), MIN, "back to the first pause");
});

test("backoff: emails are held only as hashes, and the map is bounded", () => {
  const b = new AccountBackoff({ maxTracked: 3 });
  for (const e of ["a@x.test", "b@x.test", "c@x.test", "d@x.test"]) b.fail(e);
  assert.equal(b.size, 3, "oldest dropped first");
  assert.match(accountKey("a@x.test"), /^[0-9a-f]{64}$/);
  assert.equal(accountKey(" A@X.test "), accountKey("a@x.test"));
  const held = JSON.stringify([...(b as unknown as { entries: Map<string, unknown> }).entries.keys()]);
  assert.doesNotMatch(held, /@/, "no email text kept");
});

test("production sign-in is wired to the per-account backoff", () => {
  assert.equal(typeof auth.options.hooks?.before, "function");
  assert.equal(typeof auth.options.hooks?.after, "function");
});

async function testAuth(backoff: AccountBackoff) {
  // Production's IP rate limit and IP settings plus the backoff hooks, on a throwaway database.
  const instance = betterAuth({
    database: new Database(":memory:"),
    baseURL: BASE_URL,
    secret: "test-only-secret-0123456789abcdef0123456789",
    trustedOrigins: [BASE_URL],
    emailAndPassword: { enabled: true },
    rateLimit: auth.options.rateLimit,
    advanced: auth.options.advanced,
    hooks: backoffHooks(backoff),
  });
  await (await getMigrations(instance.options)).runMigrations();
  return instance;
}

const post = (instance: Awaited<ReturnType<typeof testAuth>>, path: string, ip: string, body: unknown) =>
  instance.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, [CLIENT_IP_HEADER]: ip },
      body: JSON.stringify(body),
    }),
  );

test("password guessing spread over many addresses pauses that account, and a real account looks the same as an unknown one", async () => {
  const c = clock();
  const backoff = new AccountBackoff({ now: c.now });
  const instance = await testAuth(backoff);
  const password = "a-long-correct-password-42";
  assert.equal((await post(instance, "/sign-up/email", "192.0.2.1", { email: "real@example.com", password, name: "Real" })).status, 200);

  // One guess from each of five addresses: each stays under the per-IP limit, and each is refused.
  for (let i = 0; i < 5; i++) {
    assert.equal((await post(instance, "/sign-in/email", `198.51.100.${i}`, { email: "real@example.com", password: `guess-${i}` })).status, 401);
    assert.equal((await post(instance, "/sign-in/email", `203.0.113.${i}`, { email: "nobody@example.com", password: `guess-${i}` })).status, 401);
  }
  // Now paused: even the right password, from a fresh address, gets 429 until the pause ends.
  const paused = await post(instance, "/sign-in/email", "198.51.100.200", { email: "real@example.com", password });
  assert.equal(paused.status, 429);
  const unknown = await post(instance, "/sign-in/email", "203.0.113.200", { email: "nobody@example.com", password });
  assert.equal(unknown.status, 429, "an unknown email is paused the same way: no hint which accounts exist");
  const words = async (r: Response) => String((await r.json()).message).replace(/\d+/g, "N");
  assert.equal(await words(paused), await words(unknown), "the same words for both");

  // Another account is untouched.
  assert.equal((await post(instance, "/sign-in/email", "192.0.2.50", { email: "other@example.com", password: "x-wrong" })).status, 401);

  // After the pause, the right password works and clears the record.
  c.advance(MIN);
  assert.equal((await post(instance, "/sign-in/email", "198.51.100.201", { email: "real@example.com", password })).status, 200);
  assert.equal(backoff.retryAfterSeconds("real@example.com"), 0);
});
