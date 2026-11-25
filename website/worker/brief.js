// The Constellation Brief: one page a week for Constellation members (/app/brief/), assembled only from the feeds the
// cron already caches in KV (feeds.js). Nothing new is fetched, stored or scheduled: the page reads the cached feeds
// when a member opens it, so the same feeds and the same moment always give the same brief.
//
// What the Constellation page promises under "How we share" holds here: open sources only, every line links to where
// it came from and says when the site fetched it, each section states its confidence (confirmed, likely or
// unverified) with a reason, and nothing is about a private individual. A feed that is stale or offline is said to
// be so; its section never shows old data as current, and never goes quiet.
// UKRI items show title, link and posting date only (UKRI's content is CC BY-NC-SA; see sources.js).
import { FEEDS, LAUNCH_CREDIT, SOURCES, feedState, launchesSource } from "./feeds.js";
import { esc, weatherSummary, whenText } from "./render.js";
import { SOURCE_REGISTER } from "./sources.js";
import { formatIn, isZone, zoneLabel } from "./timezones.js";

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");
const PRECISE = new Set(["SEC", "MIN", "HR"]);
const NB = " ";

/** "18 Nov 14:20 UTC": when the site fetched something. */
export const stamp = (iso) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC` : "unknown";
};
const dayText = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };

/** The ISO 8601 week of a moment (UTC): weeks start on Monday, and week 1 is the one holding the year's first Thursday. */
export function isoWeek(ms) {
  const d = new Date(ms);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const start = midnight - ((d.getUTCDay() + 6) % 7) * DAY; // Monday 00:00 UTC
  const year = new Date(start + 3 * DAY).getUTCFullYear(); // the week belongs to its Thursday's year
  const jan4 = Date.UTC(year, 0, 4);
  const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const week = Math.round((start - week1) / (7 * DAY)) + 1;
  return { year, week, id: `${year}-W${pad(week)}`, start: new Date(start).toISOString(), end: new Date(start + 7 * DAY).toISOString() };
}

const WINDOWS = Object.freeze({ launches: 7, events: 14, deadlines: 30, posted: 7, headlines: 7 });
const NOUN = { launches: "Launch", weather: "Space-weather", events: "Events", news: "Headline", ukri: "UKRI call", uksa: "UK Space Agency notice", programmes: "Programme" };
const https = (u) => /^https:\/\/[^\s"<>\\]+$/.test(u ?? "");

/** How one feed stands, and the sentence the brief shows when it is not simply live. */
function standing(name, rec, now, isConfigured) {
  if (!isConfigured) return { name, state: "off", fetchedAt: null, note: `${NOUN[name]} data is not connected yet.` };
  const s = feedState(name, rec, now);
  let note = "";
  if (s.state === "offline") {
    note = s.attemptAt ? `${NOUN[name]} data is offline since ${stamp(s.attemptAt)}: no fetch has succeeded.` : `${NOUN[name]} data is offline: nothing has been fetched yet.`;
  } else if (s.state === "stale") {
    note = `${NOUN[name]} data is stale: last fetched ${stamp(s.fetchedAt)}. It is shown as it stood then, not as current.`;
  } else if (s.error && s.attemptAt) {
    note = `The latest refresh of ${NOUN[name].toLowerCase()} data failed at ${stamp(s.attemptAt)}; this is the data fetched ${stamp(s.fetchedAt)}.`;
  }
  return { name, state: s.state, fetchedAt: s.fetchedAt, note };
}

/** A section's stated confidence: its usual label and reason, lowered to "unverified" when its data is stale or missing. */
function confidence(feeds, usual) {
  const usable = feeds.filter((f) => f.state === "live" || f.state === "stale");
  if (!usable.length) return { label: "unverified", reason: "No data from this section's source right now." };
  if (usable.some((f) => f.state === "stale")) return { label: "unverified", reason: "The data is stale, so it may have changed since it was fetched." };
  return usual;
}

const launchTitle = (l) => {
  const mission = /^unknown payload$/i.test(String(l.mission ?? "").trim()) ? "payload not announced" : l.mission;
  return l.vehicle && mission ? `${l.vehicle} · ${mission}` : l.name || l.vehicle;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function orbitSection(rec, now, isConfigured) {
  const feed = standing("launches", rec, now, isConfigured);
  const from = launchesSource(rec);
  const items = (Array.isArray(rec?.data) ? rec.data : [])
    .filter((l) => l?.net && (PRECISE.has(l.precision) || l.precision === "DAY")) // a month-only estimate is not "this week"
    .filter((l) => Date.parse(l.windowEnd ?? l.net) >= now - 3_600_000 && Date.parse(l.net) < now + WINDOWS.launches * DAY)
    .sort((a, b) => (a.net < b.net ? -1 : 1)).slice(0, 12)
    .map((l) => ({
      title: launchTitle(l), detail: [l.provider, l.location, l.statusName || l.status].filter(Boolean).join(" · "),
      when: { kind: PRECISE.has(l.precision) ? "time" : "text", at: l.net, approx: l.precision === "HR", text: whenText(l.net, l.precision) },
      // Launch Library 2 has a page for each launch; RocketLaunch.Live's free list gives no address for one, so its lines link to its schedule.
      url: from === "ll2" && UUID.test(l.id) ? `https://ll.thespacedevs.com/2.3.0/launches/${l.id}/` : from === "ll2" ? "https://ll.thespacedevs.com/2.3.0/launches/upcoming/" : "https://www.rocketlaunch.live/",
      source: LAUNCH_CREDIT[from], fetchedAt: rec.fetchedAt,
    }));
  return {
    id: "orbit", label: "01_ORBIT", title: "This week in orbit", scope: `Orbital launch attempts worldwide in the next ${WINDOWS.launches} days.`,
    feeds: [feed], items, empty: "Nothing this week: no launch with a set date in the next 7 days.",
    confidence: confidence([feed], { label: "likely", reason: "Launch dates slip often; each line carries the status its source gave." }),
  };
}

