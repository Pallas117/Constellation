import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { AccountBackoff, accountKey, backoffHooks, DIRECT_LOCAL_HEADER } from "./auth-backoff.js";
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

test("backoff: when full, the email with the oldest last failure is dropped, never one whose pause is running", () => {
  const c = clock();
  const b = new AccountBackoff({ now: c.now, threshold: 3, maxTracked: 2 });
  b.fail("a@x.test");
  b.fail("b@x.test");
  b.fail("a@x.test"); // a was created first, but failed last
  b.fail("c@x.test"); // full: b goes, not a
  assert.equal(b.size, 2);
  assert.equal(b.fail("a@x.test"), MIN, "a kept its two failures, so the third pauses it");
  b.fail("d@x.test"); // full: c goes, the paused a stays
  assert.equal(b.retryAfterSeconds("a@x.test"), 60);
  b.fail("d@x.test");
  assert.equal(b.fail("d@x.test"), MIN);
  assert.equal(b.fail("e@x.test"), 0, "every tracked email is paused: nothing is dropped, e is not tracked");
  assert.equal(b.size, 2, "still bounded");
  assert.equal(b.retryAfterSeconds("a@x.test"), 60);
  assert.equal(b.retryAfterSeconds("d@x.test"), 60);
  c.advance(MIN);
  b.fail("e@x.test");
  assert.equal(b.size, 2, "once a pause has ended its entry can be dropped again");
});

test("backoff: attempts are reserved, so failures plus attempts still being checked never pass the threshold", () => {
  const c = clock();
  const b = new AccountBackoff({ now: c.now });
  for (let i = 0; i < 5; i++) assert.equal(b.reserve("burst@example.com"), 0, `attempt ${i + 1} is reserved`);
  assert.equal(b.reserve("burst@example.com"), 1, "the sixth waits while five are being checked");
  b.release("burst@example.com"); // one was not a guess (say a malformed request)
  assert.equal(b.reserve("burst@example.com"), 0);
  for (let i = 0; i < 4; i++) assert.equal(b.fail("burst@example.com", true), 0);
  assert.equal(b.reserve("burst@example.com"), 1, "four failures and one being checked: still full");
  assert.equal(b.fail("burst@example.com", true), MIN, "the fifth failure starts the pause");
  assert.equal(b.reserve("burst@example.com"), 60, "paused: the wait is the rest of the pause");

  // A reservation whose answer never arrives lapses by itself, so it can't hold an account shut.
  for (let i = 0; i < 5; i++) assert.equal(b.reserve("lost@example.com"), 0);
  assert.equal(b.reserve("lost@example.com"), 1);
  c.advance(30_000);
  assert.equal(b.reserve("lost@example.com"), 0);

  // A success clears the record; an email with nothing left is forgotten.
  assert.equal(b.reserve("fine@example.com"), 0);
  b.succeed("fine@example.com", true);
  assert.equal(b.reserve("typo@example.com"), 0);
  b.release("typo@example.com");
  assert.equal(b.size, 2, "only burst@ and lost@ are still tracked");
});

test("backoff: an admin unpause forgets the email's failures and pause", () => {
  const b = new AccountBackoff();
  for (let i = 0; i < 5; i++) b.fail("owner@example.com");
  assert.equal(b.retryAfterSeconds("owner@example.com"), 60);
  assert.equal(b.unpause(" Owner@Example.com "), true);
  assert.equal(b.retryAfterSeconds("owner@example.com"), 0);
  assert.equal(b.reserve("owner@example.com"), 0);
  assert.equal(b.unpause("never-seen@example.com"), false);
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

const post = (instance: Awaited<ReturnType<typeof testAuth>>, path: string, ip: string, body: unknown, extra: Record<string, string> = {}) =>
  instance.handler(
    new Request(`${BASE_URL}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE_URL, [CLIENT_IP_HEADER]: ip, ...extra },
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
  const words = async (r: Response) => String(((await r.json()) as { message?: unknown }).message).replace(/\d+/g, "N");
  assert.equal(paused.headers.get("retry-after"), "60", "Retry-After says how long the pause has left (s)");
  assert.equal(unknown.headers.get("retry-after"), "60");
  const pausedWords = await words(paused);
  assert.equal(pausedWords, await words(unknown), "the same words for both");
  assert.doesNotMatch(pausedWords, /passkey/i, "no sign-in method is offered that doesn't exist");

  // A caller the server marked as on this machine is not paused (the header is set by backend/server.ts only).
  const local = { [DIRECT_LOCAL_HEADER]: "1" };
  assert.equal((await post(instance, "/sign-in/email", "127.0.0.1", { email: "real@example.com", password: "x-wrong" }, local)).status, 401);
  assert.equal(backoff.retryAfterSeconds("real@example.com"), 60, "and its wrong password neither counts nor clears the pause");

  // Another account is untouched.
  assert.equal((await post(instance, "/sign-in/email", "192.0.2.50", { email: "other@example.com", password: "x-wrong" })).status, 401);

  // After the pause, the right password works and clears the record.
  c.advance(MIN);
  assert.equal((await post(instance, "/sign-in/email", "198.51.100.201", { email: "real@example.com", password })).status, 200);
  assert.equal(backoff.retryAfterSeconds("real@example.com"), 0);
});

test("a burst of sign-ins sent at once from many addresses gets five guesses in all, not five per address", async () => {
  const backoff = new AccountBackoff();
  const instance = await testAuth(backoff);
  const password = "a-long-correct-password-42";
  assert.equal((await post(instance, "/sign-up/email", "192.0.2.1", { email: "burst@example.com", password, name: "Burst" })).status, 200);

  const answers = await Promise.all(
    Array.from({ length: 20 }, (_, i) => post(instance, "/sign-in/email", `198.51.100.${i}`, { email: "burst@example.com", password: `guess-${i}` })),
  );
  const statuses = answers.map((r) => r.status);
  const refused = statuses.filter((s) => s === 401).length;
  assert.ok(refused >= 1 && refused <= 5, `at most five passwords were checked, got ${refused}: ${statuses.join(" ")}`);
  assert.equal(statuses.filter((s) => s === 429).length, 20 - refused, "every other one was turned away with 429");
  for (const r of answers.filter((a) => a.status === 429)) assert.match(r.headers.get("retry-after") ?? "", /^[1-9]\d*$/);
  if (refused === 5) assert.equal(backoff.retryAfterSeconds("burst@example.com"), 60, "and the account is now paused");
});

test("sign-ins that succeed, or are not guesses, leave no reservation behind", async () => {
  const backoff = new AccountBackoff();
  const instance = await testAuth(backoff);
  const password = "a-long-correct-password-42";
  assert.equal((await post(instance, "/sign-up/email", "192.0.2.1", { email: "busy@example.com", password, name: "Busy" })).status, 200);
  // Seven good sign-ins in a row (more than the threshold), each from its own address.
  for (let i = 0; i < 7; i++) {
    assert.equal((await post(instance, "/sign-in/email", `198.51.100.${i}`, { email: "busy@example.com", password })).status, 200);
  }
  assert.equal(backoff.size, 0);
  // Seven malformed sign-ins (no password): refused, but not as wrong passwords, so nothing is held or counted.
  for (let i = 0; i < 7; i++) {
    const r = await post(instance, "/sign-in/email", `203.0.113.${i}`, { email: "busy@example.com" });
    assert.ok(r.status === 400 || r.status === 422, `malformed sign-in ${i}: ${r.status}`);
  }
  assert.equal(backoff.size, 0);
  assert.equal((await post(instance, "/sign-in/email", "198.51.100.99", { email: "busy@example.com", password })).status, 200);
});
