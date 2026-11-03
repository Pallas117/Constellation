import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import Database from "better-sqlite3";
import express from "express";
import type { AuthenticatedRequest, AuthRole } from "../auth.js";
import { enforceApiPolicy, PATTERN_REQUIRED, STEP_UP_REQUIRED } from "../rbac.js";
import { createPatternRouter } from "./router.js";
import { createSensor, type SensorKind } from "./sensor.js";
import { createPadRequests, createPatternStore, PATTERN_LOCK_MS, patternPepper, type ScryptCost } from "./store.js";

const CHEAP: ScryptCost = { N: 2 ** 10, r: 8, p: 1 }; // tests only; production is 2^15
const PATTERN = [0, 5, 10, 15, 3, 6, 9, 12]; // A F K P D G J M
const WRONG = [0, 5, 10, 15, 3, 6, 9, 13];

function clock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

test("operator patterns are stored only as a peppered scrypt hash, per user, under the key-lock rules", async () => {
  const db = new Database(":memory:");
  const store = createPatternStore(db, { pepper: patternPepper("test-secret"), cost: CHEAP });
  await assert.rejects(store.set("u1", [0, 1, 2]), /draw 8 to 24 vertices/);
  await assert.rejects(store.set("u1", [0, 1, 0, 1, 0, 1, 0, 1]), /at least 6 different/);
  await store.set("u1", PATTERN);
  await store.set("u2", PATTERN);
  const rows = db.prepare("SELECT * FROM operator_pattern ORDER BY userId").all() as Array<Record<string, unknown>>;
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].hash, rows[1].hash, "the same drawing hashes differently for different operators");
  assert.doesNotMatch(JSON.stringify(rows), /0\.5\.10\.15|AFKP/i, "the pattern itself is never stored");
  assert.deepEqual(await store.check("u1", PATTERN), { ok: true });
  // Another pepper (a rotated auth secret) no longer matches: copying the database alone isn't enough.
  const other = createPatternStore(db, { pepper: patternPepper("another-secret"), cost: CHEAP });
  assert.equal((await other.check("u1", PATTERN)).ok, false);
  assert.throws(() => patternPepper(""), /auth secret/);
});

test("five misses lock an operator's pattern for 15 minutes; a match resets the count", async () => {
  const db = new Database(":memory:");
  const c = clock();
  const store = createPatternStore(db, { pepper: patternPepper("s"), cost: CHEAP, now: c.now });
  await store.set("u1", PATTERN);
  assert.deepEqual(await store.check("u1", WRONG), { ok: false, reason: "miss", triesLeft: 4, lockedUntil: null });
  assert.deepEqual(await store.check("u1", PATTERN), { ok: true }, "a match resets the misses");
  for (let i = 4; i >= 1; i--) assert.equal((await store.check("u1", WRONG)).ok, false);
  const fifth = await store.check("u1", [1, 2]); // out of rule: still a try
  assert.deepEqual(fifth, { ok: false, reason: "miss", triesLeft: 0, lockedUntil: c.now() + PATTERN_LOCK_MS });
  assert.deepEqual(await store.check("u1", PATTERN), { ok: false, reason: "locked", lockedUntil: c.now() + PATTERN_LOCK_MS }, "locked even for the right one");
  c.advance(PATTERN_LOCK_MS + 1);
  assert.equal(store.lockedUntil("u1"), null);
  assert.deepEqual(await store.check("u1", PATTERN), { ok: true });
  assert.deepEqual(await store.check("nobody", PATTERN), { ok: false, reason: "not-set" });
  assert.equal(store.clear("u1"), true);
  assert.equal(store.isSet("u1"), false);
});