function weatherSection(rec, now, isConfigured) {
  const feed = standing("weather", rec, now, isConfigured);
  const w = rec?.data;
  const items = [];
  if (w) {
    const line = (title, detail, url) => items.push({ title, detail, url, when: { kind: "text", text: stamp(w.at ?? rec.fetchedAt) }, source: "NOAA Space Weather Prediction Center", fetchedAt: rec.fetchedAt });
    line(`NOAA scales: ${["G", "S", "R"].map((k) => `${k}${w[k]?.level ?? "?"}`).join(" · ")}`, weatherSummary(w), SOURCES.scales);
    if (w.kp) line(`Planetary Kp${NB}${w.kp.value.toFixed(1)}`, `3-hour interval from ${stamp(w.kp.at)}. Kp 5 or more is a geomagnetic storm.`, SOURCES.kp);
    if (w.wind && w.wind.speed !== null) line(`Solar wind ${Math.round(w.wind.speed)}${NB}km/s at L1`, w.wind.bz !== null ? `Bz ${w.wind.bz > 0 ? "+" : ""}${w.wind.bz}${NB}nT (GSM).` : "", SOURCES.wind);
  }
  return {
    id: "weather", label: "02_SPACE_WEATHER", title: "Space weather", scope: "The level NOAA reported when the site last fetched it.",
    feeds: [feed], items, empty: "",
    // The cached feed is NOAA's current readings; it carries no alert history, and the brief does not invent one.
    after: w ? "Alerts from the last 7 days are not listed: the feed the site caches carries current readings only, with no alert history." : "",
    confidence: confidence([feed], { label: "confirmed", reason: "NOAA's own published readings, at the time shown on each line." }),
  };
}

