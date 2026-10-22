// Live feeds for lightbound.uk: upcoming launches (The Space Devs Launch Library 2), space weather
// (NOAA SWPC) and Constellation's events (its public Luma calendar). A cron trigger refreshes them into KV every 15 minutes. Pages and the API only ever read
// KV, so visitor traffic never reaches the upstream services (LL2 allows 15 anonymous calls an hour).
// A failed refresh keeps the last good data and records the error; /api/health reports both.
//
// For Constellation members (signed in): space news (Spaceflight News API, also run by The Space Devs), UKRI's
// funding opportunities (RSS) and the UK Space Agency's GOV.UK feed (Atom), plus the programmes in the Gauss
// Funding Tracker, read from the one tab published as CSV (PROGRAMMES_CSV_URL, a secret). Only titles, dates,
// short summaries and official links are kept, never article text.
import { readCapped } from "./body.js";
import { isFull } from "./release.js";

// Constellation's events: the public Luma calendar. Luma publishes an iCal feed for every public calendar
// (it says to refresh every 12 hours). Only titles, times and public event links are kept: not organisers,
// descriptions, addresses or coordinates.
export const LUMA = Object.freeze({ page: "https://luma.com/constellation", id: "cal-JlCHo35H2rXUzYN" });

export const SOURCES = Object.freeze({
  events: `https://api.lu.ma/ics/get?entity=calendar&id=${LUMA.id}`,
  launches: "https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=12&mode=normal&hide_recent_previous=true",
  scales: "https://services.swpc.noaa.gov/products/noaa-scales.json",
  kp: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
  wind: "https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json",
  mag: "https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json",
  news: "https://api.spaceflightnewsapi.net/v4/articles/?limit=12&ordering=-published_at",
  ukri: "https://www.ukri.org/opportunity/feed/",
  uksa: "https://www.gov.uk/government/organisations/uk-space-agency.atom",
});

// refreshMin: how often to call upstream. staleMin: when the page starts saying "stale".
export const FEEDS = Object.freeze({
  launches: { key: "feed:launches", refreshMin: 30, staleMin: 120 },
  weather: { key: "feed:weather", refreshMin: 15, staleMin: 45 },
  // Optional: Luma being down never makes /api/health fail.
  events: { key: "feed:events", refreshMin: 180, staleMin: 1440, optional: true },
  // members: for signed-in members' opportunities only, so a public release (release.js) doesn't fetch them.
  news: { key: "feed:news", refreshMin: 60, staleMin: 720, optional: true, members: true },
  ukri: { key: "feed:ukri", refreshMin: 360, staleMin: 2880, optional: true, members: true },
  uksa: { key: "feed:uksa", refreshMin: 360, staleMin: 2880, optional: true, members: true },
  // Only once PROGRAMMES_CSV_URL is set; until then it is "not configured", not failing.
  programmes: { key: "feed:programmes", refreshMin: 180, staleMin: 2880, optional: true, members: true, needs: "PROGRAMMES_CSV_URL" },
});

const UA = "lightbound.uk-site/1 (+https://lightbound.uk)";
const MIN = 60_000;