test("phone requests are one-time: two minutes, five tries, one approval", () => {
  const c = clock();
  const requests = createPadRequests({ now: c.now });
  const a = requests.open("u1", "mac-session");
  assert.match(a.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(requests.forSession("mac-session")?.id, a.id);
  const b = requests.open("u1", "mac-session");
  assert.equal(requests.get(a.id)?.state, "expired", "a new code ends the old one");
  for (let i = 0; i < 4; i++) requests.settle(b, false);
  assert.equal(b.state, "waiting");
  requests.settle(b, false);
  assert.equal(b.state, "failed");
  const d = requests.open("u1", "mac-session");
  c.advance(2 * 60_000);
  assert.equal(requests.get(d.id)?.state, "expired");
  assert.equal(requests.get("not-a-request"), null);
  const e = requests.open("u1", "mac-session");
  requests.settle(e, true);
  assert.equal(requests.forSession("mac-session")?.state, "approved");
});

/** The production policy middleware and router, with the session faked from test headers. */
type Marks = { sessions: Array<[string, number]>; users: Array<[string, number | null]>; duress: string[]; events: SensorKind[]; alarms: string[] };
async function withApp(fn: (api: string, marks: Marks) => Promise<void>) {
  const db = new Database(":memory:");
  const store = createPatternStore(db, { pepper: patternPepper("test-secret"), cost: CHEAP });
  const marks: Marks = { sessions: [], users: [], duress: [], events: [], alarms: [] };
  const verified = new Set<string>();
  const sensor = createSensor({ alarm: (title) => void marks.alarms.push(title), log: (e) => void marks.events.push(e.message.split(":")[0] as SensorKind) });
  const app = express();
  app.use(express.json());
  app.use("/api", (req: AuthenticatedRequest, _res, next) => {
    const role = req.header("x-test-role") as AuthRole | undefined;
    const touched = req.header("x-test-touched-ms-ago");
    const token = req.header("x-test-session") ?? "mac-session";
    if (role) {
      req.auth = {
        userId: "u-op",
        email: null,
        role,
        rawRoles: [role],
        token,
        passkeyAt: touched === undefined ? null : Date.now() - Number(touched),
        pattern: { set: store.isSet("u-op"), verifiedAt: verified.has(token) ? Date.now() : null, duress: marks.duress.includes(token) },
      };
    }
    next();
  });
  app.use("/api", enforceApiPolicy);
  app.use(
    "/api/operator-pattern",
    createPatternRouter({
      store,
      requests: createPadRequests(),
      sensor,
      markSession: async (token, at) => {
        verified.add(token);
        marks.sessions.push([token, at.getTime()]);
      },
      markDuress: async (token) => void marks.duress.push(token),
      ipOf: () => "100.64.0.9",
      markUser: async (userId, at) => void marks.users.push([userId, at ? at.getTime() : null]),
      geometryKeyFor: () => "pQECAyYgASFYIA",
      required: () => true,
      padOrigin: "https://gauss.example.ts.net",
    }),
  );
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/operator-pattern`, marks);
  } finally {
    server.close();
  }
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("setting a pattern needs a fresh passkey touch; changing it also needs the current one drawn", async () => {
  await withApp(async (api, marks) => {
    const op = { "x-test-role": "operator" };
    const status = async (headers: Record<string, string>) => (await fetch(`${api}/status`, { headers })).json();
    assert.deepEqual(await status(op), {
      required: true,
      set: false,
      verified: false,
      duressSet: false,
      lockedUntil: null,
      padOrigin: "https://gauss.example.ts.net",
      request: null,
      notice: { misses: 0, probes: 0, unusual: 0, lastIp: null, lastAt: null },
    });
    const noTouch = await post(api, { pattern: PATTERN }, op);
    assert.equal(noTouch.status, 428);
    assert.equal(((await noTouch.json()) as { code: string }).code, STEP_UP_REQUIRED);
    assert.equal((await post(api, { pattern: [1, 2, 3] }, { ...op, "x-test-touched-ms-ago": "0" })).status, 400);
    assert.equal((await post(api, { pattern: PATTERN }, { ...op, "x-test-touched-ms-ago": "1000" })).status, 200);
    assert.deepEqual(marks.users.map(([u]) => u), ["u-op"], "the user is marked as having a pattern");
    assert.deepEqual(marks.sessions.map(([t]) => t), ["mac-session"], "setting it counts as drawing it");
    // Another browser session (touched, but not drawn) can't replace it.
    const other = { ...op, "x-test-session": "other", "x-test-touched-ms-ago": "0" };
    const change = await post(api, { pattern: WRONG }, other);
    assert.equal(change.status, 428);
    assert.equal(((await change.json()) as { code: string }).code, PATTERN_REQUIRED);
    assert.equal((await post(api, { pattern: WRONG }, { ...op, "x-test-touched-ms-ago": "0" })).status, 200, "drawn in this session: allowed");
  });
});

test("drawing the pattern marks the session; misses answer 200 with tries left, never 401/403", async () => {
  await withApp(async (api, marks) => {
    const op = { "x-test-role": "operator" };
    await post(api, { pattern: PATTERN }, { ...op, "x-test-session": "setup", "x-test-touched-ms-ago": "0" });
    const fresh = { ...op, "x-test-session": "next-day" };
    const miss = await post(`${api}/verify`, { pattern: WRONG }, fresh);
    assert.equal(miss.status, 200);
    assert.deepEqual(await miss.json(), { ok: false, reason: "miss", triesLeft: 4, lockedUntil: null, message: "That's not your pattern. 4 tries left." });
    const hit = await post(`${api}/verify`, { pattern: PATTERN }, fresh);
    assert.deepEqual(await hit.json(), { ok: true });
    assert.equal(marks.sessions.at(-1)?.[0], "next-day");
    assert.equal((await post(`${api}/verify`, { pattern: "AFKP" }, fresh)).status, 400);
    assert.equal((await post(`${api}/verify`, { pattern: PATTERN })).status, 401, "a session is needed");
  });
});

test("a phone draws the pattern for the computer's session through a one-time QR code", async () => {
  await withApp(async (api, marks) => {
    const op = { "x-test-role": "operator" };
    assert.equal((await post(`${api}/requests`, {}, op)).status, 409, "no pattern yet: set it on the computer first");
    await post(api, { pattern: PATTERN }, { ...op, "x-test-session": "setup", "x-test-touched-ms-ago": "0" });
    const opened = (await (await post(`${api}/requests`, {}, op)).json()) as { id: string; padUrl: string; expiresAt: number };
    assert.equal(opened.padUrl, `https://gauss.example.ts.net/pad#${opened.id}`, "the id rides in the fragment, never the path or query");
    // The phone: no session, only the id.
    const info = (await (await post(`${api}/pad/info`, { request: opened.id })).json()) as { state: string; geometryKey: string };
    assert.equal(info.state, "waiting");
    assert.equal(info.geometryKey, "pQECAyYgASFYIA");
    const miss = (await (await post(`${api}/pad`, { request: opened.id, pattern: WRONG })).json()) as { ok: boolean; state: string };
    assert.deepEqual([miss.ok, miss.state], [false, "waiting"]);
    assert.equal(marks.sessions.filter(([t]) => t === "mac-session").length, 0);
    const hit = (await (await post(`${api}/pad`, { request: opened.id, pattern: PATTERN })).json()) as { ok: boolean; state: string };
    assert.deepEqual([hit.ok, hit.state], [true, "approved"]);
    assert.equal(marks.sessions.at(-1)?.[0], "mac-session", "the computer's session is the one marked");
    const status = (await (await fetch(`${api}/status`, { headers: op })).json()) as { verified: boolean; request: { state: string } };
    assert.deepEqual([status.verified, status.request.state], [true, "approved"]);
    // Used up: the same code does nothing more, and unknown or malformed ids get 410/410.
    assert.equal((await post(`${api}/pad`, { request: opened.id, pattern: PATTERN })).status, 410);
    assert.equal((await post(`${api}/pad`, { request: "x".repeat(22), pattern: PATTERN })).status, 410);
    assert.equal((await post(`${api}/pad/info`, { request: "../etc" })).status, 410);
  });
});

