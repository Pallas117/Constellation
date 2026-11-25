// The weekly Constellation Brief (/app/brief/): assembly from fixture feeds, honest labels, and who may open it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../worker/index.js";
import { FEEDS, refreshFeeds } from "../worker/feeds.js";
import { assembleBrief, isoWeek, renderBrief, stamp } from "../worker/brief.js";
import { SOURCE_REGISTER } from "../worker/sources.js";
import { putAccount } from "../worker/data.js";
import { makeFetch } from "./fixtures/fetch.mjs";
import { PROGRAMMES_URL } from "./fixtures/opportunities.mjs";
import { memoryKV } from "./fixtures/kv.mjs";
import { makeAccess } from "./fixtures/access.mjs";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const DAY = 86_400_000;
const ASSETS = {
  async fetch(input) {
    const { pathname } = new URL(input.url ?? input);
    const file = join(pub, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!existsSync(file) || !statSync(file).isFile()) return new Response("not found", { status: 404 });
    return new Response(await readFile(file), { headers: { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" } });
  },
};
async function send(env, request) {
  const pending = [];
  const res = await worker.fetch(request, env, { waitUntil: (p) => pending.push(p), passThroughOnException() {} });
  await Promise.all(pending);
  return res;
}
const as = async (access, email, path, init = {}) =>
  new Request(`https://lightbound.space${path}`, { ...init, headers: { ...(init.headers ?? {}), "cf-access-jwt-assertion": await access.sign(email) } });
async function appEnv() {
  const access = await makeAccess();
  return { access, env: { ASSETS, LIVE: memoryKV(), DATA: memoryKV(), RELEASE: "full", ADMIN_EMAILS: "boss@example.test", PROGRAMMES_CSV_URL: PROGRAMMES_URL, ...access.env } };
}

// Hand-built feed records, as the cron stores them: { data, fetchedAt, attemptAt, error }.
const NOW = Date.parse("2026-11-18T14:30:00Z"); // a Wednesday in ISO week 47
const at = (days, from = NOW) => new Date(from + days * DAY).toISOString();
const rec = (data, fetched = "2026-11-18T14:20:00.000Z") => ({ data, fetchedAt: fetched, attemptAt: fetched, error: null });
const launch = (id, net, extra = {}) => ({ id, name: "Example Rocket | Example Sat", vehicle: "Example Rocket", mission: "Example Sat", orbit: "LEO", provider: "Example Launch Co",
  location: "Example Spaceport", net, precision: "MIN", windowEnd: net, status: "Go", statusName: "Go for Launch", ...extra });
const feedsAt = (now) => ({
  launches: rec([
    launch("11111111-1111-4111-8111-111111111111", at(2, now)),
    launch("22222222-2222-4222-8222-222222222222", at(6.9, now), { mission: "Unknown Payload", precision: "DAY" }),
    launch("33333333-3333-4333-8333-333333333333", at(8, now), { mission: "Next week's sat" }),
    launch("44444444-4444-4444-8444-444444444444", at(3, now), { mission: "Month-only sat", precision: "M" }),
    launch("55555555-5555-4555-8555-555555555555", at(-1, now), { mission: "Already flown" }),
  ], at(-10 / 1440, now)),
  weather: rec({ at: at(-12 / 1440, now), G: { level: 1, text: "minor" }, S: { level: 0, text: "none" }, R: { level: 0, text: "none" }, kp: { value: 4.67, at: at(-0.1, now) }, wind: { speed: 512, bz: -4, bt: 7, at: at(-0.01, now) } }, at(-10 / 1440, now)),
  events: rec([
    { title: "Example Constellation night", start: at(5, now), end: at(5.1, now), url: "https://luma.com/example1" },
    { title: "Example summit", start: at(20, now), end: at(20.2, now), url: "https://luma.com/example2" },
    { title: "Example past meetup", start: at(-3, now), end: at(-2.9, now), url: "https://luma.com/example3" },
    { title: "Not on Luma", start: at(2, now), end: at(2.1, now), url: "https://elsewhere.example.test/e" },
  ], at(-10 / 1440, now)),
  news: rec(Array.from({ length: 7 }, (_, i) => ({ title: `Example headline ${i + 1}`, url: `https://news.example.test/${i + 1}`, site: "Example Space News", at: at(-(i + 1) * 0.5, now) })), at(-10 / 1440, now)),
  ukri: rec([
    { title: "Example: satellite data for flood resilience", url: "https://www.ukri.org/opportunity/example-flood/", funder: "Innovate UK", summary: "SUMMARY-TEXT-THAT-MUST-NOT-APPEAR in the brief.", at: at(-2, now) },
    { title: "Example: older space call", url: "https://www.ukri.org/opportunity/example-older/", funder: "STFC", summary: "SUMMARY-TEXT-THAT-MUST-NOT-APPEAR either.", at: at(-20, now) },
  ], at(-10 / 1440, now)),
  uksa: rec([{ title: "Example student hackathon call", url: "https://www.gov.uk/government/publications/example-call", kind: "Guidance", at: at(-1, now) }], at(-10 / 1440, now)),
  programmes: rec([
    { name: "Example Space Accelerator", type: "Accelerator", funder: "Example Ventures", deadline: at(10, now).slice(0, 10), amount: "Up to $100,000", eligibility: "Startups", offer: "", tags: "", region: "Global", url: "https://accelerator.example.test/apply" },
    { name: "Example far grant", type: "Grant", funder: "Example Council", deadline: at(45, now).slice(0, 10), amount: "", eligibility: "", offer: "", tags: "", region: "UK", url: "https://grant.example.test/far" },
    { name: "Example closed grant", type: "Grant", funder: "Example Council", deadline: at(-5, now).slice(0, 10), amount: "", eligibility: "", offer: "", tags: "", region: "UK", url: "https://grant.example.test/closed" },
    { name: "Example rolling incubator", type: "Incubator", funder: "Example Agency", deadline: "rolling", amount: "", eligibility: "", offer: "", tags: "", region: "UK", url: "https://incubation.example.test/" },
  ], at(-10 / 1440, now)),
});
const byId = (brief, id) => brief.sections.find((s) => s.id === id);
const titles = (brief, id) => byId(brief, id).items.map((i) => i.title);

test("brief: ISO weeks run Monday to Sunday and cross a year end correctly", () => {
  const week = (d) => isoWeek(Date.parse(d));
  assert.deepEqual(week("2026-11-18T14:30:00Z"), { year: 2026, week: 47, id: "2026-W47", start: "2026-11-16T00:00:00.000Z", end: "2026-11-23T00:00:00.000Z" });
  assert.equal(week("2026-11-22T23:59:59Z").id, "2026-W47", "Sunday night is still the same week");
  assert.equal(week("2026-11-23T00:00:00Z").id, "2026-W48", "Monday 00:00 UTC starts the next");
  assert.equal(week("2026-12-31T12:00:00Z").id, "2026-W53", "2026 has 53 weeks");
  assert.equal(week("2027-01-01T12:00:00Z").id, "2026-W53", "1 Jan 2027 is a Friday, still in 2026's last week");
  assert.equal(week("2027-01-03T23:59:59Z").id, "2026-W53");
  assert.equal(week("2027-01-04T00:00:00Z").id, "2027-W01");
  assert.equal(week("2024-12-30T08:00:00Z").id, "2025-W01", "a late-December Monday can belong to the next year");
  assert.equal(week("2021-01-03T08:00:00Z").id, "2020-W53");
  // A brief assembled over the year end: one week label, and the 7-day window reaches into January.
  const now = Date.parse("2026-12-30T09:00:00Z");
  const brief = assembleBrief(feedsAt(now), { now });
  assert.equal(brief.week.id, "2026-W53");
  assert.deepEqual(titles(brief, "orbit"), ["Example Rocket · Example Sat", "Example Rocket · payload not announced"]);
  assert.equal(byId(brief, "orbit").items[0].when.at, "2027-01-01T09:00:00.000Z");
  assert.match(renderBrief(brief), /<b>Week 53<\/b><span>28 Dec 2026 to 3 Jan 2027<\/span><span>2026-W53<\/span>/);
});

test("brief: five sections in a fixed order, each inside its own window; the same feeds and moment give the same brief", () => {
  const brief = assembleBrief(feedsAt(NOW), { now: NOW });
  assert.deepEqual(brief.sections.map((s) => s.title), ["This week in orbit", "Space weather", "Events", "Funding and calls", "Headlines"]);
  assert.deepEqual(brief, assembleBrief(feedsAt(NOW), { now: NOW }), "deterministic");
  assert.deepEqual(titles(brief, "orbit"), ["Example Rocket · Example Sat", "Example Rocket · payload not announced"], "next 7 days, dated launches only, none already flown");
  assert.deepEqual(titles(brief, "weather"), ["NOAA scales: G1 · S0 · R0", "Planetary Kp 4.7", "Solar wind 512 km/s at L1"]);
  assert.match(byId(brief, "weather").after, /no alert history/, "the feed has no 7-day alerts, and the brief says so instead of inventing them");
  assert.deepEqual(titles(brief, "events"), ["Example Constellation night"], "Luma events in the next 14 days");
  assert.deepEqual(titles(brief, "funding"), ["Example Space Accelerator", "Example student hackathon call", "Example: satellite data for flood resilience"], "deadlines within 30 days, then calls posted in the last 7");
  assert.equal(titles(brief, "headlines").length, 5, "at most five headlines");
  assert.deepEqual(brief.sections.map((s) => s.confidence.label), ["likely", "confirmed", "confirmed", "likely", "unverified"]);
  for (const s of brief.sections) assert.ok(s.confidence.reason.length > 20 && !s.confidence.reason.includes("\n"), `${s.id} gives a one-line reason`);
});

test("brief: every line has an https source link, a source name and when the site fetched it", () => {
  const brief = assembleBrief(feedsAt(NOW), { now: NOW });
  const all = brief.sections.flatMap((s) => s.items);
  assert.ok(all.length >= 12);
  for (const i of all) {
    assert.match(i.url, /^https:\/\/[^\s"<>]+$/, i.title);
    assert.ok(i.source, i.title);
    assert.equal(stamp(i.fetchedAt), "18 Nov 14:20 UTC", i.title);
  }
  assert.equal(byId(brief, "orbit").items[0].url, "https://ll.thespacedevs.com/2.3.0/launches/11111111-1111-4111-8111-111111111111/");
  const html = renderBrief(brief);
  const lines = html.match(/<li class="brief-item">[\s\S]*?<\/li>/g);
  assert.equal(lines.length, all.length);
  for (const li of lines) {
    assert.match(li, /<a href="https:\/\/[^"]+" rel="noopener noreferrer">[^<]+<\/a>/);
    assert.match(li, /<span class="brief-src">[^<]+ · fetched 18 Nov 14:20 UTC<\/span>/);
  }
  assert.doesNotMatch(html, /<script|onclick|style=/i, "no script, no inline style");
  // The fallback launch list is credited the way RocketLaunch.Live asks.
  const fallback = assembleBrief({ ...feedsAt(NOW), launches: rec([{ ...launch("rl-9001", at(1)), source: "rocketlaunch" }]) }, { now: NOW });
  assert.deepEqual([byId(fallback, "orbit").items[0].source, byId(fallback, "orbit").items[0].url], ["Data by RocketLaunch.Live", "https://www.rocketlaunch.live/"]);
});

test("brief: UKRI items carry title, link and date only, never the stored summary", () => {
  const brief = assembleBrief(feedsAt(NOW), { now: NOW });
  const ukri = byId(brief, "funding").items.find((i) => i.url.startsWith("https://www.ukri.org/"));
  assert.deepEqual(ukri, { title: "Example: satellite data for flood resilience", detail: "Closing date: on the UKRI page.", url: "https://www.ukri.org/opportunity/example-flood/",
    source: "UKRI funding opportunities", fetchedAt: "2026-11-18T14:20:00.000Z", when: { kind: "text", text: "Posted 16 Nov 2026" } });
  assert.doesNotMatch(JSON.stringify(brief), /SUMMARY-TEXT-THAT-MUST-NOT-APPEAR/);
  assert.doesNotMatch(renderBrief(brief), /SUMMARY-TEXT-THAT-MUST-NOT-APPEAR/);
});

test("brief: an empty section says so honestly; a stale or offline feed is labelled and never passed off as current", () => {
  const feeds = feedsAt(NOW);
  // Empty but live: an honest "nothing this week".
  const quiet = assembleBrief({ ...feeds, launches: rec([launch("33333333-3333-4333-8333-333333333333", at(9))]), events: rec([]), news: rec([]), ukri: rec([]), uksa: rec([]), programmes: rec([]) }, { now: NOW });
  const quietHtml = renderBrief(quiet);
  for (const id of ["orbit", "events", "funding", "headlines"]) {
    assert.equal(byId(quiet, id).items.length, 0);
    assert.match(byId(quiet, id).empty, /^Nothing this week: /);
  }
  assert.equal((quietHtml.match(/<p class="brief-empty">Nothing this week: /g) ?? []).length, 4);
  assert.equal(byId(quiet, "orbit").confidence.label, "likely", "empty is not the same as broken");

  // Stale: launches last fetched two days ago (staleMin is 120). Still shown, as of then, and the confidence drops.
  const stale = assembleBrief({ ...feeds, launches: { ...feeds.launches, fetchedAt: "2026-11-16T02:10:00.000Z", attemptAt: "2026-11-18T14:15:00.000Z", error: "ll.thespacedevs.com HTTP 429" } }, { now: NOW });
  const orbit = byId(stale, "orbit");
  assert.equal(orbit.feeds[0].state, "stale");
  assert.equal(orbit.feeds[0].note, "Launch data is stale: last fetched 16 Nov 02:10 UTC. It is shown as it stood then, not as current.");
  assert.equal(orbit.confidence.label, "unverified");
  assert.ok(orbit.items.every((i) => stamp(i.fetchedAt) === "16 Nov 02:10 UTC"), "each line keeps the real fetch time");
  const staleHtml = renderBrief(stale);
  assert.match(staleHtml, /<p class="brief-state warn">Launch data is stale: last fetched 16 Nov 02:10 UTC\./);
  assert.doesNotMatch(staleHtml, /HTTP 429/, "upstream error text stays out of the page");

  // Offline: nothing was ever fetched, or the record holds no data. Said plainly; no "nothing this week" claim.
  const down = assembleBrief({ ...feeds, launches: { data: null, fetchedAt: null, attemptAt: "2026-11-18T14:15:00.000Z", error: "upstream timed out" }, weather: null, news: undefined }, { now: NOW });
  assert.equal(byId(down, "orbit").feeds[0].note, "Launch data is offline since 18 Nov 14:15 UTC: no fetch has succeeded.");
  assert.equal(byId(down, "weather").feeds[0].note, "Space-weather data is offline: nothing has been fetched yet.");
  assert.deepEqual(["orbit", "weather", "headlines"].map((id) => [byId(down, id).items.length, byId(down, id).confidence.label]), [[0, "unverified"], [0, "unverified"], [0, "unverified"]]);
  const downHtml = renderBrief(down);
  assert.match(downHtml, /Launch data is offline since 18 Nov 14:15 UTC/);
  assert.match(downHtml, /Headline data is offline/);
  assert.equal((downHtml.match(/id="(orbit|weather|events|funding|headlines)"/g) ?? []).length, 5, "a broken feed's section is never dropped");
  assert.doesNotMatch(downHtml.match(/<section class="brief-sec" id="orbit"[\s\S]*?<\/section>/)[0], /Nothing this week/);

  // A refresh that failed while the data is still fresh is mentioned; a feed this deploy doesn't fetch is "not connected".
  const failed = assembleBrief({ ...feeds, events: { ...feeds.events, attemptAt: "2026-11-18T14:25:00.000Z", error: "api.lu.ma HTTP 500" } }, { now: NOW, isConfigured: (n) => n !== "programmes" });
  assert.match(byId(failed, "events").feeds[0].note, /^The latest refresh of events data failed at 18 Nov 14:25 UTC; this is the data fetched 18 Nov 14:20 UTC\.$/);
  assert.equal(byId(failed, "funding").feeds[0].note, "Programme data is not connected yet.");
});

test("brief: times follow the member's zone through the site's time-zone helpers; text from feeds is escaped", () => {
  const feeds = feedsAt(NOW);
  feeds.events = rec([{ title: `<img src=x onerror=alert(1)> "night"`, start: "2026-11-20T12:00:00.000Z", end: "2026-11-20T14:00:00.000Z", url: "https://luma.com/example1" }]);
  const brief = assembleBrief(feeds, { now: NOW });
  const kl = renderBrief(brief, { tz: "Asia/Kuala_Lumpur" });
  assert.match(kl, /<time class="brief-when" datetime="2026-11-20T12:00:00.000Z"><b>Fri 20 Nov, 20:00<\/b><span>Kuala Lumpur · Fri 20 Nov, 12:00 UTC<\/span><\/time>/);
  assert.match(kl, /times in Kuala Lumpur/);
  const ny = renderBrief(brief, { tz: "America/New_York" });
  assert.match(ny, /<b>Fri 20 Nov, 07:00<\/b><span>New York · Fri 20 Nov, 12:00 UTC<\/span>/);
  const utc = renderBrief(brief, { tz: "Not/AZone" });
  assert.match(utc, /<b>Fri 20 Nov, 12:00<\/b><span>UTC<\/span>/, "an unknown zone falls back to UTC");
  assert.doesNotMatch(kl, /<img/);
  assert.match(kl, /&lt;img src=x onerror=alert\(1\)&gt; &quot;night&quot;/);
});

test("brief sources: one register row per cached feed; 'checked' only with a terms page and a date; rendered at the bottom", () => {
  const covered = new Set(SOURCE_REGISTER.flatMap((s) => s.feeds));
  for (const name of Object.keys(FEEDS)) assert.ok(covered.has(name), `no register row for the ${name} feed`);
  assert.equal(new Set(SOURCE_REGISTER.map((s) => s.id)).size, SOURCE_REGISTER.length);
  for (const s of SOURCE_REGISTER) {
    assert.ok(["checked", "unverified"].includes(s.status), s.id);
    assert.ok(s.name && s.stores && s.note, s.id);
    if (s.status === "checked") {
      assert.match(s.terms, /^https:\/\//, `${s.id}: a checked row names the terms page that was read`);
      assert.match(s.checked, /^\d{4}-\d{2}-\d{2}$/, `${s.id}: and the date`);
    } else assert.equal(s.checked, null, `${s.id}: an unverified row has no checked date`);
  }
  assert.match(SOURCE_REGISTER.find((s) => s.id === "ukri").note, /NonCommercial-ShareAlike 4\.0/);
  const html = renderBrief(assembleBrief(feedsAt(NOW), { now: NOW }));
  assert.ok(html.indexOf('id="sources-h">Sources</h2>') > html.indexOf('id="headlines"'), "Sources comes after the last section");
  assert.equal((html.match(/<li class="brief-source">/g) ?? []).length, SOURCE_REGISTER.length);
  assert.match(html, /Terms checked 18 Nov 2026/);
  assert.match(html, /Terms unverified/);
  // The page's vocabulary matches "How we share" on the public Constellation page.
  for (const rule of ["Open sources only.", "Unclassified only. Nothing export-controlled, nothing operational.", "Confidence is stated: confirmed, likely or unverified.", "No targeting, and no personal data about individuals."]) assert.ok(html.includes(rule), rule);
  assert.doesNotMatch(html, /\b(compliant|certified|space-qualified|post-quantum)\b/i);
});

test("brief route: 404 in the public release; signed out 401; non-members sent back; members and admins get 200", async () => {
  const { env, access } = await appEnv();
  await refreshFeeds(env, { fetchImpl: makeFetch({}, { shiftTo: Date.now() }) });
  await putAccount(env, { email: "member@example.test", name: "Grace Example", community: "member", tz: "Asia/Kuala_Lumpur" }, "test");
  await putAccount(env, { email: "pilot@example.test", tier: "pilot", billing: { status: "due" } }, "test");

  // Public release: closed like the other members' pages, signed in or not, whatever the method; a half-configured "full" too.
  const closed = { ...env, RELEASE: "public" };
  for (const path of ["/app/brief/", "/app/brief"]) {
    for (const method of ["GET", "HEAD", "POST"]) {
      const res = await send(closed, await as(access, "member@example.test", path, { method }));
      assert.equal(res.status, 404, `${method} ${path}`);
      if (method === "GET") assert.doesNotMatch(await res.text(), /Constellation Brief|brief-item/);
    }
  }
  assert.equal((await send({ ...env, DATA: undefined }, await as(access, "member@example.test", "/app/brief/"))).status, 404, "full without the DATA namespace stays public");

  // Full release.
  const out = await send(env, new Request("https://lightbound.space/app/brief/"));
  assert.equal(out.status, 401, "signed out: the same 401 as the workspace");
  assert.doesNotMatch(await out.text(), /brief-item/);
  assert.equal((await send(env, new Request("https://lightbound.space/app/brief/", { headers: { "cf-access-jwt-assertion": "not.a.token" } }))).status, 401);
  for (const who of ["pilot@example.test", "stranger@example.test"]) {
    const res = await send(env, await as(access, who, "/app/brief/"));
    assert.deepEqual([res.status, res.headers.get("location")], [303, "/app/"], `${who} is not a member`);
  }
  const res = await send(env, await as(access, "member@example.test", "/app/brief/"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(res.headers.get("x-robots-tag"), "noindex");
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  const html = await res.text();
  assert.match(html, /<h1 id="hero-h">Constellation Brief<\/h1>/);
  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  for (const title of ["This week in orbit", "Space weather", "Events", "Funding and calls", "Headlines", "Sources"]) assert.ok(html.includes(`>${title}</h2>`), title);
  assert.match(html, /times in Kuala Lumpur/, "the zone comes from the signed-in member's own account");
  assert.match(html, /<li class="brief-item">/);
  assert.doesNotMatch(html, /Grace Example|member@example\.test/, "no member name or email in the brief");
  assert.doesNotMatch(html, /<script/i);
  assert.equal((await send(env, await as(access, "boss@example.test", "/app/brief/"))).status, 200, "admins can read it");
  const bare = await send(env, await as(access, "member@example.test", "/app/brief"));
  assert.deepEqual([bare.status, bare.headers.get("location")], [303, "/app/brief/"]);
  // Reading the brief changes nothing and makes no upstream call.
  const before = JSON.stringify([...env.DATA.map.keys()].sort());
  const liveBefore = JSON.stringify([...env.LIVE.map.entries()]);
  await send(env, await as(access, "member@example.test", "/app/brief/"));
  assert.equal(JSON.stringify([...env.DATA.map.keys()].sort()), before);
  assert.equal(JSON.stringify([...env.LIVE.map.entries()]), liveBefore);
  // The members' card links to it; a POST to the page is refused.
  assert.match(await (await send(env, await as(access, "member@example.test", "/app/"))).text(), /<a href="\/app\/brief\/">This week's Constellation Brief<\/a>/);
  const post = await send(env, await as(access, "member@example.test", "/app/brief/", { method: "POST", body: "x=1", headers: { origin: "https://lightbound.space", "content-type": "application/x-www-form-urlencoded" } }));
  assert.equal(post.status, 403);
});

test("brief route: a failing feed cache still renders the page, with every feed marked offline", async () => {
  const { env, access } = await appEnv();
  await putAccount(env, { email: "member@example.test", community: "member" }, "test");
  const broken = { ...env, LIVE: { get: async () => { throw new Error("KV down"); }, put: async () => {} } };
  const res = await send(broken, await as(access, "member@example.test", "/app/brief/"));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Launch data is offline: nothing has been fetched yet\./);
  assert.doesNotMatch(html, /<li class="brief-item">/);
});