const clean = (v, max = 140) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
// NOAA time tags often have no offset; they are UTC. Without the Z, Date.parse would use local time.
const utc = (v) => {
  if (typeof v !== "string" || !v) return null;
  const s = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(v) ? v : `${v}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const iso = (ms) => new Date(ms).toISOString();

export function normaliseLaunches(json) {
  if (!Array.isArray(json?.results)) throw new Error("LL2: no results array");
  const items = json.results
    .map((r) => ({
      id: clean(r?.id, 64),
      name: clean(r?.name),
      vehicle: clean(r?.rocket?.configuration?.full_name || r?.rocket?.configuration?.name, 80),
      mission: clean(r?.mission?.name),
      orbit: clean(r?.mission?.orbit?.abbrev, 16),
      provider: clean(r?.launch_service_provider?.name, 80),
      location: clean(r?.pad?.location?.name, 100),
      net: utc(r?.net),
      precision: clean(r?.net_precision?.abbrev, 8) || "DAY", // unknown precision: show the date only
      windowEnd: utc(r?.window_end),
      status: clean(r?.status?.abbrev, 16),
      statusName: clean(r?.status?.name, 40),
    }))
    .filter((l) => l.id && l.net && (l.name || l.vehicle));
  if (!items.length) throw new Error("LL2: no usable launches");
  return items;
}

export function normaliseWeather({ scales, kp, wind, mag }) {
  const now = scales?.["0"];
  if (!now?.G || !now?.S || !now?.R) throw new Error("NOAA scales: no current entry");
  const level = (o) => {
    const n = Number.parseInt(o?.Scale, 10);
    return Number.isInteger(n) && n >= 0 && n <= 5 ? n : null;
  };
  const scale = (o) => ({ level: level(o), text: clean(o?.Text, 20) || null });
  const out = { at: utc(`${now.DateStamp}T${now.TimeStamp}`), G: scale(now.G), S: scale(now.S), R: scale(now.R), kp: null, wind: null };
  const last = Array.isArray(kp) ? kp.at(-1) : null;
  const kpValue = num(Array.isArray(last) ? last[1] : last?.Kp);
  const kpAt = utc(Array.isArray(last) ? last[0] : last?.time_tag);
  if (kpValue !== null && kpValue >= 0 && kpValue <= 9 && kpAt) out.kp = { value: kpValue, at: kpAt };
  const w = Array.isArray(wind) ? wind[0] : null;
  const m = Array.isArray(mag) ? mag[0] : null;
  const speed = num(w?.proton_speed);
  const bz = num(m?.bz_gsm);
  if (speed !== null || bz !== null) out.wind = { speed, bz, bt: num(m?.bt), at: utc(w?.time_tag ?? m?.time_tag) };
  return out;
}

/** Luma's iCal feed -> [{ title, start, end, url }], soonest first. Unfolds lines; ignores everything else. */
export function normaliseEvents(ics) {
  if (typeof ics !== "string" || !ics.includes("BEGIN:VCALENDAR")) throw new Error("not a calendar");
  const text = ics.replace(/\r?\n[ \t]/g, "");
  const when = (v) => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v ?? "");
    return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString() : null;
  };
  const unescape = (v) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");
  const events = [];
  for (const block of text.split("BEGIN:VEVENT").slice(1)) {
    const field = (k) => (new RegExp(`^${k}(?:;[^:\\n]*)?:(.*)$`, "m").exec(block) ?? [])[1]?.trim() ?? "";
    const id = /^UID:(evt-[A-Za-z0-9]+)@/m.exec(block)?.[1];
    const page = /https:\/\/luma\.com\/[a-z0-9]{4,20}\b/.exec(field("DESCRIPTION"))?.[0];
    const start = when(field("DTSTART"));
    const title = clean(unescape(field("SUMMARY")), 120);
    if (!start || !title || (!page && !id)) continue;
    if (/^CANCELLED$/i.test(field("STATUS"))) continue;
    events.push({ title, start, end: when(field("DTEND")) ?? start, url: page ?? `https://luma.com/event/${id}` });
  }
  return events.sort((a, b) => (a.start < b.start ? -1 : 1)).slice(-60);
}