test("the frontend pad uses the same pattern rules as the server", async () => {
  const { readFileSync } = await import("node:fs");
  const { PATTERN_RULES } = await import("./store.js");
  const source = readFileSync(new URL("../../frontend/src/lib/pattern.ts", import.meta.url), "utf8");
  const m = source.match(/PATTERN_RULES = \{ minLength: (\d+), maxLength: (\d+), minDistinct: (\d+) \}/);
  assert.ok(m, "frontend PATTERN_RULES not found");
  assert.deepEqual({ minLength: Number(m[1]), maxLength: Number(m[2]), minDistinct: Number(m[3]) }, { ...PATTERN_RULES });
});

test("a duress pattern signs in like the real one, marks the session silently and raises the alarm", async () => {
  await withApp(async (api, marks) => {
    const op = { "x-test-role": "operator" };
    const DURESS = [15, 10, 5, 0, 12, 9, 6, 3];
    await post(api, { pattern: PATTERN }, { ...op, "x-test-session": "setup", "x-test-touched-ms-ago": "0" });
    const setup = { ...op, "x-test-session": "setup", "x-test-touched-ms-ago": "0" };
    assert.equal((await post(`${api}/duress`, { pattern: DURESS }, { ...op, "x-test-session": "setup" })).status, 428, "needs a fresh touch");
    assert.equal((await post(`${api}/duress`, { pattern: DURESS }, { ...op, "x-test-session": "other", "x-test-touched-ms-ago": "0" })).status, 428, "and the pattern drawn in this session");
    const same = await post(`${api}/duress`, { pattern: PATTERN }, setup);
    assert.equal(same.status, 400);
    assert.match(((await same.json()) as { error: string }).error, /must differ/);
    assert.equal((await post(`${api}/duress`, { pattern: DURESS }, setup)).status, 200);
    assert.equal(((await (await fetch(`${api}/status`, { headers: setup })).json()) as { duressSet: boolean }).duressSet, true);

    // Under duress: the answer is the same as for the real pattern.
    const coerced = { ...op, "x-test-session": "coerced" };
    const res = await post(`${api}/verify`, { pattern: DURESS }, coerced);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(marks.duress, ["coerced"]);
    assert.ok(marks.events.includes("duress"));
    assert.ok(marks.alarms.some((t) => /DURESS/.test(t)));
    // Nothing the coerced session can read says so, and it can't change either pattern.
    const seen = (await (await fetch(`${api}/status`, { headers: coerced })).json()) as { verified: boolean; duressSet: boolean };
    assert.deepEqual([seen.verified, seen.duressSet], [true, false]);
    assert.equal((await post(api, { pattern: WRONG }, { ...coerced, "x-test-touched-ms-ago": "0" })).status, 503);
    assert.equal((await fetch(`${api}/duress`, { method: "DELETE", headers: { ...coerced, "x-test-touched-ms-ago": "0" } })).status, 503);
    // The real one still signs in normally, and a new real pattern can't be the duress one.
    assert.deepEqual(await (await post(`${api}/verify`, { pattern: PATTERN }, { ...op, "x-test-session": "fine" })).json(), { ok: true });
    assert.equal((await post(api, { pattern: DURESS }, setup)).status, 400);
    const removed = await fetch(`${api}/duress`, { method: "DELETE", headers: setup });
    assert.deepEqual(await removed.json(), { ok: true, removed: true });
  });
});

test("wrong drawings and probed phone codes reach the sensor; the operator sees them at the next drawing", async () => {
  await withApp(async (api, marks) => {
    const op = { "x-test-role": "operator" };
    await post(api, { pattern: PATTERN }, { ...op, "x-test-session": "setup", "x-test-touched-ms-ago": "0" });
    await post(`${api}/verify`, { pattern: WRONG }, { ...op, "x-test-session": "s2" });
    await post(`${api}/verify`, { pattern: WRONG }, { ...op, "x-test-session": "s2" });
    for (let i = 0; i < 3; i++) await post(`${api}/pad`, { request: `probe${i}`.padEnd(22, "x"), pattern: PATTERN });
    assert.deepEqual(marks.events.filter((e) => e === "pattern-miss").length, 2);
    assert.deepEqual(marks.events.filter((e) => e === "pad-probe").length, 3);
    assert.ok(marks.alarms.some((t) => /wrong pattern/.test(t)) && marks.alarms.some((t) => /probed/.test(t)));
    const notice = ((await (await fetch(`${api}/status`, { headers: { ...op, "x-test-session": "s2" } })).json()) as { notice: { misses: number } }).notice;
    assert.equal(notice.misses, 2, "misses since the last good drawing");
  });
});
