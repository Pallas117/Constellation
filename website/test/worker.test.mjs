// Edge Worker checks (feeds, rendering, routes) with recorded upstream responses; no network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { FEEDS, feedState, normaliseEvents, normaliseLaunches, normaliseWeather, readFeed, refreshFeeds } from "../worker/feeds.js";
import { countdown, esc, renderConstellationDoor, renderEventIcs, renderEvents, renderGaussDoor, renderIcs, renderLaunches, renderWeather, whenText } from "../worker/render.js";
import { SECURITY_HEADERS } from "../worker/headers.js";
import { RECORDED_AT, fixture, makeFetch } from "./fixtures/fetch.mjs";
import { memoryKV } from "./fixtures/kv.mjs";
import { makeAccess } from "./fixtures/access.mjs";
import { accessIdentity, isAdmin } from "../worker/auth.js";
import { getAccount, listApplications, putAccount, saveApplication, senderOf } from "../worker/data.js";
import { applyEvent, createPortal, formEncode, signPayload, verifySignature } from "../worker/stripe.js";
import { billingStatus, isAcademicEmail } from "../worker/tiers.js";
import { APP_CSP } from "../worker/headers.js";
import { formatIn, renderPlanner, tzOffset, zonedToUtc } from "../worker/timezones.js";
import { listCalls, saveCall } from "../worker/calls.js";

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
  assert.deepEqual(await refreshFeeds(env, { fetchImpl: f, now: RECORDED_AT }), { launches: "updated", weather: "updated", events: "updated" });
  assert.equal(f.calls.length, 6);
  assert.equal((await readFeed(env, "launches")).data.length, 10);
  assert.deepEqual(await refreshFeeds(env, { fetchImpl: f, now: RECORDED_AT + 10 * MIN }), { launches: "fresh", weather: "fresh", events: "fresh" });
  assert.equal(f.calls.length, 6, "no upstream calls while fresh");
  assert.deepEqual(await refreshFeeds(env, { fetchImpl: f, now: RECORDED_AT + 15 * MIN }), { launches: "fresh", weather: "updated", events: "fresh" });
  assert.deepEqual(await refreshFeeds(env, { fetchImpl: f, now: RECORDED_AT + 30 * MIN }), { launches: "updated", weather: "updated", events: "fresh" });
  assert.deepEqual(await refreshFeeds(env, { fetchImpl: f, now: RECORDED_AT + 180 * MIN }), { launches: "updated", weather: "updated", events: "updated" }, "Luma every 3 hours");
});

test("events: Luma's calendar becomes titles, times and public links only; cancelled events dropped", () => {
  const ev = normaliseEvents(fixture("events"));
  assert.deepEqual(ev.map((e) => e.title), ["Example Night", "Workshop: Ethics, data and dual use", "Resilience for teams on a very long folded line"]);
  assert.deepEqual(ev.map((e) => e.url), ["https://luma.com/pastex01", "https://luma.com/ethics26", "https://luma.com/event/evt-NoPageExample03"]);
  assert.equal(ev[1].start, "2026-10-24T09:00:00.000Z");
  assert.deepEqual(Object.keys(ev[0]).sort(), ["end", "start", "title", "url"], "no organiser, description, address or coordinates");
  assert.throws(() => normaliseEvents("<html>not a calendar</html>"), /not a calendar/);
  const html = renderEvents({ data: ev, fetchedAt: new Date(RECORDED_AT).toISOString() }, RECORDED_AT);
  assert.match(html, /<ol class="events"><li class="event"><time datetime="2026-10-24T09:00:00.000Z"><b>Sat 24 Oct 2026<\/b><span>09:00\u00a0UTC<\/span><\/time><a href="https:\/\/luma\.com\/ethics26" rel="noopener">Workshop: Ethics, data and dual use<\/a>/);
  assert.match(html, /<h3 class="label events-h">Recently<\/h3><ol class="events past">[\s\S]*Example Night/);
  assert.doesNotMatch(html, /Example Street|calendar-invite|51\.5/, "nothing private reaches the page");
  assert.match(renderEvents({ data: [] }, RECORDED_AT), /No events are scheduled right now[\s\S]*href="https:\/\/luma\.com\/constellation"/);
  assert.equal(renderEvents({ data: [{ title: "x", start: "2099-01-01T00:00:00.000Z", end: "2099-01-01T01:00:00.000Z", url: "https://evil.example/" }] }, RECORDED_AT).includes("evil"), false, "only luma.com links");
});