const https = (v) => {
  try {
    const u = new URL(String(v ?? ""));
    return u.protocol === "https:" ? u.href : "";
  } catch {
    return "";
  }
};
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", pound: "£", euro: "€", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…" };
/** Feed markup -> plain text: CDATA unwrapped, tags dropped, entities decoded. Pages escape it again when they render it. */
const plain = (v) => String(v ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]*>/g, " ")
  .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (m, e) => {
    const code = e[0] !== "#" ? null : e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code === null ? (NAMED[e.toLowerCase()] ?? m) : code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
const inner = (block, tag) => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(block)?.[1] ?? "";
const rfc = (v) => {
  const t = Date.parse(String(v ?? "").trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const DAY = 86_400_000;
/** This refresh's items plus earlier ones, all under 60 days old, newest first, so a call doesn't vanish when the feed moves on. */
function keepRecent(items, prev, now, cap = 30) {
  const seen = new Set(items.map((i) => i.url));
  const old = (Array.isArray(prev) ? prev : []).filter((i) => i?.url && !seen.has(i.url));
  return [...items, ...old].filter((i) => Date.parse(i.at) > now - 60 * DAY).sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, cap);
}

/** Spaceflight News API -> [{ title, url, site, at }], newest first. Titles and links only. */
export function normaliseNews(json) {
  if (!Array.isArray(json?.results)) throw new Error("news: no results array");
  return json.results
    .map((r) => ({ title: clean(r?.title, 160), url: https(r?.url), site: clean(r?.news_site, 60), at: utc(r?.published_at) }))
    .filter((n) => n.title && n.url && n.at)
    .slice(0, 10);
}

// UKRI lists every council's calls; keep the ones near our field. Matching for each member happens later (opportunities.js).
const NEAR_SPACE = /\b(space|satellites?|orbit(?:al)?|earth observation|remote sensing|launch\w*|aerospace|astronom\w*|planetary|lunar|cislunar|rockets?|telecommunications?|navigation|pnt|artificial intelligence|ai|machine learning|quantum|cyber ?security|resilien\w*)\b/i;

/** UKRI opportunities RSS -> [{ title, url, funder, summary, at }]. */
export function normaliseUkri(xml, prev = null, now = Date.now()) {
  if (typeof xml !== "string" || !/<rss[\s>]/.test(xml)) throw new Error("UKRI: not an RSS feed");
  const items = xml.split(/<item>/i).slice(1).map((b) => ({
    title: clean(plain(inner(b, "title")), 160),
    url: https(plain(inner(b, "link")).trim()),
    funder: clean(plain(inner(b, "category")), 60) || "UKRI",
    // The description ends with a coloured badge naming the council, which is already the funder.
    summary: clean(plain(inner(b, "description").replace(/<p[^>]*aria-label="Councils"[^>]*>[\s\S]*?<\/p>/gi, "")), 240),
    at: rfc(plain(inner(b, "pubDate"))),
  })).filter((i) => i.title && i.url.startsWith("https://www.ukri.org/") && i.at && NEAR_SPACE.test(`${i.title} ${i.summary}`));
  return keepRecent(items, prev, now);
}

// GOV.UK titles start with their document type ("Guidance: ..."); keep the ones about money or calls.
const CALLISH = /\b(fund\w*|grants?|calls?|competitions?|tenders?|apply|opportunit\w*|challenges?|prizes?|hackathons?|accelerat\w*|incubat\w*|programmes?)\b/i;

/** UK Space Agency Atom feed -> [{ title, url, kind, at }]. */
export function normaliseUksa(xml, prev = null, now = Date.now()) {
  if (typeof xml !== "string" || !/<feed[\s>]/.test(xml)) throw new Error("UKSA: not an Atom feed");
  const items = xml.split(/<entry>/i).slice(1).map((b) => {
    const kind = clean(plain(/<category[^>]*label="([^"]*)"/i.exec(b)?.[1]), 40);
    const title = clean(plain(inner(b, "title")), 200);
    return {
      title: clean(kind && title.startsWith(`${kind}: `) ? title.slice(kind.length + 2) : title, 160),
      url: https(plain(/<link[^>]*href="([^"]+)"/i.exec(b)?.[1])),
      kind,
      at: utc(plain(inner(b, "updated")).trim()),
    };
  }).filter((i) => i.title && i.url.startsWith("https://www.gov.uk/") && i.at && CALLISH.test(i.title));
  return keepRecent(items, prev, now);
}

/** Only a Google Sheets "Publish to web" CSV link: https://docs.google.com/spreadsheets/d/e/<id>/pub?...output=csv */
export const programmesUrl = (env) => {
  const u = String(env?.PROGRAMMES_CSV_URL ?? "").trim();
  return /^https:\/\/docs\.google\.com\/spreadsheets\/d\/e\/[A-Za-z0-9_-]{20,200}\/pub\?[A-Za-z0-9_=&-]*\boutput=csv\b[A-Za-z0-9_=&-]*$/.test(u) ? u : "";
};

/** RFC 4180 CSV -> rows of cells (quoted fields, doubled quotes, CRLF or LF). */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// The published tab's headers, matched loosely so the sheet can keep its own wording.
const COLUMNS = {
  name: /^(name|programme|program|opportunity)$/i,
  type: /^(type|category|kind)$/i,
  funder: /^(funder|organi[sz]er|organisation|organization|provider|run by)\b/i,
  deadline: /^(deadline|closes|closing date|due|due date)$/i,
  amount: /^(amount|funding|value|prize|award|indicative value)\b/i,
  eligibility: /^(eligibility|who can apply|eligible)\b/i,
  offer: /^what you get\b/i,
  tags: /^(tags|topics|keywords)$/i,
  region: /^(region|country|where)$/i,
  url: /^(link|url|website|apply|official (?:link|url))$/i,
};
/** YYYY-MM-DD, "4 Nov 2026" or "rolling"; slashed dates are refused (04/11 means different days in the UK and US). */
const deadlineOf = (v) => {
  const s = clean(v, 40);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s))) return s;
  if (/^(rolling|open|ongoing|always open)$/i.test(s)) return "rolling";
  if (/^\d{1,2} [A-Za-z]{3,9} \d{4}$/.test(s) && Number.isFinite(Date.parse(`${s} UTC`))) return new Date(Date.parse(`${s} UTC`)).toISOString().slice(0, 10);
  return null;
};