function eventsSection(rec, now, isConfigured) {
  const feed = standing("events", rec, now, isConfigured);
  const items = (Array.isArray(rec?.data) ? rec.data : [])
    .filter((e) => /^https:\/\/luma\.com\//.test(e?.url ?? "") && Date.parse(e.end ?? e.start) > now && Date.parse(e.start) < now + WINDOWS.events * DAY)
    .sort((a, b) => (a.start < b.start ? -1 : 1)).slice(0, 12)
    .map((e) => ({ title: e.title, detail: "", when: { kind: "time", at: e.start }, url: e.url, source: "Constellation calendar on Luma", fetchedAt: rec.fetchedAt }));
  return {
    id: "events", label: "03_EVENTS", title: "Events", scope: `Community events on the Constellation calendar in the next ${WINDOWS.events} days.`,
    feeds: [feed], items, empty: "Nothing this week: no event on the Constellation calendar in the next 14 days.",
    confidence: confidence([feed], { label: "confirmed", reason: "Read from Constellation's own calendar; the event page has the venue and any change." }),
  };
}

function fundingSection({ programmes, ukri, uksa }, now, isConfigured) {
  const feeds = [standing("programmes", programmes, now, isConfigured("programmes")), standing("ukri", ukri, now, isConfigured("ukri")), standing("uksa", uksa, now, isConfigured("uksa"))];
  const today = new Date(now).toISOString().slice(0, 10);
  const until = new Date(now + WINDOWS.deadlines * DAY).toISOString().slice(0, 10);
  const closing = (Array.isArray(programmes?.data) ? programmes.data : [])
    .filter((p) => https(p?.url) && /^\d{4}-\d{2}-\d{2}$/.test(p.deadline ?? "") && p.deadline >= today && p.deadline <= until)
    .sort((a, b) => (a.deadline < b.deadline ? -1 : 1)).slice(0, 12)
    .map((p) => {
      const days = Math.round((Date.parse(p.deadline) - Date.parse(today)) / DAY);
      return { title: p.name, detail: [p.type, p.funder, p.region].filter(Boolean).join(" · "), url: p.url, source: "Programmes we track", fetchedAt: programmes.fetchedAt,
        when: { kind: "text", text: `Closes ${dayText(Date.parse(p.deadline))}`, sub: days === 0 ? "today" : `in ${days} day${days === 1 ? "" : "s"}` } };
    });
  const recent = (rec) => (Array.isArray(rec?.data) ? rec.data : []).filter((i) => https(i?.url) && Date.parse(i.at) > now - WINDOWS.posted * DAY && Date.parse(i.at) <= now);
  // UKRI: title, link and posting date only. Its feed carries no closing date, and the stored summary is never shown here.
  const posted = [
    ...recent(ukri).map((i) => ({ title: i.title, detail: "Closing date: on the UKRI page.", url: i.url, source: "UKRI funding opportunities", fetchedAt: ukri.fetchedAt, at: i.at })),
    ...recent(uksa).map((i) => ({ title: i.title, detail: i.kind ? `${i.kind}. Dates: on the GOV.UK page.` : "Dates: on the GOV.UK page.", url: i.url, source: "UK Space Agency on GOV.UK", fetchedAt: uksa.fetchedAt, at: i.at })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 8)
    .map(({ at, ...i }) => ({ ...i, when: { kind: "text", text: `Posted ${dayText(Date.parse(at))}` } }));
  return {
    id: "funding", label: "04_FUNDING", title: "Funding and calls", scope: `Deadlines in the next ${WINDOWS.deadlines} days, then calls posted in the last ${WINDOWS.posted} days.`,
    feeds, items: [...closing, ...posted], empty: "Nothing this week: no tracked deadline in the next 30 days and no new call in the last 7.",
    confidence: confidence(feeds, { label: "likely", reason: "Tracked deadlines are entered by hand, and the official feeds give no closing dates: check the official page." }),
  };
}

function headlinesSection(rec, now, isConfigured) {
  const feed = standing("news", rec, now, isConfigured);
  const items = (Array.isArray(rec?.data) ? rec.data : [])
    .filter((n) => https(n?.url) && Date.parse(n.at) > now - WINDOWS.headlines * DAY)
    .sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 5)
    .map((n) => ({ title: n.title, detail: "", when: { kind: "text", text: dayText(Date.parse(n.at)) }, url: n.url, source: `${n.site || "Outlet not named"}, via the Spaceflight News API`, fetchedAt: rec.fetchedAt }));
  return {
    id: "headlines", label: "05_HEADLINES", title: "Headlines", scope: "At most five space news headlines from the last 7 days, newest first.",
    feeds: [feed], items, empty: "Nothing this week: no headline in the last 7 days.",
    confidence: confidence([feed], { label: "unverified", reason: "Headlines as each outlet published them; the reporting has not been checked by us." }),
  };
}

/**
 * The week's brief as data. feeds: the KV records ({ data, fetchedAt, attemptAt, error }) by feed name; isConfigured:
 * whether this deploy fetches that feed at all. Pure: the same records and `now` always give the same brief.
 */
export function assembleBrief(feeds, { now = Date.now(), isConfigured = () => true } = {}) {
  return {
    week: isoWeek(now),
    assembledAt: new Date(now).toISOString(),
    sections: [
      orbitSection(feeds.launches, now, isConfigured("launches")),
      weatherSection(feeds.weather, now, isConfigured("weather")),
      eventsSection(feeds.events, now, isConfigured("events")),
      fundingSection(feeds, now, isConfigured),
      headlinesSection(feeds.news, now, isConfigured("news")),
    ],
  };
}

// ---- Rendering ----
const CONFIDENCE = { confirmed: "Confirmed", likely: "Likely", unverified: "Unverified" };

function whenCell(when, tz) {
  if (when.kind !== "time") return `<span class="brief-when"><b>${esc(when.text)}</b>${when.sub ? `<span>${esc(when.sub)}</span>` : ""}</span>`;
  const t = Date.parse(when.at);
  const utc = `${formatIn(t, "UTC")} UTC`;
  return `<time class="brief-when" datetime="${esc(when.at)}"><b>${when.approx ? "~" : ""}${esc(formatIn(t, tz))}</b><span>${esc(tz === "UTC" ? "UTC" : `${zoneLabel(tz)} · ${utc}`)}</span></time>`;
}

const line = (i, tz) =>
  `<li class="brief-item">${whenCell(i.when, tz)}<div class="brief-what"><a href="${esc(i.url)}" rel="noopener noreferrer">${esc(i.title)}</a>` +
  (i.detail ? `<span class="brief-detail">${esc(i.detail)}</span>` : "") +
  `<span class="brief-src">${esc(i.source)} · fetched ${esc(stamp(i.fetchedAt))}</span></div></li>`;

function section(s, tz) {
  const usable = s.feeds.some((f) => f.state === "live" || f.state === "stale");
  const notes = s.feeds.filter((f) => f.note).map((f) => `<p class="brief-state${f.state === "off" ? "" : " warn"}">${esc(f.note)}</p>`).join("");
  const body = s.items.length ? `<ol class="brief-list">${s.items.map((i) => line(i, tz)).join("")}</ol>` : usable && s.empty ? `<p class="brief-empty">${esc(s.empty)}</p>` : "";
  return `<section class="brief-sec" id="${s.id}" aria-labelledby="${s.id}-h"><div class="brief-head"><p class="label">${esc(s.label)}</p><h2 id="${s.id}-h">${esc(s.title)}</h2>` +
    `<p class="brief-scope">${esc(s.scope)}</p><p class="brief-conf"><span class="tag conf-${s.confidence.label}">${CONFIDENCE[s.confidence.label]}</span> ${esc(s.confidence.reason)}</p></div>` +
    `<div class="brief-body">${notes}${body}${s.after ? `<p class="brief-after">${esc(s.after)}</p>` : ""}</div></section>`;
}

function sourcesBlock() {
  const row = (s) => {
    const checked = s.status === "checked";
    const date = checked ? dayText(Date.parse(`${s.checked}T00:00:00Z`)) : "";
    return `<li class="brief-source"><div class="brief-source-head"><b>${https(s.url) ? `<a href="${esc(s.url)}" rel="noopener noreferrer">${esc(s.name)}</a>` : esc(s.name)}</b>` +
      `<span class="tag${checked ? " conf-confirmed" : " conf-unverified"}">${checked ? `Terms checked ${esc(date)}` : "Terms unverified"}</span></div>` +
      `<p><span class="brief-key">We keep</span> ${esc(s.stores)}</p><p><span class="brief-key">Terms</span> ${esc(s.note)}` +
      (https(s.terms) ? ` <a href="${esc(s.terms)}" rel="noopener noreferrer">${checked ? "Terms page" : "Page read"}</a>` : "") + `</p></li>`;
  };
  return `<section class="brief-sec" id="sources" aria-labelledby="sources-h"><div class="brief-head"><p class="label">06_SOURCES</p><h2 id="sources-h">Sources</h2>` +
    `<p class="brief-scope">Every source this brief draws on, what the site keeps from it, and whether someone has read its terms.</p></div>` +
    `<div class="brief-body"><ul class="brief-sources">${SOURCE_REGISTER.map(row).join("")}</ul></div></section>`;
}

/** The members' page. tz: the member's saved zone (timezones.js), UTC when none is saved. */
export function renderBrief(brief, { tz = "UTC" } = {}) {
  const zone = isZone(tz) ? tz : "UTC";
  const start = Date.parse(brief.week.start);
  const last = new Date(start + 6 * DAY);
  const first = new Date(start);
  const range = `${first.getUTCDate()}${first.getUTCMonth() === last.getUTCMonth() ? "" : ` ${MONTHS[first.getUTCMonth()]}`}${first.getUTCFullYear() === last.getUTCFullYear() ? "" : ` ${first.getUTCFullYear()}`} to ${dayText(last.getTime())}`;
  const toc = [...brief.sections.map((s) => [s.id, s.title]), ["sources", "Sources"]].map(([id, t]) => `<li><a href="#${id}">${esc(t)}</a></li>`).join("");
  return (
    `<div class="brief brand-constellation"><p class="k">CONSTELLATION_BRIEF</p><h1 id="hero-h">Constellation Brief</h1>` +
    `<p class="brief-week"><b>Week ${brief.week.week}</b><span>${esc(range)}</span><span>${esc(brief.week.id)}</span></p>` +
    `<p class="lead">One brief a week for members, put together from open sources the site already reads. Every line links to where it came from and says when we fetched it.</p>` +
    `<p class="brief-meta">Assembled ${esc(stamp(brief.assembledAt))} · event and launch times in ${esc(zone === "UTC" ? "UTC" : zoneLabel(zone))} · <a href="/app/#calls-h">change your time zone</a></p>` +
    `<nav class="brief-toc" aria-label="In this brief"><ul>${toc}</ul></nav>` +
    brief.sections.map((s) => section(s, zone)).join("") + sourcesBlock() +
    `<div class="brief-rules"><p class="label">HOW_WE_SHARE</p><ul class="ticks"><li>Open sources only. Every line links to where it came from.</li>` +
    `<li>Unclassified only. Nothing export-controlled, nothing operational.</li><li>Confidence is stated: confirmed, likely or unverified.</li>` +
    `<li>No targeting, and no personal data about individuals.</li></ul></div>` +
    `<p class="actions"><a class="btn ghost" href="/app/">Back to your workspace</a></p></div>`
  );
}

/** Every cached feed the brief reads. */
export const BRIEF_FEEDS = Object.freeze(Object.keys(FEEDS));
