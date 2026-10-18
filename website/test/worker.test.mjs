// Edge Worker checks (feeds, rendering, routes) with recorded upstream responses; no network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { FEEDS, feedState, normaliseLaunches, normaliseWeather, readFeed, refreshFeeds } from "../worker/feeds.js";
import { countdown, esc, renderConstellationDoor, renderGaussDoor, renderIcs, renderLaunches, renderWeather, whenText } from "../worker/render.js";
import { SECURITY_HEADERS } from "../worker/headers.js";
import { RECORDED_AT, fixture, makeFetch } from "./fixtures/fetch.mjs";
import { memoryKV } from "./fixtures/kv.mjs";
import { makeAccess } from "./fixtures/access.mjs";
import { accessIdentity, isAdmin } from "../worker/auth.js";
import { getAccount, listApplications, putAccount, saveApplication } from "../worker/data.js";
import { applyEvent, formEncode, signPayload, verifySignature } from "../worker/stripe.js";
import { APP_CSP } from "../worker/headers.js";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIN = 60_000;

// Just enough of Cloudflare's asset binding for the live pages.
const ASSETS = {
  async fetch(input) {
    const { pathname } = new URL(input.url ?? input);
    const file = join(pub, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!existsSync(file) || !statSync(file).isFile()) return new Response("not found", { status: 404 });
    return new Response(await readFile(file), { headers: { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" } });
  },
};
function context() {
  const pending = [];
  return { ctx: { waitUntil: (p) => pending.push(p), passThroughOnException() {} }, settle: () => Promise.all(pending) };
}

// ---- Normalising the upstream data ----
test("launches: Launch Library 2 records become small, display-ready items", () => {
  const items = normaliseLaunches(fixture("launches"));
  assert.equal(items.length, 10);
  assert.deepEqual(items[0], {
    id: "3b430f81-0ff1-4d85-8a1a-cef0de326198", name: "Falcon 9 Block 5 | Bandwagon 5 (Dedicated Mid-Inclination Rideshare)",
    vehicle: "Falcon 9 Block 5", mission: "Bandwagon 5 (Dedicated Mid-Inclination Rideshare)", orbit: "LEO", provider: "SpaceX",
    location: "Cape Canaveral SFS, FL, USA", net: "2026-10-19T10:30:00.000Z", precision: "MIN", windowEnd: "2026-10-19T11:30:00.000Z",
    status: "Go", statusName: "Go for Launch",
  });
  assert.equal(items.at(-1).precision, "M");
  assert.throws(() => normaliseLaunches({ detail: "Request was throttled." }), /no results/);
  assert.throws(() => normaliseLaunches({ results: [{ name: "no id or date" }] }), /no usable/);
});

test("space weather: NOAA scales, Kp and solar wind; NOAA times are UTC whatever the machine's time zone", () => {
  const w = normaliseWeather({ scales: fixture("scales"), kp: fixture("kp"), wind: fixture("wind"), mag: fixture("mag") });
  assert.deepEqual(w.G, { level: 0, text: "none" });
  assert.equal(w.at, "2026-10-17T12:52:00.000Z");
  assert.deepEqual(w.kp, { value: 0.67, at: "2026-10-17T09:00:00.000Z" });
  assert.deepEqual(w.wind, { speed: 431, bz: 2, bt: 6, at: "2026-10-17T12:45:00.000Z" });
  // Older array-of-arrays Kp format, and missing extras.
  const old = normaliseWeather({ scales: fixture("scales"), kp: [["time_tag", "Kp"], ["2026-10-17 09:00:00.000", "3.33"]], wind: null, mag: null });
  assert.equal(old.kp.value, 3.33);
  assert.equal(old.wind, null);
  assert.throws(() => normaliseWeather({ scales: {} }), /no current entry/);
});

// ---- The cron refresh ----
test("refresh: fills KV, then leaves fresh feeds alone (LL2 allows 15 calls an hour)", async () => {
  const env = { LIVE: memoryKV() };
  const f = makeFetch();
  assert.deepEqual(await refreshFeeds(env, { fetchImpl: f, now: RECORDED_AT }), { launches: "updated", weather: "updated" });
  assert.equal(f.calls.length, 5);
  assert.equal((await readFeed(env, "launches")).data.length, 10);
  assert.deepEqual(await refreshFeeds(env, { fetchImpl: f, now: RECORDED_AT + 10 * MIN }), { launches: "fresh", weather: "fresh" });
  assert.equal(f.calls.length, 5, "no upstream calls while fresh");
  assert.deepEqual(await refreshFeeds(env, { fetchImpl: f, now: RECORDED_AT + 15 * MIN }), { launches: "fresh", weather: "updated" });
  assert.deepEqual(await refreshFeeds(env, { fetchImpl: f, now: RECORDED_AT + 30 * MIN }), { launches: "updated", weather: "updated" });
});

test("refresh: an upstream failure keeps the last good data and records the error", async () => {
  const env = { LIVE: memoryKV() };
  await refreshFeeds(env, { fetchImpl: makeFetch(), now: RECORDED_AT });
  const r = await refreshFeeds(env, { fetchImpl: makeFetch({ launches: 429, scales: 503 }), now: RECORDED_AT + 60 * MIN });
  assert.deepEqual(r, { launches: "failed: ll.thespacedevs.com HTTP 429", weather: "failed: services.swpc.noaa.gov HTTP 503" });
  const rec = await readFeed(env, "launches");
  assert.equal(rec.data.length, 10, "old data kept");
  assert.equal(rec.fetchedAt, new Date(RECORDED_AT).toISOString());
  assert.equal(rec.error, "ll.thespacedevs.com HTTP 429");
  // Solar wind down but scales up: still a good refresh.
  const ok = await refreshFeeds(env, { fetchImpl: makeFetch({ wind: 500, mag: 500 }), now: RECORDED_AT + 61 * MIN });
  assert.equal(ok.weather, "updated");
  assert.equal((await readFeed(env, "weather")).data.wind, null);
});

test("feed state: live, then stale (still shown, labelled), offline when there is nothing", () => {
  const rec = { data: [1], fetchedAt: new Date(RECORDED_AT).toISOString() };
  assert.equal(feedState("weather", rec, RECORDED_AT + 30 * MIN).state, "live");
  assert.equal(feedState("weather", rec, RECORDED_AT + (FEEDS.weather.staleMin + 1) * MIN).state, "stale");
  assert.equal(feedState("launches", rec, RECORDED_AT + 100 * MIN).state, "live");
  assert.equal(feedState("launches", null).state, "offline");
});

// ---- Rendering ----
test("times: countdowns and dates follow the launch's stated precision", () => {
  const now = Date.parse("2026-10-17T13:00:00Z");
  assert.equal(countdown("2026-10-19T10:30:00Z", "MIN", now), "T−1 d 21 h");
  assert.equal(countdown("2026-10-17T15:05:00Z", "SEC", now), "T−2 h 5 min");
  assert.equal(countdown("2026-10-29T00:00:00Z", "DAY", now), "In 12 d");
  assert.equal(countdown("2026-10-31T00:00:00Z", "M", now), "NET Oct");
  assert.equal(whenText("2026-10-21T03:35:00Z", "HR"), "21 Oct, ~03:35 UTC");
  assert.equal(whenText("2026-10-29T00:00:00Z", "DAY"), "29 Oct (time TBC)");
  assert.equal(whenText("2026-10-31T00:00:00Z", "M"), "Oct 2026 (date TBC)");
});

test("rendering escapes upstream text", () => {
  assert.equal(esc(`<img src=x onerror="a">&'`), "&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;");
  const now = RECORDED_AT;
  const rec = { data: [{ id: "x", name: "", vehicle: "<script>alert(1)</script>", mission: "M & Co", orbit: "LEO", provider: "P", location: "L",
    net: new Date(now + 3_600_000).toISOString(), precision: "MIN", status: "Go", statusName: "Go" }], fetchedAt: new Date(now).toISOString() };
  const out = renderLaunches(rec, now) + renderConstellationDoor(rec, now);
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt; · M &amp; Co/);
});

test("doors show live readouts, nothing when data is missing, and say when data is stale", () => {
  const now = RECORDED_AT;
  const launches = { data: normaliseLaunches(fixture("launches")), fetchedAt: new Date(now).toISOString() };
  const weather = { data: normaliseWeather({ scales: fixture("scales"), kp: fixture("kp"), wind: fixture("wind"), mag: fixture("mag") }), fetchedAt: new Date(now).toISOString() };
  assert.match(renderConstellationDoor(launches, now), /Next launch<\/span><span class="door-big">T−1 d 21 h<\/span><span class="door-line">Falcon 9 Block 5 · Bandwagon 5/);
  assert.match(renderGaussDoor(weather, now), /G0<\/span> · <span>S0<\/span> · <span>R0<\/span>.*Kp 0\.7 · solar wind 431 km\/s · Bz \+2 nT/);
  assert.equal(renderGaussDoor(null, now), "");
  assert.equal(renderConstellationDoor({ data: [] }, now), "");
  assert.match(renderGaussDoor(weather, now + 3 * 60 * MIN), /class="as-of">as of 17 Oct 13:00 UTC/);
  assert.match(renderWeather(weather, now), /Quiet: no geomagnetic storm/);
  assert.match(renderWeather(weather, now), /reaches Earth in about 58 min/);
  assert.match(renderLaunches(null, now), /chip">Offline<.*unavailable right now/);
});

test("calendar: valid RFC 5545 lines; launches without a date are left out", () => {
  const now = RECORDED_AT;
  const ics = renderIcs({ data: normaliseLaunches(fixture("launches")), fetchedAt: new Date(now).toISOString() }, now);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\n") && ics.endsWith("END:VCALENDAR\r\n"));
  for (const line of ics.split("\r\n")) assert.ok(new TextEncoder().encode(line).length <= 75, `long line: ${line}`);
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 9, "month-precision launch skipped");
  assert.match(ics, /DTSTART:20261019T103000Z\r\nDTEND:20261019T113000Z/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261029\r\nDTEND;VALUE=DATE:20261030/);
  assert.match(ics, /LOCATION:Cape Canaveral SFS\\, FL\\, USA/);
});

// ---- Routes, as Cloudflare would call them ----
let env;
const realFetch = globalThis.fetch;
before(async () => {
  env = { ASSETS, LIVE: memoryKV() };
  await refreshFeeds(env, { fetchImpl: makeFetch({}, { shiftTo: Date.now() }) });
});
after(() => {
  globalThis.fetch = realFetch;
});
const call = async (path, init) => {
  const { ctx, settle } = context();
  const res = await worker.fetch(new Request(`https://lightbound.uk${path}`, init), env, ctx);
  await settle();
  return res;
};

test("routes: live pages are filled in and carry the security headers", async () => {
  const home = await call("/");
  assert.equal(home.status, 200);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(home.headers.get(k), v, k);
  const body = await home.text();
  assert.match(body, /Space weather now/);
  assert.match(body, /Next launch<\/span><span class="door-big">T−/);
  const page = await (await call("/constellation/")).text();
  assert.equal((page.match(/<li class="launch">/g) || []).length, 10);
  assert.match(page, /chip live">Live/);
  assert.match(page, /Space weather now<\/span><span class="door-big">/, "Gauss door readout at the end of the page");
  assert.match(await (await call("/gauss/")).text(), /Next launch<\/span><span class="door-big">T\u2212/, "Constellation door readout on /gauss/");
  assert.equal(await (await call("/", { method: "HEAD" })).text(), "");
});

test("routes: API, calendar, health, errors", async () => {
  const launches = await (await call("/api/launches")).json();
  assert.equal(launches.state, "live");
  assert.equal(launches.items.length, 10);
  assert.match(launches.attribution, /Launch Library 2/);
  const sw = await call("/api/space-weather");
  assert.equal(sw.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal((await sw.json()).data.G.level, 0);
  const ics = await call("/api/launches.ics");
  assert.match(ics.headers.get("content-type"), /^text\/calendar/);
  const health = await call("/api/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  assert.equal((await call("/api/nope")).status, 404);
  assert.equal((await call("/", { method: "POST" })).status, 405);
});

test("routes: health turns 503 when a feed goes stale", async () => {
  const rec = await readFeed(env, "weather");
  await env.LIVE.put(FEEDS.weather.key, JSON.stringify({ ...rec, fetchedAt: new Date(Date.now() - 3 * 60 * MIN).toISOString() }));
  const res = await call("/api/health");
  assert.equal(res.status, 503);
  assert.equal((await res.json()).feeds.weather.state, "stale");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("routes: a fresh deploy fetches once in the background, before the first cron", async () => {
  const f = makeFetch({}, { shiftTo: Date.now() });
  globalThis.fetch = f;
  const fresh = { ASSETS, LIVE: memoryKV() };
  const { ctx, settle } = context();
  const res = await worker.fetch(new Request("https://lightbound.uk/"), fresh, ctx);
  assert.equal(res.status, 200, "page still serves while data loads");
  await settle();
  assert.equal(f.calls.length, 5);
  assert.ok(await readFeed(fresh, "launches"));
});

// ---- Sign-in (Cloudflare Access JWT) ----
test("sign-in: only a valid Access JWT for our team and application counts", async () => {
  const access = await makeAccess();
  const other = await makeAccess(); // same kid, different key: a forged token
  const env = { ...access.env };
  const req = (token) => new Request("https://lightbound.uk/app/", { headers: token ? { "cf-access-jwt-assertion": token } : {} });
  assert.deepEqual(await accessIdentity(req(await access.sign("Ops@Example.test")), env), { email: "ops@example.test" });
  assert.equal(await accessIdentity(req(null), env), null, "no token");
  assert.equal(await accessIdentity(req(await other.sign("ops@example.test")), env), null, "wrong key");
  assert.equal(await accessIdentity(req(await access.sign("ops@example.test", { aud: ["another-app"] })), env), null, "wrong audience");
  assert.equal(await accessIdentity(req(await access.sign("ops@example.test", { iss: "https://evil.cloudflareaccess.com" })), env), null, "wrong issuer");
  assert.equal(await accessIdentity(req(await access.sign("ops@example.test", { exp: Math.floor(Date.now() / 1000) - 5 })), env), null, "expired");
  assert.equal(await accessIdentity(req(await access.sign("ops@example.test", {}, { alg: "none" })), env), null, "alg none");
  const [h, , sig] = (await access.sign("ops@example.test")).split(".");
  const tampered = Buffer.from(JSON.stringify({ aud: ["lightbound-dev"], email: "admin@example.test", iss: "https://dev.cloudflareaccess.local", exp: 9e9 })).toString("base64url");
  assert.equal(await accessIdentity(req(`${h}.${tampered}.${sig}`), env), null, "tampered claims");
  const plain = new Request("https://lightbound.uk/app/", { headers: { "cf-access-authenticated-user-email": "admin@example.test" } });
  assert.equal(await accessIdentity(plain, env), null, "a bare email header is never trusted");
  assert.equal(await accessIdentity(req(await access.sign("ops@example.test")), { ...env, ACCESS_AUD: "" }), null, "unconfigured = locked");
  assert.ok(isAdmin({ ADMIN_EMAILS: "a@x.test, Boss@X.test" }, "boss@x.test"));
  assert.ok(!isAdmin({ ADMIN_EMAILS: "" }, "boss@x.test"));
});

// ---- Applications ----
async function appEnv() {
  const access = await makeAccess();
  return { access, env: { ASSETS, LIVE: memoryKV(), DATA: memoryKV(), ADMIN_EMAILS: "boss@example.test", STRIPE_SECRET_KEY: "test-placeholder", STRIPE_WEBHOOK_SECRET: "test-webhook-placeholder", ...access.env } };
}
const post = (path, body, headers = {}) => new Request(`https://lightbound.uk${path}`, {
  method: "POST", body: new URLSearchParams(body).toString(),
  headers: { origin: "https://lightbound.uk", "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.9", ...headers },
});
const goodGauss = { kind: "gauss", name: "Ops Example", email: "ops@example.test", org: "Example Space", role: "Mission ops",
  missionType: "Earth observation", stage: "Launched and operating", groundStack: "Yamcs / XTCE", dataAccess: "Historical packet archive",
  plan: "fleet_integration", timeline: "This quarter", message: "Two smallsats flying ONNX models; we want evidence after the May storm.", consent: "yes" };
async function send(env, request) {
  const { ctx, settle } = context();
  const res = await worker.fetch(request, env, ctx);
  await settle();
  return res;
}

test("apply: a good pilot brief is stored and redirected (post/redirect/get), with a 180-day expiry", async () => {
  const { env } = await appEnv();
  const res = await send(env, post("/api/apply", goodGauss));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/gauss/apply/?sent=1");
  const [app] = await listApplications(env);
  assert.deepEqual([app.kind, app.email, app.plan, app.status], ["gauss", "ops@example.test", "fleet_integration", "new"]);
  const stored = env.DATA.map.get(`app:${app.id}`);
  assert.equal(JSON.parse(stored.v).groundStack, "Yamcs / XTCE", "readiness answers kept");
  assert.ok(stored.exp - Date.now() / 1000 > 179 * 86400 && stored.exp - Date.now() / 1000 <= 180 * 86400);
  assert.match(await (await send(env, new Request("https://lightbound.uk/gauss/apply/?sent=1"))).text(), /we'll reply with a fixed quote/);
  assert.match(await (await send(env, new Request("https://lightbound.uk/constellation/apply/?sent=1"))).text(), /Membership is free and by invitation/);
});

test("apply: bad input comes back with errors and the values escaped; nothing stored", async () => {
  const { env } = await appEnv();
  const res = await send(env, post("/api/apply", { ...goodGauss, name: "<b>x</b>", email: "nope", missionType: "Spy satellite", message: "short", consent: "" }));
  assert.equal(res.status, 422);
  const page = await res.text();
  assert.match(page, /Please check: email, mission type, message, privacy agreement\./);
  assert.match(page, /value="&lt;b&gt;x&lt;\/b&gt;"/);
  assert.doesNotMatch(page, /<b>x<\/b>/);
  assert.equal((await listApplications(env)).length, 0);
});

test("apply: cross-site posts, bots, odd encodings and floods are turned away", async () => {
  const { env } = await appEnv();
  assert.equal((await send(env, post("/api/apply", goodGauss, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await send(env, post("/api/apply", goodGauss, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await send(env, post("/api/apply", { ...goodGauss, kind: "admin" }))).status, 400);
  assert.equal((await send(env, new Request("https://lightbound.uk/api/apply"))).status, 405);
  const bot = await send(env, post("/api/apply", { ...goodGauss, website: "http://spam.example" }));
  assert.equal(bot.status, 303, "bots see success");
  assert.equal((await listApplications(env)).length, 0, "but nothing is stored");
  for (let i = 0; i < 5; i++) assert.equal((await send(env, post("/api/apply", goodGauss))).status, 303);
  assert.equal((await send(env, post("/api/apply", goodGauss))).status, 429, "sixth in an hour from one address");
  assert.ok(![...env.DATA.map.keys()].some((k) => k.includes("203.0.113.9")), "raw IP never stored");
});

test("apply page: the package in the link is preselected; unknown values fall back to the pilot", async () => {
  const { env } = await appEnv();
  assert.match(await (await send(env, new Request("https://lightbound.uk/gauss/apply/?plan=mission_integration"))).text(), /<option value="mission_integration" selected>/);
  assert.match(await (await send(env, new Request("https://lightbound.uk/gauss/apply/?plan=%22%3E%3Cscript%3E"))).text(), /<option value="pilot" selected>/);
});

// ---- Workspace, billing and admin ----
const as = async (access, email, path, init = {}) =>
  new Request(`https://lightbound.uk${path}`, { ...init, headers: { ...(init.headers ?? {}), "cf-access-jwt-assertion": await access.sign(email) } });
const formPost = async (access, email, path, body = {}, origin = "https://lightbound.uk") => as(access, email, path, {
  method: "POST", body: new URLSearchParams(body).toString(), headers: { origin, "content-type": "application/x-www-form-urlencoded" },
});
function stripeMock(fail = false) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url: String(url), body: new URLSearchParams(init.body), auth: init.headers.authorization });
    if (fail) return new Response('{"error":{"code":"api_error"}}', { status: 500 });
    const path = new URL(url).pathname;
    return Response.json(path.endsWith("/checkout/sessions") ? { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" } : { url: "https://billing.stripe.com/p/session/test_1" });
  };
  f.calls = calls;
  return f;
}
async function withFetch(f, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("workspace: signed out gets 401; pending applicants see their status; members see Constellation", async () => {
  const { env, access } = await appEnv();
  const out = await send(env, new Request("https://lightbound.uk/app/"));
  assert.equal(out.status, 401);
  assert.equal(out.headers.get("cache-control"), "private, no-store");
  await send(env, post("/api/apply", goodGauss));
  assert.match(await (await send(env, await as(access, "ops@example.test", "/app/"))).text(), /Your application from .* is with the Lightbound team/);
  assert.match(await (await send(env, await as(access, "new@example.test", "/app/"))).text(), /no Gauss plan yet/);
  await putAccount(env, { email: "member@example.test", community: "member" }, "test");
  const member = await (await send(env, await as(access, "member@example.test", "/app/"))).text();
  assert.match(member, /<p class="big">Member<\/p><p class="t">Free, by invitation\.<\/p>/);
  assert.doesNotMatch(member, /Pay securely/, "Constellation never asks for payment");
});

test("workspace: an approved quote shows Pay; checkout goes to Stripe with the quote, in pounds, for this account", async () => {
  const { env, access } = await appEnv();
  await putAccount(env, { email: "ops@example.test", org: "Example Space", tier: "pilot", quote: 2_800_000, billing: { status: "due" } }, "test");
  const res = await send(env, await as(access, "ops@example.test", "/app/"));
  assert.equal(res.headers.get("content-security-policy"), APP_CSP);
  const page = await res.text();
  assert.match(page, /<p class="big">£28,000 one-off<\/p><p class="t">Payment due<\/p>/);
  assert.match(page, /<form method="post" action="\/app\/checkout" class="inline"><button class="btn">Pay securely with Stripe<\/button><\/form>/);
  assert.doesNotMatch(page, /Open the Gauss console|Console link/, "locked until paid");
  const stripe = stripeMock();
  const go = await withFetch(stripe, async () => send(env, await formPost(access, "ops@example.test", "/app/checkout")));
  assert.equal(go.status, 303);
  assert.equal(go.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_test_1");
  const { url, body, auth } = stripe.calls[0];
  assert.equal(url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(auth, "Bearer test-placeholder");
  assert.deepEqual([body.get("mode"), body.get("line_items[0][price_data][currency]"), body.get("line_items[0][price_data][unit_amount]")], ["payment", "gbp", "2800000"]);
  assert.deepEqual([body.get("client_reference_id"), body.get("metadata[email]"), body.get("metadata[plan]"), body.get("customer_creation")], ["ops@example.test", "ops@example.test", "pilot", "always"]);
  assert.equal(body.get("success_url"), "https://lightbound.uk/app/?checkout=success");
  assert.equal((await withFetch(stripe, async () => send(env, await formPost(access, "ops@example.test", "/app/checkout", {}, "https://evil.example")))).status, 403);
  const down = await withFetch(stripeMock(true), async () => send(env, await formPost(access, "ops@example.test", "/app/checkout")));
  assert.equal(down.status, 503);
  assert.match(await down.text(), /Nothing was charged/);
});

test("checkout: Fleet Integration is a yearly subscription; no quote or already paid means no checkout", async () => {
  const { env, access } = await appEnv();
  await putAccount(env, { email: "fleet@example.test", tier: "fleet_integration", quote: 7_500_000, billing: { status: "due" } }, "test");
  const stripe = stripeMock();
  await withFetch(stripe, async () => send(env, await formPost(access, "fleet@example.test", "/app/checkout")));
  const body = stripe.calls[0].body;
  assert.deepEqual([body.get("mode"), body.get("line_items[0][price_data][recurring][interval]"), body.get("subscription_data[metadata][plan]")], ["subscription", "year", "fleet_integration"]);
  await putAccount(env, { email: "paid@example.test", tier: "pilot", quote: 2_000_000, billing: { status: "paid" } }, "test");
  await putAccount(env, { email: "noquote@example.test", tier: "pilot", billing: { status: "due" } }, "test");
  for (const who of ["paid@example.test", "noquote@example.test", "nobody@example.test"]) {
    const r = await withFetch(stripe, async () => send(env, await formPost(access, who, "/app/checkout")));
    assert.equal(r.headers.get("location"), "/app/", who);
  }
  assert.equal(stripe.calls.length, 1, "Stripe only called for the payable account");
});

test("stripe: form encoding and webhook signatures (wrong secret, stale or tampered payloads rejected)", async () => {
  assert.equal(formEncode({ a: { b: 1 }, c: [{ d: "x y" }], e: null }), "a%5Bb%5D=1&c%5B0%5D%5Bd%5D=x%20y");
  const payload = '{"id":"evt_1"}';
  const header = await signPayload("secret-a", payload);
  assert.ok(await verifySignature("secret-a", payload, header));
  assert.ok(!(await verifySignature("secret-b", payload, header)), "wrong secret");
  assert.ok(!(await verifySignature("secret-a", '{"id":"evt_2"}', header)), "tampered payload");
  const old = await signPayload("secret-a", payload, Math.floor(Date.now() / 1000) - 600);
  assert.ok(!(await verifySignature("secret-a", payload, old)), "older than 5 minutes");
  assert.ok(await verifySignature("secret-a", payload, `${header},v1=${"0".repeat(64)}`), "any matching v1 counts");
  assert.ok(!(await verifySignature("", payload, header)) && !(await verifySignature("secret-a", payload, null)));
});

test("stripe webhook: verified events unlock, renew, fail and cancel plans; forged ones change nothing", async () => {
  const { env, access } = await appEnv();
  await putAccount(env, { email: "fleet@example.test", tier: "fleet_integration", quote: 7_500_000, billing: { status: "due" } }, "test");
  const t0 = Math.floor(Date.now() / 1000);
  const hook = async (type, object, created = t0, secret = env.STRIPE_WEBHOOK_SECRET) => {
    const payload = JSON.stringify({ id: `evt_${type}_${created}`, type, created, data: { object } });
    return send(env, new Request("https://lightbound.uk/api/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": await signPayload(secret, payload) } }));
  };
  const meta = { email: "fleet@example.test", plan: "fleet_integration" };
  const status = async () => (await getAccount(env, "fleet@example.test")).billing.status;
  assert.equal((await hook("checkout.session.completed", { mode: "subscription", customer: "cus_1", subscription: "sub_1", metadata: meta }, t0, "forged")).status, 400);
  assert.equal(await status(), "due", "forged event ignored");
  assert.equal((await hook("checkout.session.completed", { mode: "subscription", customer: "cus_1", subscription: "sub_1", client_reference_id: "fleet@example.test", metadata: meta })).status, 200);
  assert.equal(await status(), "active");
  const page = await (await send(env, await as(access, "fleet@example.test", "/app/"))).text();
  assert.match(page, /Renews yearly/);
  assert.match(page, /action="\/app\/billing"/);
  assert.match(page, /Console link coming by email/, "unlocked once paid");
  await hook("customer.subscription.updated", { id: "sub_1", status: "past_due", customer: "cus_1", metadata: meta }, t0 + 10);
  assert.equal(await status(), "past_due");
  await hook("customer.subscription.updated", { id: "sub_1", status: "active", customer: "cus_1", metadata: meta }, t0 + 5);
  assert.equal(await status(), "past_due", "an older event never overwrites a newer one");
  await hook("customer.subscription.deleted", { id: "sub_1", status: "canceled", customer: "cus_1", metadata: meta }, t0 + 20);
  assert.equal(await status(), "canceled");
  assert.equal(await applyEvent(env, { type: "checkout.session.completed", created: t0, data: { object: { metadata: { email: "fleet@example.test", plan: "pilot" } } } }), "ignored: plan has changed");
  assert.equal(await applyEvent(env, { type: "checkout.session.completed", created: t0, data: { object: { metadata: { email: "stranger@example.test" } } } }), "ignored: unknown account");
  const stripe = stripeMock();
  const portal = await withFetch(stripe, async () => send(env, await formPost(access, "fleet@example.test", "/app/billing")));
  assert.equal(portal.headers.get("location"), "https://billing.stripe.com/p/session/test_1");
  assert.equal(stripe.calls[0].body.get("customer"), "cus_1");
});

test("admin: only ADMIN_EMAILS; approval needs a quote inside the published range", async () => {
  const { env, access } = await appEnv();
  await send(env, post("/api/apply", goodGauss));
  assert.equal((await send(env, await as(access, "ops@example.test", "/app/admin/"))).status, 403);
  const adminPage = await (await send(env, await as(access, "boss@example.test", "/app/admin/"))).text();
  assert.match(adminPage, /New \(1\)/);
  assert.match(adminPage, /Earth observation · Launched and operating · Yamcs \/ XTCE/);
  const [app] = await listApplications(env);
  const decide = async (email, quote, origin) => send(env, await formPost(access, email, "/app/admin/decide", { id: app.id, decision: "approve", tier: "fleet_integration", quote }, origin));
  assert.equal((await decide("ops@example.test", "75000")).status, 403, "customers cannot approve");
  assert.equal((await decide("boss@example.test", "75000", "https://evil.example")).status, 403, "cross-site");
  assert.equal((await decide("boss@example.test", "15000")).headers.get("location"), "/app/admin/?error=quote", "below the £60k floor");
  assert.equal(await getAccount(env, "ops@example.test"), null);
  assert.equal((await decide("boss@example.test", "75000")).status, 303);
  const acct = await getAccount(env, "ops@example.test");
  assert.deepEqual([acct.tier, acct.quote, acct.billing.status, acct.updatedBy], ["fleet_integration", 7_500_000, "due", "boss@example.test"]);
  assert.equal((await listApplications(env))[0].status, "approved");
});

test("admin: Constellation invitations are free memberships with a draft email, never sent automatically", async () => {
  const { env, access } = await appEnv();
  const res = await send(env, await formPost(access, "boss@example.test", "/app/admin/invite", { email: "Grace@Example.test", name: "Grace" }));
  assert.equal(res.headers.get("location"), "/app/admin/?invited=grace%40example.test");
  const acct = await getAccount(env, "grace@example.test");
  assert.deepEqual([acct.community, acct.tier ?? null, acct.quote ?? null], ["member", null, null]);
  const page = await (await send(env, await as(access, "boss@example.test", "/app/admin/?invited=grace%40example.test"))).text();
  assert.match(page, /href="mailto:grace%40example\.test\?subject=Your%20invitation%20to%20Constellation&amp;body=/);
  assert.match(page, /nothing is sent automatically/);
});

test("admin: accounts can be set, re-quoted (back to payment due) and removed", async () => {
  const { env, access } = await appEnv();
  const form = async (body) => send(env, await formPost(access, "boss@example.test", "/app/admin/account", body));
  await form({ email: "Lead@Example.test", tier: "pilot", quote: "30000", community: "member", action: "save" });
  let a = await getAccount(env, "lead@example.test");
  assert.deepEqual([a.tier, a.quote, a.billing.status, a.community], ["pilot", 3_000_000, "due", "member"]);
  await putAccount(env, { ...a, billing: { status: "paid", customer: "cus_9" } }, "stripe");
  await form({ email: "lead@example.test", tier: "fleet_integration", quote: "90000", action: "save" });
  a = await getAccount(env, "lead@example.test");
  assert.deepEqual([a.tier, a.billing.status, a.billing.customer], ["fleet_integration", "due", "cus_9"], "new plan: payment due, Stripe customer kept");
  await form({ email: "lead@example.test", tier: "mission_integration", quote: "", action: "save" });
  assert.equal((await getAccount(env, "lead@example.test")).billing.status, "invoiced");
  await form({ email: "lead@example.test", tier: "bogus", action: "save" });
  assert.equal((await getAccount(env, "lead@example.test")).tier, null, "unknown plans are dropped");
  await form({ email: "lead@example.test", action: "delete" });
  assert.equal(await getAccount(env, "lead@example.test"), null);
  assert.equal((await saveApplication(env, { kind: "constellation", name: "A", email: "a@example.test" })).status, "new");
});