/** The tracker's published "Public programmes" tab -> [{ name, type, funder, deadline, amount, eligibility, offer, tags, region, url }]. */
export function normaliseProgrammes(csv) {
  if (typeof csv !== "string" || /^\s*<(?:!doctype|html)/i.test(csv)) throw new Error("programmes: not CSV (is the tab published as CSV?)");
  const [head = [], ...rows] = parseCsv(csv.replace(/^\uFEFF/, ""));
  const at = Object.fromEntries(Object.entries(COLUMNS).map(([k, re]) => [k, head.findIndex((h) => re.test(h.trim()))]));
  if (at.name < 0 || at.url < 0) throw new Error("programmes: needs a Name and a Link column");
  const cell = (r, k, max) => (at[k] < 0 ? "" : clean(r[at[k]], max));
  return rows.map((r) => ({
    name: cell(r, "name", 140), type: cell(r, "type", 40), funder: cell(r, "funder", 80), deadline: deadlineOf(at.deadline < 0 ? "" : r[at.deadline]),
    amount: cell(r, "amount", 60), eligibility: cell(r, "eligibility", 200), offer: cell(r, "offer", 200), tags: cell(r, "tags", 200), region: cell(r, "region", 60), url: https(at.url < 0 ? "" : r[at.url]?.trim()),
  })).filter((p) => p.name && p.url).slice(0, 150);
}

// No upstream answer we use is near this size; anything bigger is refused rather than read into memory
// (the body is read through a byte cap, so a reply without a Content-Length can't get past it either).
const MAX_FEED_BYTES = 2 * 1024 * 1024;