test("refresh: an upstream failure keeps the last good data and records the error", async () => {
  const env = { LIVE: memoryKV() };
  await refreshFeeds(env, { fetchImpl: makeFetch(), now: RECORDED_AT });
  const r = await refreshFeeds(env, { fetchImpl: makeFetch({ launches: 429, scales: 503 }), now: RECORDED_AT + 60 * MIN });
  assert.deepEqual(r, { launches: "failed: ll.thespacedevs.com HTTP 429", weather: "failed: services.swpc.noaa.gov HTTP 503", events: "fresh" });
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
  assert.equal(countdown("2026-10-19T10:30:00Z", "MIN", now), "T\u22121\u00a0d 21\u00a0h", "units stay with their numbers");
  assert.equal(countdown("2026-10-17T15:05:00Z", "SEC", now), "T\u22122\u00a0h 5\u00a0min");
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
  assert.match(renderConstellationDoor(launches, now), /Next launch<\/span><span class="door-big">T\u22121\u00a0d 21\u00a0h<\/span><span class="door-line">Falcon 9 Block 5 · Bandwagon 5/);
  assert.match(renderGaussDoor(weather, now), /G0<\/span> · <span>S0<\/span> · <span>R0<\/span>.*Kp\u00a00\.7 · solar wind 431\u00a0km\/s · Bz\u00a0\+2\u00a0nT/);
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

test("routes: Luma being down never fails the health check", async () => {
  const env = { ASSETS, LIVE: memoryKV() };
  await refreshFeeds(env, { fetchImpl: makeFetch({ events: 503 }, { shiftTo: Date.now() }), now: Date.now() });
  const res = await send(env, new Request("https://lightbound.uk/api/health"));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.feeds.events.state, "offline");
  const page = await (await send(env, new Request("https://lightbound.uk/constellation/"))).text();
  assert.match(page, /No events are scheduled right now/, "the section still shows the Luma link");
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
  assert.equal(f.calls.length, 6);
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
    if (path.endsWith("/checkout/sessions")) return Response.json({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", expires_at: Math.floor(Date.now() / 1000) + 86_400 });
    if (path.endsWith("/billing_portal/sessions")) return Response.json({ url: "https://billing.stripe.com/p/session/test_1" });
    if (path.endsWith("/customers")) return Response.json({ id: "cus_new" });
    if (path.endsWith("/invoiceitems")) return Response.json({ id: "ii_1" });
    const inv = { id: "in_1", customer: new URLSearchParams(init.body).get("customer") ?? "cus_new", status: "draft" };
    if (path.endsWith("/send")) return Response.json({ ...inv, status: "open", hosted_invoice_url: "https://invoice.stripe.com/i/test_1", due_date: Math.floor(Date.now() / 1000) + 30 * 86_400 });
    return Response.json(inv);
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
  assert.doesNotMatch(member, /Pay now|Request an invoice|Billing/, "Constellation never asks for payment");
});

test("workspace: an approved quote shows Pay; checkout goes to Stripe with the quote, in pounds, for this account", async () => {
  const { env, access } = await appEnv();
  await putAccount(env, { email: "ops@example.test", org: "Example Space", tier: "pilot", quote: 2_800_000, billing: { status: "due" } }, "test");
  const res = await send(env, await as(access, "ops@example.test", "/app/"));
  assert.equal(res.headers.get("content-security-policy"), APP_CSP);
  const page = await res.text();
  assert.match(page, /<p class="big">£28,000 one-off<\/p><p class="t">Payment due<\/p>/);
  assert.match(page, /<form method="post" action="\/app\/checkout" class="inline"><button class="btn">Pay now<\/button><\/form>/);
  assert.doesNotMatch(page, /Stripe|securely|card details|Request an invoice/, "no payment-method talk; invoices only where allowed");
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
  assert.equal((await getAccount(env, "ops@example.test")).billing.checkout.id, "cs_test_1", "the session is kept, so only its payment counts");
  const ops = await getAccount(env, "ops@example.test");
  await putAccount(env, { ...ops, billing: { ...ops.billing, checkout: null } }, "test"); // no open session: the next click calls Stripe
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

test("invoices: only where an admin allows them; Stripe emails one invoice; paid unlocks, overdue locks", async () => {
  const { env, access } = await appEnv();
  await putAccount(env, { email: "fleet@example.test", org: "Example Ltd", tier: "fleet_integration", quote: 7_500_000, invoice: true, billing: { status: "due" } }, "test");
  await putAccount(env, { email: "card@example.test", tier: "pilot", quote: 2_000_000, billing: { status: "due" } }, "test");
  const page = await (await send(env, await as(access, "fleet@example.test", "/app/"))).text();
  assert.match(page, /action="\/app\/invoice" class="inline"><button class="btn ghost">Request an invoice</);
  const stripe = stripeMock();
  const no = await withFetch(stripe, async () => send(env, await formPost(access, "card@example.test", "/app/invoice")));
  assert.equal(no.headers.get("location"), "/app/");
  assert.equal(stripe.calls.length, 0, "no invoice unless allowed");
  assert.equal((await withFetch(stripe, async () => send(env, await formPost(access, "fleet@example.test", "/app/invoice", {}, "https://evil.example")))).status, 403);
  const res = await withFetch(stripe, async () => send(env, await formPost(access, "fleet@example.test", "/app/invoice")));
  assert.equal(res.headers.get("location"), "/app/?invoice=sent");
  assert.deepEqual(stripe.calls.map((c) => new URL(c.url).pathname), ["/v1/customers", "/v1/invoices", "/v1/invoiceitems", "/v1/invoices/in_1/finalize", "/v1/invoices/in_1/send"]);
  const [cust, inv, item] = stripe.calls.map((c) => c.body);
  assert.deepEqual([cust.get("email"), cust.get("name")], ["fleet@example.test", "Example Ltd"]);
  assert.deepEqual([inv.get("customer"), inv.get("collection_method"), inv.get("days_until_due"), inv.get("metadata[plan]")], ["cus_new", "send_invoice", "30", "fleet_integration"]);
  assert.deepEqual([item.get("invoice"), item.get("amount"), item.get("currency"), item.get("description")], ["in_1", "7500000", "gbp", "Gauss: Fleet Integration, 12 months"]);
  let acct = await getAccount(env, "fleet@example.test");
  assert.deepEqual([acct.billing.status, acct.billing.customer, acct.billing.invoice], ["invoice_open", "cus_new", "in_1"]);
  const sent = await (await send(env, await as(access, "fleet@example.test", "/app/?invoice=sent"))).text();
  assert.match(sent, /Invoice sent to fleet@example\.test\./);
  assert.match(sent, /href="https:\/\/invoice\.stripe\.com\/i\/test_1"/);
  assert.match(sent, /Console link coming by email/, "open while the invoice is within its terms");
  assert.equal((await withFetch(stripe, async () => send(env, await formPost(access, "fleet@example.test", "/app/invoice")))).headers.get("location"), "/app/");
  assert.equal(stripe.calls.length, 5, "one invoice at a time");
  // Overdue: locked until paid.
  assert.equal(billingStatus(acct, Date.parse(acct.billing.dueAt) + 1000), "overdue");
  await putAccount(env, { ...acct, billing: { ...acct.billing, dueAt: new Date(Date.now() - 1000).toISOString() } }, "test");
  const late = await (await send(env, await as(access, "fleet@example.test", "/app/"))).text();
  assert.match(late, /Invoice overdue/);
  assert.doesNotMatch(late, /Console link/);
  // Webhooks: only this account's invoice counts; a paid year runs out.
  const t0 = Math.floor(Date.now() / 1000);
  const ev = (type, id) => ({ type, created: t0, data: { object: { id, created: t0, metadata: { email: "fleet@example.test", plan: "fleet_integration" } } } });
  assert.equal(await applyEvent(env, ev("invoice.paid", "in_other")), "ignored: not this account's invoice");
  assert.equal(await applyEvent(env, ev("invoice.paid", "in_1")), "invoice.paid -> paid");
  acct = await getAccount(env, "fleet@example.test");
  assert.equal(Date.parse(acct.billing.paidUntil), (t0 * 1000) + 365 * 86_400_000);
  assert.equal(billingStatus(acct), "paid");
  assert.equal(billingStatus(acct, Date.parse(acct.billing.paidUntil) + 1000), "due", "renew after a year");
  await putAccount(env, { ...acct, billing: { ...acct.billing, status: "invoice_open" } }, "test");
  assert.equal(await applyEvent(env, ev("invoice.voided", "in_1")), "invoice.voided -> due");
  assert.equal((await getAccount(env, "fleet@example.test")).billing.invoice, null);
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
  await putAccount(env, { email: "fleet@example.test", tier: "fleet_integration", quote: 7_500_000, billing: { status: "due", checkout: { id: "cs_1" } } }, "test");
  const t0 = Math.floor(Date.now() / 1000);
  const hook = async (type, object, created = t0, secret = env.STRIPE_WEBHOOK_SECRET) => {
    const payload = JSON.stringify({ id: `evt_${type}_${created}`, type, created, data: { object } });
    return send(env, new Request("https://lightbound.uk/api/stripe/webhook", { method: "POST", body: payload, headers: { "stripe-signature": await signPayload(secret, payload) } }));
  };
  const meta = { email: "fleet@example.test", plan: "fleet_integration" };
  const status = async () => (await getAccount(env, "fleet@example.test")).billing.status;
  assert.equal((await hook("checkout.session.completed", { id: "cs_1", mode: "subscription", customer: "cus_1", subscription: "sub_1", metadata: meta }, t0, "forged")).status, 400);
  assert.equal(await applyEvent(env, { type: "checkout.session.completed", created: t0, data: { object: { id: "cs_old", mode: "subscription", customer: "cus_1", subscription: "sub_x", metadata: meta } } }),
    "ignored: not this account's checkout", "a session from before a re-quote, or anyone else's, changes nothing");
  assert.equal(await applyEvent(env, { type: "customer.subscription.updated", created: t0, data: { object: { id: "sub_x", status: "active", metadata: meta } } }), "ignored: not this account's subscription");
  assert.equal(await applyEvent(env, { type: "checkout.session.completed", created: t0, data: { object: { id: "cs_1", client_reference_id: "fleet@example.test" } } }), "ignored: no account", "metadata.email is required");
  assert.equal(await status(), "due", "forged event ignored");
  assert.equal((await hook("checkout.session.completed", { id: "cs_1", mode: "subscription", customer: "cus_1", subscription: "sub_1", client_reference_id: "fleet@example.test", metadata: meta })).status, 200);
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

test("argo: the early-access list is stored like other applications; an invitation adds Argo only", async () => {
  const { env, access } = await appEnv();
  const res = await send(env, post("/api/apply", { kind: "argo", name: "Ops Example", email: "ops@example.test", interest: "Both", platform: "Linux", devices: "6–25", note: "Hotel Wi-Fi blocks our ground-station VPN.", consent: "yes" }));
  assert.equal(res.headers.get("location"), "/argo/apply/?sent=1");
  const page = await (await send(env, new Request("https://lightbound.uk/argo/apply/?sent=1"))).text();
  assert.match(page, /You're on the Gauss Argo list\./);
  const bad = await send(env, post("/api/apply", { kind: "argo", name: "Ops", email: "ops@example.test", interest: "Free VPN", platform: "macOS", devices: "1", consent: "yes" }, { "cf-connecting-ip": "203.0.113.10" }));
  assert.equal(bad.status, 422, "only the listed options");
  const admin = await (await send(env, await as(access, "boss@example.test", "/app/admin/"))).text();
  assert.match(admin, /ARGO · EARLY ACCESS AND RELAY WAITLIST/);
  assert.match(admin, /Both · Linux · 6–25 devices/);
  assert.match(admin, /Invite to early access/);
  const [app] = await listApplications(env);
  await send(env, await formPost(access, "boss@example.test", "/app/admin/decide", { id: app.id, decision: "approve" }));
  assert.equal((await listApplications(env))[0].status, "approved");
  const acct = await getAccount(env, "ops@example.test");
  assert.ok(acct.argo.invitedAt);
  assert.deepEqual([acct.tier ?? null, acct.community ?? null], [null, null], "no Gauss plan or membership");
  const work = await (await send(env, await as(access, "ops@example.test", "/app/"))).text();
  assert.match(work, /You're on the early-access list/, "ARGO_SALES off: no start button");
  assert.doesNotMatch(work, /Start Gauss Argo/);
});

test("argo sales: off, invite, open; $10 a month subscription with its own billing; never touches a Gauss plan", async () => {
  const { env, access } = await appEnv();
  const argoPage = async (e) => (await send(e, new Request("https://lightbound.uk/argo/"))).text();
  assert.match(await argoPage(env), /href="\/argo\/apply\/">Request early access/);
  assert.match(await argoPage(env), /Planned: <strong>\$10 a month/);
  const stripe = stripeMock();
  assert.equal((await withFetch(stripe, async () => send(env, await formPost(access, "new@example.test", "/app/argo/checkout")))).headers.get("location"), "/app/", "off: no checkout");
  const invite = { ...env, ARGO_SALES: "invite" };
  await putAccount(invite, { email: "fleet@example.test", tier: "fleet_integration", quote: 7_500_000, billing: { status: "active", customer: "cus_fleet" }, argo: { invitedAt: "2026-10-20T00:00:00.000Z" } }, "test");
  assert.equal((await withFetch(stripe, async () => send(invite, await formPost(access, "stranger@example.test", "/app/argo/checkout")))).headers.get("location"), "/app/", "invite: only invited accounts");
  assert.match(await (await send(invite, await as(access, "fleet@example.test", "/app/"))).text(), /Start Gauss Argo/);
  const go = await withFetch(stripe, async () => send(invite, await formPost(access, "fleet@example.test", "/app/argo/checkout")));
  assert.equal(go.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_test_1");
  const body = stripe.calls.at(-1).body;
  assert.deepEqual([body.get("mode"), body.get("line_items[0][price_data][currency]"), body.get("line_items[0][price_data][unit_amount]"), body.get("line_items[0][price_data][recurring][interval]")],
    ["subscription", "usd", "1000", "month"]);
  assert.deepEqual([body.get("metadata[product]"), body.get("subscription_data[metadata][product]"), body.get("customer"), body.get("consent_collection[terms_of_service]")], ["argo", "argo", "cus_fleet", "required"],
    "same Stripe customer as the Gauss plan; terms must be accepted");
  assert.equal(body.get("success_url"), "https://lightbound.uk/app/?argo=started");
  // Webhooks: Argo's own billing; the Gauss plan stays as it was.
  const t0 = Math.floor(Date.now() / 1000);
  const meta = { email: "fleet@example.test", product: "argo" };
  assert.equal(await applyEvent(invite, { type: "checkout.session.completed", created: t0, data: { object: { id: "cs_test_1", mode: "subscription", customer: "cus_fleet", subscription: "sub_argo", metadata: meta } } }), "argo checkout.session.completed -> active");
  let acct = await getAccount(invite, "fleet@example.test");
  assert.deepEqual([acct.argo.billing.status, acct.argo.billing.subscription, acct.billing.status, acct.tier], ["active", "sub_argo", "active", "fleet_integration"]);
  assert.match(await (await send(invite, await as(access, "fleet@example.test", "/app/?argo=started"))).text(), /Gauss Argo is starting/);
  await applyEvent(invite, { type: "customer.subscription.deleted", created: t0 + 5, data: { object: { id: "sub_argo", status: "canceled", customer: "cus_fleet", metadata: meta } } });
  acct = await getAccount(invite, "fleet@example.test");
  assert.deepEqual([acct.argo.billing.status, acct.billing.status], ["canceled", "active"], "cancelling Argo leaves Fleet Integration active");
  assert.match(await (await send(invite, await as(access, "boss@example.test", "/app/admin/"))).text(), /Argo: Cancelled/);
  // Open: anyone signed in can start; the account is created first so the webhook can find it.
  const open = { ...env, ARGO_SALES: "open" };
  assert.match(await argoPage(open), /href="\/app\/\?argo=start">Start for \$10 a month/);
  const r = await withFetch(stripe, async () => send(open, await formPost(access, "solo@example.test", "/app/argo/checkout")));
  assert.equal(r.status, 303);
  assert.equal((await getAccount(open, "solo@example.test")).email, "solo@example.test");
  assert.equal(stripe.calls.at(-1).body.get("customer_email"), "solo@example.test");
});

test("education: university emails start straight away; students free for a year; staff checkout only once priced", async () => {
  for (const [e, ok] of [["a@ox.ac.uk", true], ["b@mit.edu", true], ["c@um.edu.my", true], ["d@student.unsw.edu.au", true], ["e@gmail.com", false], ["f@education.example.com", false], ["g@ac.evil.com", false], ["h@free.ac", false], ["i@kyoto-u.ac.jp", true], ["j@uni.edu.evil.com", false]])
    assert.equal(isAcademicEmail(e), ok, e);
  const { env, access } = await appEnv();
  const page = async (e) => (await send(e, new Request("https://lightbound.uk/education/"))).text();
  assert.match(await page(env), /href="\/education\/apply\/">Register interest/, "off by default");
  const stripe = stripeMock();
  assert.equal((await withFetch(stripe, async () => send(env, await formPost(access, "kim@uni.ac.uk", "/app/edu/student", { student: "yes" })))).headers.get("location"), "/app/", "off: nothing starts");
  const open = { ...env, EDU_SALES: "open" };
  assert.match(await page(open), /<p class="price">Price TBC<\/p>/);
  assert.match(await page(open), /href="\/app\/\?edu=start">Start free/);
  const card = await (await send(open, await as(access, "kim@uni.ac.uk", "/app/"))).text();
  assert.match(card, /Start free as a student/);
  assert.match(card, /Staff and research: price TBC/);
  assert.equal((await send(open, await formPost(access, "kim@uni.ac.uk", "/app/edu/student", {}))).headers.get("location"), "/app/", "must confirm student status");
  assert.equal((await send(open, await formPost(access, "kim@uni.ac.uk", "/app/edu/student", { student: "yes" }))).headers.get("location"), "/app/?edu=student");
  const kim = await getAccount(open, "kim@uni.ac.uk");
  assert.deepEqual([kim.edu.plan, kim.edu.billing.status, kim.edu.billing.free], ["student", "paid", true]);
  assert.ok(Math.abs(Date.parse(kim.edu.billing.paidUntil) - (Date.now() + 365 * 86_400_000)) < 60_000, "a year at a time");
  assert.equal(billingStatus({ billing: kim.edu.billing }, Date.parse(kim.edu.billing.paidUntil) + 1000), "due", "renews with the same check");
  assert.match(await (await send(open, await as(access, "kim@uni.ac.uk", "/app/edu/"))).text(), /LAB_01[\s\S]*Storm levels from raw data/);
  assert.equal(stripe.calls.length, 0, "students never touch Stripe");
  // Not a university address: review first.
  assert.match(await (await send(open, await as(access, "sam@gmail.com", "/app/?edu=start"))).text(), /University email needed/);
  assert.equal((await send(open, await formPost(access, "sam@gmail.com", "/app/edu/student", { student: "yes" }))).headers.get("location"), "/app/");
  assert.equal((await send(open, await as(access, "sam@gmail.com", "/app/edu/"))).headers.get("location"), "/app/", "the classroom needs access");
  // Staff: no checkout while the price is TBC; once set, a monthly subscription on Education's own billing.
  assert.equal((await withFetch(stripe, async () => send(open, await formPost(access, "pat@uni.ac.uk", "/app/edu/checkout")))).headers.get("location"), "/app/");
  assert.equal(stripe.calls.length, 0);
  const priced = { ...open, EDU_STAFF_PRICE: "500" };
  assert.match(await page(priced), /<p class="price">\$5 a month<\/p>/);
  const go = await withFetch(stripe, async () => send(priced, await formPost(access, "pat@uni.ac.uk", "/app/edu/checkout")));
  assert.equal(go.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_test_1");
  const body = stripe.calls.at(-1).body;
  assert.deepEqual([body.get("mode"), body.get("line_items[0][price_data][unit_amount]"), body.get("line_items[0][price_data][currency]"), body.get("line_items[0][price_data][recurring][interval]"), body.get("metadata[product]"), body.get("metadata[offer]")],
    ["subscription", "500", "usd", "month", "edu", "staff"]);
  assert.equal(body.get("success_url"), "https://lightbound.uk/app/?edu=started");
  const t0 = Math.floor(Date.now() / 1000);
  assert.equal(await applyEvent(priced, { type: "checkout.session.completed", created: t0, data: { object: { id: "cs_test_1", mode: "subscription", customer: "cus_pat", subscription: "sub_edu", metadata: { email: "pat@uni.ac.uk", product: "edu", offer: "staff" } } } }), "edu checkout.session.completed -> active");
  const pat = await getAccount(priced, "pat@uni.ac.uk");
  assert.deepEqual([pat.edu.plan, pat.edu.billing.status, pat.edu.customer, pat.argo ?? null, pat.billing ?? null], ["staff", "active", "cus_pat", null, null]);
  assert.match(await (await send(priced, await as(access, "pat@uni.ac.uk", "/app/"))).text(), /Renews monthly\.[\s\S]*Open the classroom/);
});

test("education departments: a yearly quote from admin, an invoice with 30 days to pay, the classroom open meanwhile", async () => {
  const { env, access } = await appEnv();
  const res = await send(env, post("/api/apply", { kind: "edu", name: "Dr Lee", email: "lee@physics.example.org", institution: "Example University", eduRole: "Department or programme lead", course: "MSc Space Systems", seats: "21–100", note: "A module for 40 students.", consent: "yes" }));
  assert.equal(res.headers.get("location"), "/education/apply/?sent=1");
  assert.match(await (await send(env, new Request("https://lightbound.uk/education/apply/?sent=1"))).text(), /Your request is with the Gauss for Education team/);
  const admin = await (await send(env, await as(access, "boss@example.test", "/app/admin/"))).text();
  assert.match(admin, /EDUCATION · Department or programme lead/);
  assert.match(admin, /Example University · Department or programme lead · MSc Space Systems · 21–100 \(people\)/);
  const [app] = await listApplications(env);
  assert.equal((await send(env, await formPost(access, "boss@example.test", "/app/admin/decide", { id: app.id, decision: "department", quote: "" }))).headers.get("location"), "/app/admin/?error=edu");
  await send(env, await formPost(access, "boss@example.test", "/app/admin/decide", { id: app.id, decision: "department", quote: "3000" }));
  let lee = await getAccount(env, "lee@physics.example.org");
  assert.deepEqual([lee.edu.plan, lee.edu.quote, lee.edu.billing.status, lee.org, lee.tier ?? null], ["department", 300_000, "due", "Example University", null]);
  assert.match(await (await send(env, await as(access, "lee@physics.example.org", "/app/"))).text(), /£3,000 a year[\s\S]*Request the invoice/);
  const stripe = stripeMock();
  const inv = await withFetch(stripe, async () => send(env, await formPost(access, "lee@physics.example.org", "/app/edu/invoice")));
  assert.equal(inv.headers.get("location"), "/app/?invoice=sent");
  const item = stripe.calls.find((c) => c.url.endsWith("/v1/invoiceitems")).body;
  assert.deepEqual([item.get("amount"), item.get("currency"), item.get("description"), item.get("metadata[product]"), item.get("metadata[offer]")], ["300000", "gbp", "Gauss for Education: department licence, 12 months", "edu", "department"]);
  lee = await getAccount(env, "lee@physics.example.org");
  assert.equal(lee.edu.billing.status, "invoice_open");
  assert.match(await (await send(env, await as(access, "lee@physics.example.org", "/app/edu/"))).text(), /Classroom\./, "open while the invoice is within its terms");
  const t0 = Math.floor(Date.now() / 1000);
  assert.equal(await applyEvent(env, { type: "invoice.paid", created: t0, data: { object: { id: "in_other", created: t0, metadata: { email: "lee@physics.example.org", product: "edu" } } } }), "ignored: not this account's invoice");
  assert.equal(await applyEvent(env, { type: "invoice.paid", created: t0, data: { object: { id: "in_1", created: t0, metadata: { email: "lee@physics.example.org", product: "edu", offer: "department" } } } }), "edu invoice.paid -> paid");
  lee = await getAccount(env, "lee@physics.example.org");
  assert.deepEqual([lee.edu.plan, lee.edu.billing.status, Date.parse(lee.edu.billing.paidUntil)], ["department", "paid", t0 * 1000 + 365 * 86_400_000]);
  assert.match(await (await send(env, await as(access, "boss@example.test", "/app/admin/"))).text(), /Education: department paid/);
});

test("workshops: a team's request is stored and listed for admin; marking it contacted creates no account", async () => {
  const { env, access } = await appEnv();
  const res = await send(env, post("/api/apply", { kind: "workshop", name: "Ana Example", email: "ana@example.test", org: "Example Space Ltd", topic: "A mix of the three", format: "Online", groupSize: "11–30", timeline: "Next quarter", note: "A leadership away day for our ops team.", consent: "yes" }));
  assert.equal(res.headers.get("location"), "/constellation/workshops/?sent=1");
  assert.match(await (await send(env, new Request("https://lightbound.uk/constellation/workshops/?sent=1"))).text(), /Your workshop request is with the Constellation team/);
  const admin = await (await send(env, await as(access, "boss@example.test", "/app/admin/"))).text();
  assert.match(admin, /WORKSHOP · A mix of the three/);
  assert.match(admin, /Example Space Ltd · A mix of the three · Online · group: 11–30 · Next quarter/);
  const [app] = await listApplications(env);
  await send(env, await formPost(access, "boss@example.test", "/app/admin/decide", { id: app.id, decision: "approve" }));
  assert.equal((await listApplications(env))[0].status, "approved");
  assert.equal(await getAccount(env, "ana@example.test"), null, "no account or membership from a workshop request");
});

test("security: big bodies refused before reading; the Stripe key only ever goes to Stripe; sign-ins never create records", async () => {
  const { env, access } = await appEnv();
  const big = "x=" + "a".repeat(20 * 1024);
  const appPost = await send(env, await as(access, "member@example.test", "/app/prefs", { method: "POST", body: big, headers: { origin: "https://lightbound.uk", "content-type": "application/x-www-form-urlencoded" } }));
  assert.equal(appPost.status, 413);
  assert.equal((await send(env, post("/api/apply", { kind: "constellation", message: "a".repeat(20 * 1024) }))).status, 413);
  const hook = await send(env, new Request("https://lightbound.uk/api/stripe/webhook", { method: "POST", body: "{}", headers: { "content-length": String(600 * 1024) } }));
  assert.equal(hook.status, 413);
  // STRIPE_API_BASE is only for the local stand-in: anything else is ignored.
  const calls = [];
  const f = async (url) => { calls.push(String(url)); return Response.json({ url: "https://billing.stripe.com/p/session/x" }); };
  for (const base of ["https://evil.example/v1x/", "http://127.0.0.1.evil.example/", "http://10.0.0.5:8788/__stripe"])
    await createPortal({ ...env, STRIPE_API_BASE: base }, { email: "a@example.test", billing: { customer: "cus_1" } }, "https://lightbound.uk", f);
  await createPortal({ ...env, STRIPE_API_BASE: "http://127.0.0.1:8788/__stripe" }, { email: "a@example.test", billing: { customer: "cus_1" } }, "https://lightbound.uk", f);
  assert.deepEqual(calls.map((u) => new URL(u).origin), ["https://api.stripe.com", "https://api.stripe.com", "https://api.stripe.com", "http://127.0.0.1:8788"]);
  // Saving a time-zone preference never creates an account for someone who only signed in.
  await send(env, await formPost(access, "stranger@example.test", "/app/prefs", { tz: "Asia/Kuala_Lumpur" }));
  assert.equal(await getAccount(env, "stranger@example.test"), null);
});

test("security: Access key rotation is followed (once a minute at most); calendar files can't be broken into", async () => {
  const oldKey = await makeAccess({ kid: "old" });
  const newKey = await makeAccess({ kid: "new" });
  const jwk = (a) => JSON.parse(a.env.ACCESS_JWKS).keys[0];
  let served = [jwk(oldKey)];
  let fetches = 0;
  const certs = async () => { fetches++; return Response.json({ keys: served }); };
  const env = { ACCESS_TEAM_DOMAIN: oldKey.env.ACCESS_TEAM_DOMAIN, ACCESS_AUD: oldKey.env.ACCESS_AUD };
  const t = Date.now() + 10 * 3_600_000; // past any key cache left by other tests; tokens are signed for that time
  const req = async (a) => new Request("https://lightbound.uk/app/", { headers: { "cf-access-jwt-assertion": await a.sign("a@example.test", { exp: Math.floor(t / 1000) + 7200 }) } });
  assert.deepEqual(await accessIdentity(await req(oldKey), env, { fetchImpl: certs, now: t }), { email: "a@example.test" });
  served = [jwk(oldKey), jwk(newKey)]; // Access rotates
  assert.deepEqual(await accessIdentity(await req(newKey), env, { fetchImpl: certs, now: t + 120_000 }), { email: "a@example.test" }, "unknown kid: refetch once");
  const before = fetches;
  assert.equal(await accessIdentity(await req(await makeAccess({ kid: "forged" })), env, { fetchImpl: certs, now: t + 150_000 }), null);
  assert.equal(fetches, before, "an unknown kid can't make us refetch more than once a minute");
  const ics = renderEventIcs({ uid: "call-x\r\nATTENDEE:evil", start: "2030-01-01T00:00:00.000Z", minutes: 60, summary: "Hi\rDTSTART:19700101T000000Z", description: "a\nb" });
  assert.match(ics, /^UID:call-xATTENDEEevil@lightbound\.uk\r$/m);
  assert.match(ics, /^SUMMARY:Hi\\nDTSTART:19700101T000000Z\r$/m, "a lone CR is escaped, not a new line");
  assert.equal(ics.match(/^DTSTART/gm).length, 1);
  assert.equal(SECURITY_HEADERS["Cross-Origin-Resource-Policy"], "same-site");
  assert.match(SECURITY_HEADERS["Permissions-Policy"], /payment=\(\), usb=\(\)/);
});

test("security: an oversized upstream feed is refused, and the last good data is kept", async () => {
  const env = { LIVE: memoryKV() };
  await refreshFeeds(env, { fetchImpl: makeFetch(), now: RECORDED_AT });
  const huge = async () => new Response("x".repeat(3 * 1024 * 1024), { headers: { "content-type": "application/json" } });
  const r = await refreshFeeds(env, { fetchImpl: huge, now: RECORDED_AT + 200 * MIN });
  assert.match(r.launches, /response too large/);
  assert.match(r.events, /response too large/);
  assert.equal((await readFeed(env, "launches")).data.length, 10, "old data kept");
});

test("security review: checkout sessions reused, not multiplied; student year needs a university address; senders by /64; chunked uploads capped; dev keys local only", async () => {
  const { env, access } = await appEnv();
  const open = { ...env, ARGO_SALES: "open" };
  const stripe = stripeMock();
  const first = await withFetch(stripe, async () => send(open, await formPost(access, "solo@example.test", "/app/argo/checkout")));
  const again = await withFetch(stripe, async () => send(open, await formPost(access, "solo@example.test", "/app/argo/checkout")));
  assert.equal(again.headers.get("location"), first.headers.get("location"));
  assert.equal(stripe.calls.length, 1, "a second click reuses the open session");
  assert.equal((await getAccount(open, "solo@example.test")).argo.checkout.id, "cs_test_1");
  // An approved department without a university address can't take the free student year.
  const edu = { ...env, EDU_SALES: "open" };
  await putAccount(edu, { email: "lee@physics.example.org", edu: { approvedAt: "2026-10-20T00:00:00.000Z", plan: "department", quote: 300_000, billing: { status: "due" } } }, "test");
  await putAccount(edu, { email: "dept@uni.ac.uk", edu: { approvedAt: "2026-10-20T00:00:00.000Z", plan: "department", quote: 300_000, billing: { status: "due" } } }, "test");
  for (const who of ["lee@physics.example.org", "dept@uni.ac.uk"]) {
    assert.equal((await send(edu, await formPost(access, who, "/app/edu/student", { student: "yes" }))).headers.get("location"), "/app/", who);
    assert.equal((await getAccount(edu, who)).edu.plan, "department");
  }
  // Rate limits count an IPv6 /64 as one sender (one host can hold the whole /64).
  assert.equal(senderOf("2001:db8:1:2:aaaa::1"), senderOf("2001:db8:1:2:bbbb:cccc:dddd:1"));
  assert.equal(senderOf("2001:db8::1"), "2001:db8:0:0::/64");
  assert.notEqual(senderOf("2001:db8:1:2::1"), senderOf("2001:db8:1:3::1"));
  assert.equal(senderOf("203.0.113.9"), "203.0.113.9");
  // A chunked upload with no Content-Length is still capped.
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode("x".repeat(1024))); c.close(); } });
  const chunked = new Request("https://lightbound.uk/app/prefs", { method: "POST", body: stream, duplex: "half",
    headers: { origin: "https://lightbound.uk", "content-type": "application/x-www-form-urlencoded", "cf-access-jwt-assertion": await access.sign("member@example.test") } });
  assert.equal((await send(env, chunked)).status, 413);
  // The dev signing key is honoured only for a *.local team domain.
  const leaked = { ...env, ACCESS_TEAM_DOMAIN: "lightbound.cloudflareaccess.com" };
  const certs = async () => Response.json({ keys: [] });
  const req = new Request("https://lightbound.uk/app/", { headers: { "cf-access-jwt-assertion": await access.sign("boss@example.test", { iss: "https://lightbound.cloudflareaccess.com" }) } });
  assert.equal(await accessIdentity(req, leaked, { fetchImpl: certs, now: Date.now() + 20 * 3_600_000 }), null);
});

test("user cap: new self-serve sign-ups wait once USER_CAP accounts exist; existing accounts are never blocked", async () => {
  const { env, access } = await appEnv();
  const capped = { ...env, ARGO_SALES: "open", EDU_SALES: "open", USER_CAP: "2" };
  await putAccount(capped, { email: "one@example.test", community: "member" }, "test");
  await putAccount(capped, { email: "two@uni.ac.uk", community: "member" }, "test");
  const stripe = stripeMock();
  assert.equal((await withFetch(stripe, async () => send(capped, await formPost(access, "three@example.test", "/app/argo/checkout")))).headers.get("location"), "/app/?full=argo");
  assert.equal((await send(capped, await formPost(access, "four@uni.ac.uk", "/app/edu/student", { student: "yes" }))).headers.get("location"), "/app/?full=edu");
  assert.equal(await getAccount(capped, "three@example.test"), null);
  assert.match(await (await send(capped, await as(access, "three@example.test", "/app/?full=argo"))).text(), /We(&#39;|')re full for now\. Join the Gauss Argo list/);
  const existing = await withFetch(stripe, async () => send(capped, await formPost(access, "one@example.test", "/app/argo/checkout")));
  assert.equal(existing.headers.get("location"), "https://checkout.stripe.com/c/pay/cs_test_1", "an existing account can still start");
  assert.equal((await send(capped, await formPost(access, "two@uni.ac.uk", "/app/edu/student", { student: "yes" }))).headers.get("location"), "/app/?edu=student");
  assert.match(await (await send(capped, await as(access, "boss@example.test", "/app/admin/"))).text(), /Accounts \(2 of 2\)/);
  assert.match(await (await send(capped, await as(access, "one@example.test", "/app/"))).text(), /Starting means you agree to the <a href="\/terms\/">terms<\/a>/);
});

test("support: Constellation shows a Support link only once a Stripe Payment Link is set", async () => {
  const { env, access } = await appEnv();
  const page = async (e) => (await send(e, new Request("https://lightbound.uk/constellation/"))).text();
  assert.doesNotMatch(await page(env), /Support Constellation/, "hidden while unset");
  assert.doesNotMatch(await page({ ...env, SUPPORT_URL: "https://evil.example/pay" }), /Support Constellation/, "only Stripe Payment Links");
  const set = { ...env, SUPPORT_URL: "https://buy.stripe.com/test_00abc123" };
  const html = await page(set);
  assert.match(html, /<a class="btn ghost" href="https:\/\/buy\.stripe\.com\/test_00abc123" rel="noopener">Support Constellation<\/a>/);
  assert.match(html, /optional and changes nothing about membership/);
  assert.doesNotMatch(html, /donat/i, "a contribution to a company, not a charity donation");
  await putAccount(set, { email: "member@example.test", community: "member" }, "test");
  assert.match(await (await send(set, await as(access, "member@example.test", "/app/"))).text(), /Support Constellation<\/a> \(optional\)/);
});

test("admin: Constellation invitations are free memberships with a draft email, never sent automatically", async () => {
  const { env, access } = await appEnv();
  const res = await send(env, await formPost(access, "boss@example.test", "/app/admin/invite", { email: "Grace@Example.test", name: "Grace" }));
  const to = res.headers.get("location");
  assert.match(to, /^\/app\/admin\/\?invited=[0-9a-f-]{36}$/, "a one-time token, never the email, in the URL");
  const acct = await getAccount(env, "grace@example.test");
  assert.deepEqual([acct.community, acct.tier ?? null, acct.quote ?? null], ["member", null, null]);
  const page = await (await send(env, await as(access, "boss@example.test", to))).text();
  assert.doesNotMatch(await (await send(env, await as(access, "boss@example.test", "/app/admin/?invited=grace%40example.test"))).text(), /is now a Constellation member/, "an email in the URL does nothing");
  assert.match(page, /href="mailto:grace%40example\.test\?subject=Your%20invitation%20to%20Constellation&amp;body=/);
  assert.match(page, /nothing is sent automatically/);
});

test("admin: accounts can be set, re-quoted (back to payment due) and removed", async () => {
  const { env, access } = await appEnv();
  const form = async (body) => send(env, await formPost(access, "boss@example.test", "/app/admin/account", body));
  await form({ email: "Lead@Example.test", tier: "pilot", quote: "30000", community: "member", invoice: "yes", action: "save" });
  let a = await getAccount(env, "lead@example.test");
  assert.deepEqual([a.tier, a.quote, a.billing.status, a.community, a.invoice], ["pilot", 3_000_000, "due", "member", true]);
  assert.match(await (await send(env, await as(access, "boss@example.test", "/app/admin/"))).text(), /name="invoice" value="yes" checked> Allow invoice/);
  await putAccount(env, { ...a, billing: { status: "paid", customer: "cus_9", invoice: "in_9", paidUntil: "2027-01-01T00:00:00.000Z" } }, "stripe");
  await form({ email: "lead@example.test", tier: "fleet_integration", quote: "90000", action: "save" });
  a = await getAccount(env, "lead@example.test");
  assert.deepEqual([a.tier, a.billing.status, a.billing.customer], ["fleet_integration", "due", "cus_9"], "new plan: payment due, Stripe customer kept");
  assert.deepEqual([a.billing.invoice, a.billing.paidUntil, a.invoice], [null, null, false], "earlier invoice and paid year dropped; invoicing off unless ticked");
  await form({ email: "lead@example.test", tier: "mission_integration", quote: "", action: "save" });
  assert.equal((await getAccount(env, "lead@example.test")).billing.status, "invoiced");
  await form({ email: "lead@example.test", tier: "bogus", action: "save" });
  assert.equal((await getAccount(env, "lead@example.test")).tier, null, "unknown plans are dropped");
  await form({ email: "lead@example.test", action: "delete" });
  assert.equal(await getAccount(env, "lead@example.test"), null);
  assert.equal((await saveApplication(env, { kind: "constellation", name: "A", email: "a@example.test" })).status, "new");
});

// ---- Constellation group calls and the time-zone planner ----
test("time zones: offsets follow daylight saving; wall-clock times convert to UTC in either direction", () => {
  const H = 3_600_000;
  assert.equal(tzOffset(Date.parse("2026-07-01T12:00:00Z"), "Europe/London"), H, "BST");
  assert.equal(tzOffset(Date.parse("2026-12-01T12:00:00Z"), "Europe/London"), 0, "GMT");
  assert.equal(tzOffset(Date.parse("2026-12-01T12:00:00Z"), "Asia/Kuala_Lumpur"), 8 * H);
  assert.equal(new Date(zonedToUtc("2026-07-01T13:00", "Europe/London")).toISOString(), "2026-07-01T12:00:00.000Z");
  assert.equal(new Date(zonedToUtc("2026-10-23T20:00", "Asia/Kuala_Lumpur")).toISOString(), "2026-10-23T12:00:00.000Z");
  assert.equal(new Date(zonedToUtc("2026-11-02T09:00", "America/New_York")).toISOString(), "2026-11-02T14:00:00.000Z", "after US clocks change");
  assert.equal(zonedToUtc("2026-07-01T13:00", "Mars/Olympus"), null, "unknown zone");
  assert.equal(zonedToUtc("tomorrow", "Europe/London"), null);
  assert.match(formatIn(Date.parse("2026-10-23T12:00:00Z"), "Asia/Kuala_Lumpur"), /23 Oct, 20:00$/);
});

test("planner: finds the hours that suit everyone, and a picked hour shows in every zone with a calendar file", () => {
  const html = renderPlanner({ zones: ["Europe/London", "Asia/Kuala_Lumpur"], date: "2026-10-23", at: 9 });
  assert.match(html, /Everyone is within 08:00–20:00 local time at 07:00, 08:00, 09:00, 10:00, 11:00 UTC\./);
  assert.match(html, /<b>London<\/b> [A-Za-z]{3} 23 Oct, 10:00/);
  assert.match(html, /<b>Kuala Lumpur<\/b> [A-Za-z]{3} 23 Oct, 17:00/);
  assert.match(html, /href="\/api\/call\.ics\?start=2026-10-23T09%3A00%3A00\.000Z"/);
  const none = renderPlanner({ zones: ["Pacific/Auckland", "Europe/London", "America/Los_Angeles"], date: "2026-10-23", at: null });
  assert.match(none, /No hour suits everyone\. Best: 2 of 3 zones/);
});

test("planner routes: the page reads its query safely; the calendar endpoint takes only a start time", async () => {
  const { env } = await appEnv();
  const page = await (await send(env, new Request("https://lightbound.uk/constellation/time/?z=Europe/London&z=Asia/Kuala_Lumpur&z=%3Cscript%3E&date=2026-10-23&at=9"))).text();
  assert.match(page, /Everyone is within/);
  assert.doesNotMatch(page, /<script>/);
  const ics = await send(env, new Request(`https://lightbound.uk/api/call.ics?start=${new Date(Date.now() + 86_400_000).toISOString()}`));
  assert.equal(ics.status, 200);
  assert.match(await ics.text(), /SUMMARY:Constellation group call/);
  assert.equal((await send(env, new Request("https://lightbound.uk/api/call.ics?start=nonsense"))).status, 400);
  assert.equal((await send(env, new Request("https://lightbound.uk/api/call.ics?start=2099-01-01T00:00:00Z"))).status, 400);
});

test("group calls: admins schedule; members book within capacity; the link shows only once booked", async () => {
  const { env, access } = await appEnv();
  for (const e of ["m1@example.test", "m2@example.test", "m3@example.test"]) await putAccount(env, { email: e, community: "member" }, "test");
  await putAccount(env, { email: "customer@example.test", tier: "pilot" }, "test");
  const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  const made = await send(env, await formPost(access, "boss@example.test", "/app/admin/calls",
    { action: "create", title: "Members' call", start: `${day}T13:00`, zone: "Asia/Kuala_Lumpur", minutes: "60", capacity: "2", link: "https://meet.example.test/c", notes: "Agenda" }));
  assert.equal(made.status, 303);
  const [call] = await listCalls(env);
  assert.equal(call.start, new Date(zonedToUtc(`${day}T13:00`, "Asia/Kuala_Lumpur")).toISOString());
  assert.equal((await send(env, await formPost(access, "m1@example.test", "/app/admin/calls", { action: "create", title: "x", start: `${day}T13:00`, zone: "UTC" }))).status, 403, "members cannot schedule");
  assert.equal((await send(env, await formPost(access, "boss@example.test", "/app/admin/calls", { action: "create", title: "Past", start: "2020-01-01T10:00", zone: "UTC" }))).headers.get("location"), "/app/admin/?error=call#calls");

  const before = await (await send(env, await as(access, "m1@example.test", "/app/"))).text();
  assert.match(before, /Members&#39; call/);
  assert.doesNotMatch(before, /meet\.example\.test/, "no link before booking");
  const book = async (email, want = "yes") => (await send(env, await formPost(access, email, "/app/calls/rsvp", { id: call.id, want }))).headers.get("location");
  assert.equal(await book("m1@example.test"), "/app/?call=booked#calls-h");
  assert.equal(await book("m2@example.test"), "/app/?call=booked#calls-h");
  assert.equal(await book("m3@example.test"), "/app/?call=full#calls-h", "capacity 2");
  assert.equal((await send(env, await formPost(access, "customer@example.test", "/app/calls/rsvp", { id: call.id, want: "yes" }))).status, 403, "calls are for members");
  const after = await (await send(env, await as(access, "m1@example.test", "/app/?call=booked"))).text();
  assert.match(after, /Join: <a href="https:\/\/meet\.example\.test\/c"/);
  assert.match(after, /You&#39;re booked/);
  const icsBooked = await (await send(env, await as(access, "m1@example.test", `/app/calls/${call.id}.ics`))).text();
  assert.match(icsBooked, /Join: https:\/\/meet\.example\.test\/c/);
  const icsNot = await (await send(env, await as(access, "m3@example.test", `/app/calls/${call.id}.ics`))).text();
  assert.doesNotMatch(icsNot, /meet\.example\.test/, "no link in the calendar file without a booking");
  assert.equal(await book("m1@example.test", "no"), "/app/?call=cancelled#calls-h");
  assert.equal(await book("m3@example.test"), "/app/?call=booked#calls-h", "a cancelled seat frees up");
  const admin = await (await send(env, await as(access, "boss@example.test", "/app/admin/"))).text();
  assert.match(admin, /href="mailto:\?bcc=m1%40example\.test,m2%40example\.test,m3%40example\.test&amp;subject=Constellation%20call%3A%20Members&#39;%20call&amp;body=/, "a draft to all members, Bcc");
  assert.match(admin, /Draft an email to 3 members/);
  assert.match(admin, /href="https:\/\/wa\.me\/\?text=Constellation%20group%20call/);
  assert.doesNotMatch(decodeURIComponent(admin.match(/wa\.me\/\?text=([^"]+)/)[1]), /meet\.example\.test|customer@/, "announcements never carry the call link or non-members");
});

test("group calls: each member sees times in their own zone", async () => {
  const { env, access } = await appEnv();
  await putAccount(env, { email: "kl@example.test", community: "member" }, "test");
  await saveCall(env, { title: "Call", start: "2030-01-10T12:00:00.000Z", minutes: 60, capacity: 10, link: "", notes: "" });
  assert.equal((await send(env, await formPost(access, "kl@example.test", "/app/prefs", { tz: "Asia/Kuala_Lumpur" }))).status, 303);
  const page = await (await send(env, await as(access, "kl@example.test", "/app/"))).text();
  assert.match(page, /<b>[A-Za-z]{3} 10 Jan, 20:00<\/b><span>Kuala Lumpur · [A-Za-z]{3} 10 Jan, 12:00 UTC · 60 min/);
  await send(env, await formPost(access, "kl@example.test", "/app/prefs", { tz: "Not/AZone" }));
  assert.equal((await getAccount(env, "kl@example.test")).tz, "Asia/Kuala_Lumpur", "unknown zones ignored");
});