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

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIN = 60_000;

function memoryKV() {
  const m = new Map();
  return { map: m, get: async (k, o) => (m.has(k) ? ((o?.type ?? o) === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => void m.set(k, String(v)) };
}
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