async function fetchText(url, fetchImpl, timeoutMs = 10_000, accept = "text/calendar") {
  const res = await fetchImpl(url, { headers: { accept, "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  const text = await readCapped(res, MAX_FEED_BYTES);
  if (text === null) throw new Error(`${new URL(url).host} response too large`);
  return text;
}

async function fetchJson(url, fetchImpl, timeoutMs = 10_000) {
  return JSON.parse(await fetchText(url, fetchImpl, timeoutMs, "application/json"));
}

const LOADERS = {
  events: async (f) => normaliseEvents(await fetchText(SOURCES.events, f)),
  news: async (f) => normaliseNews(await fetchJson(SOURCES.news, f)),
  ukri: async (f, env, prev, now) => normaliseUkri(await fetchText(SOURCES.ukri, f, 15_000, "application/rss+xml"), prev, now),
  uksa: async (f, env, prev, now) => normaliseUksa(await fetchText(SOURCES.uksa, f, 15_000, "application/atom+xml"), prev, now),
  programmes: async (f, env) => normaliseProgrammes(await fetchText(programmesUrl(env), f, 15_000, "text/csv")),
  // LL2's full-detail query can take ~20 s (measured 18 s on 2026-10-18); the cron can afford to wait.
  launches: async (f) => normaliseLaunches(await fetchJson(SOURCES.launches, f, 30_000)),
  weather: async (f) => {
    // The storm scales are required; Kp and solar wind are extras that may be missing.
    const [scales, kp, wind, mag] = await Promise.allSettled(["scales", "kp", "wind", "mag"].map((k) => fetchJson(SOURCES[k], f)));
    if (scales.status === "rejected") throw scales.reason;
    const v = (r) => (r.status === "fulfilled" ? r.value : null);
    return normaliseWeather({ scales: scales.value, kp: v(kp), wind: v(wind), mag: v(mag) });
  },
};

export async function readFeed(env, name) {
  try {
    return (await env.LIVE.get(FEEDS[name].key, { type: "json" })) ?? null;
  } catch {
    return null;
  }
}

function isDue(rec, feed, now) {
  if (!rec?.fetchedAt || rec.error) return true;
  return now - Date.parse(rec.fetchedAt) >= (feed.refreshMin - 2) * MIN; // cron jitter
}

const errorText = (err) => clean(err?.name === "TimeoutError" ? "upstream timed out" : String(err?.message ?? err), 200);

/** False for a members' feed in a public release, and for a feed that waits on a setting (PROGRAMMES_CSV_URL) that
 * isn't set, or isn't a valid published-CSV link. */
export const configured = (env, name) => (FEEDS[name].members && !isFull(env) ? false : name === "programmes" ? !!programmesUrl(env) : true);

/** Called by the cron trigger. Returns what happened to each feed, for the log. */
export async function refreshFeeds(env, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const results = {};
  for (const [name, feed] of Object.entries(FEEDS)) {
    if (!configured(env, name)) {
      results[name] = "not configured";
      continue;
    }
    const prev = await readFeed(env, name);
    if (!force && !isDue(prev, feed, now)) {
      results[name] = "fresh";
      continue;
    }
    try {
      const data = await LOADERS[name](fetchImpl, env, prev?.data ?? null, now);
      await env.LIVE.put(feed.key, JSON.stringify({ data, fetchedAt: iso(now), attemptAt: iso(now), error: null }));
      results[name] = "updated";
    } catch (err) {
      const error = errorText(err);
      await env.LIVE.put(feed.key, JSON.stringify({ data: prev?.data ?? null, fetchedAt: prev?.fetchedAt ?? null, attemptAt: iso(now), error }));
      results[name] = `failed: ${error}`;
    }
  }
  return results;
}

/** live = fresh data; stale = older than staleMin (still shown, labelled); offline = nothing to show. */
export function feedState(name, rec, now = Date.now()) {
  const fetched = rec?.fetchedAt ? Date.parse(rec.fetchedAt) : NaN;
  const ageMin = Number.isFinite(fetched) ? Math.round((now - fetched) / MIN) : null;
  const state = !rec?.data ? "offline" : ageMin > FEEDS[name].staleMin ? "stale" : "live";
  return { state, ageMin, fetchedAt: rec?.fetchedAt ?? null, attemptAt: rec?.attemptAt ?? null, error: rec?.error ?? null };
}
