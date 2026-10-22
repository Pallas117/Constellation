// Server-side HTML for the live sections, plus the launch calendar (.ics). Everything is escaped;
// the pages stay script-free. Times are always UTC, and every view says how old its data is.
import { feedState, LUMA } from "./feeds.js";
import { argoPrice, FEATURES, priceLabel, TIERS } from "./tiers.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MINUS = "\u2212";
const PRECISE = new Set(["SEC", "MIN", "HR"]);
const L1_KM = 1.5e6; // Sun-Earth L1, about 1.5 million km upstream of Earth
const SCALE_NAMES = { G: "geomagnetic storm", S: "solar radiation storm", R: "radio blackout" };

export const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const dayMon = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

export function whenText(netIso, precision) {
  const d = new Date(netIso);
  if (PRECISE.has(precision)) return `${dayMon(d)}, ${precision === "HR" ? "~" : ""}${hhmm(d)} UTC`;
  if (precision === "DAY") return `${dayMon(d)} (time TBC)`;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} (date TBC)`;
}

export function countdown(netIso, precision, now) {
  const ms = Date.parse(netIso) - now;
  if (!PRECISE.has(precision)) {
    if (precision !== "DAY") return `NET ${MONTHS[new Date(netIso).getUTCMonth()]}`;
    const day = (t) => Math.floor(t / 86_400_000); // calendar days, UTC
    const days = Math.max(0, day(Date.parse(netIso)) - day(now));
    return days === 0 ? "Today" : `In ${days} d`;
  }
  if (ms <= 0) return "Due now";
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d > 0 ? `T${MINUS}${d}\u00a0d ${h}\u00a0h` : `T${MINUS}${h}\u00a0h ${m % 60}\u00a0min`;
}

const signed = (v) => (v > 0 ? `+${v}` : v < 0 ? `${MINUS}${Math.abs(v)}` : "0");
const at = (iso) => (iso ? `${dayMon(new Date(iso))} ${hhmm(new Date(iso))} UTC` : "never");

export function chip({ state, fetchedAt }) {
  if (state === "offline") return '<span class="chip">Offline</span>';
  const t = fetchedAt ? new Date(fetchedAt) : null;
  if (state === "stale") return `<span class="chip stale">Stale · as of ${esc(t ? at(fetchedAt) : "unknown")}</span>`;
  return `<span class="chip live">Live · ${esc(t ? hhmm(t) : "")} UTC</span>`;
}

const head = (label, id, title, status) =>
  `<div class="section-head"><div><p class="label">${esc(label)}</p><h2 id="${esc(id)}">${esc(title)}</h2></div>${chip(status)}</div>`;

const title = (l) => (l.vehicle && l.mission ? `${l.vehicle} · ${l.mission}` : l.name || l.vehicle);
const where = (l) => [l.provider, l.location].filter(Boolean).join(" · ");
const upcoming = (items, now) => (items ?? []).filter((l) => Date.parse(l.windowEnd ?? l.net) >= now - 3_600_000);

function levelClass(n) {
  return n >= 3 ? "lvl-3" : n >= 1 ? "lvl-1" : "";
}

export function weatherSummary(w) {
  const active = ["G", "S", "R"].filter((k) => w?.[k]?.level > 0);
  if (!active.length) return "Quiet: no geomagnetic storm, solar radiation storm or radio blackout in progress.";
  return `In progress: ${active.map((k) => `${k}${w[k].level} ${w[k].text ?? ""} ${SCALE_NAMES[k]}`.replace(/\s+/g, " ")).join(", ")}.`;
}

const scaleText = (w) =>
  ["G", "S", "R"].map((k) => (levelClass(w[k].level) ? `<span class="${levelClass(w[k].level)}">` : "<span>") + `${k}${w[k].level ?? "?"}</span>`).join(" · ");

const NB = "\u00a0"; // keep numbers with their units on one line

function windLine(w) {
  const parts = [];
  if (w.kp) parts.push(`Kp${NB}${w.kp.value.toFixed(1)}`);
  if (w.wind?.speed !== null && w.wind?.speed !== undefined) parts.push(`solar wind ${Math.round(w.wind.speed)}${NB}km/s`);
  if (w.wind?.bz !== null && w.wind?.bz !== undefined) parts.push(`Bz${NB}${signed(w.wind.bz)}${NB}nT`);
  return parts.join(" · ");
}

// Landing page: each door shows its product working instead of describing it. The doors are links,
// so these readouts contain no links; empty string = nothing to show (the door still works).
function readout(label, big, line, s) {
  const asOf = s.state === "stale" ? `<span class="as-of">as of ${esc(at(s.fetchedAt))}</span>` : "";
  return `<span class="door-now"><span class="label">${esc(label)}</span><span class="door-big">${big}</span><span class="door-line">${esc(line)}</span>${asOf}</span>`;
}

export function renderGaussDoor(rec, now = Date.now()) {
  const w = rec?.data;
  return w ? readout("Space weather now", scaleText(w), windLine(w), feedState("weather", rec, now)) : "";
}

export function renderConstellationDoor(rec, now = Date.now()) {
  const next = upcoming(rec?.data, now)[0];
  return next ? readout("Next launch", esc(countdown(next.net, next.precision, now)), title(next), feedState("launches", rec, now)) : "";
}

/** Constellation page: the launch schedule. */
export function renderLaunches(rec, now = Date.now()) {
  const s = feedState("launches", rec, now);
  const items = upcoming(rec?.data, now).slice(0, 10);
  const top = head("01_LAUNCHES", "launches-h", "Upcoming launches, worldwide.", s);
  if (!items.length) return `${top}<p class="muted">Launch data is unavailable right now. It refreshes automatically.</p>`;
  const rows = items
    .map((l) => {
      const tags = [
        l.orbit && l.orbit !== "N/A" ? `<span class="tag">${esc(l.orbit)}</span>` : "",
        l.status ? `<span class="tag${l.status === "Go" ? " go" : l.status === "Hold" ? " hold" : ""}" title="${esc(l.statusName)}">${esc(l.status)}</span>` : "",
      ].join("");
      return (
        `<li class="launch"><div class="when"><b>${esc(countdown(l.net, l.precision, now))}</b><time datetime="${esc(l.net)}">${esc(whenText(l.net, l.precision))}</time></div>` +
        `<div class="what"><b>${esc(title(l))}</b><span>${esc(where(l))}</span></div><div class="tags">${tags}</div></li>`
      );
    })
    .join("");
  return `${top}<ol class="launches">${rows}</ol><p class="src">Source: The Space Devs Launch Library 2 · updated ${esc(at(s.fetchedAt))} · every orbital launch attempt worldwide, times UTC.</p>`;
}

/** Constellation page: events from the Constellation calendar on Luma (titles, times and links only). */
// Built by hand, so every runtime prints the same "Sat 24 Oct 2026" (locale data differs between Node and Workers).
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const eventDay = (iso) => { const d = new Date(iso); return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const eventTime = (iso) => `${new Date(iso).toISOString().slice(11, 16)}${NB}UTC`;
export function renderEvents(rec, now = Date.now()) {
  const list = Array.isArray(rec?.data) ? rec.data.filter((e) => /^https:\/\/luma\.com\//.test(e.url ?? "")) : [];
  const next = list.filter((e) => Date.parse(e.end) > now).slice(0, 6);
  const past = list.filter((e) => Date.parse(e.end) <= now).slice(-3).reverse();
  const item = (e) => `<li class="event"><time datetime="${esc(e.start)}"><b>${esc(eventDay(e.start))}</b><span>${esc(eventTime(e.start))}</span></time>` +
    `<a href="${esc(e.url)}" rel="noopener">${esc(e.title)}</a></li>`;
  return (next.length ? `<ol class="events">${next.map(item).join("")}</ol>`
      : `<p class="muted">No events are scheduled right now. Follow the calendar on Luma to hear about the next one first.</p>`) +
    `<p class="actions"><a class="btn" href="${LUMA.page}" rel="noopener">Follow Constellation on Luma</a></p>` +
    (past.length ? `<h3 class="label events-h">Recently</h3><ol class="events past">${past.map(item).join("")}</ol>` : "") +
    (rec?.fetchedAt ? `<p class="src">Source: the Constellation calendar on Luma · updated ${esc(at(rec.fetchedAt))} · times UTC; venues and local times are on each event page.</p>` : "");
}

/** Constellation page: space weather in detail. */
export function renderWeather(rec, now = Date.now()) {
  const s = feedState("weather", rec, now);
  const w = rec?.data;
  const top = head("02_SPACE_WEATHER", "weather-h", "Space weather now.", s);
  if (!w) return `${top}<p class="muted">Space-weather data is unavailable right now. It refreshes automatically.</p>`;
  const scale = (k, name) =>
    `<article class="tile"><h3 class="label">${esc(name)}</h3><p class="${`big ${levelClass(w[k].level)}`.trim()}">${k}${w[k].level ?? "?"}</p><p class="m">${esc(w[k].text ?? "unknown")}</p></article>`;
  const kp = w.kp
    ? `<article class="tile"><h3 class="label">Planetary Kp index</h3><p class="big">${esc(w.kp.value.toFixed(1))}</p><p class="m">3-hour interval from ${esc(hhmm(new Date(w.kp.at)))} UTC. Kp 5 or more is a geomagnetic storm.</p></article>`
    : "";
  const speed = w.wind?.speed;
  const travel = speed > 0 ? ` · at this speed it reaches Earth in about ${Math.round(L1_KM / speed / 60)} min` : "";
  const wind = w.wind
    ? `<article class="tile"><h3 class="label">Solar wind at L1</h3><p class="big">${speed !== null ? `${esc(Math.round(speed))} km/s` : "n/a"}</p>` +
      `<p class="m">${w.wind.bz !== null ? `Bz ${esc(signed(w.wind.bz))} nT` : ""}${w.wind.bt !== null ? `, Bt ${esc(w.wind.bt)} nT` : ""}${esc(travel)}</p></article>`
    : "";
  return (
    `${top}<p class="lead">${esc(weatherSummary(w))}</p><div class="scales">${scale("G", "Geomagnetic storms")}${scale("S", "Solar radiation storms")}${scale("R", "Radio blackouts")}</div>` +
    `<div class="tiles">${kp}${wind}</div>` +
    `<p class="src">Source: NOAA Space Weather Prediction Center · scales as of ${esc(at(w.at))} · updated ${esc(at(s.fetchedAt))} · G, S and R are NOAA's storm scales, from 0 (none) to 5 (extreme).</p>`
  );
}

// ---- Calendar feed (RFC 5545) ----
const icsEsc = (v) => String(v ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
const icsUid = (v) => String(v ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 64) || "event";
const icsTime = (iso) => iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsDate = (iso) => iso.slice(0, 10).replace(/-/g, "");
function fold(line) {
  // Lines longer than 75 octets are folded with CRLF + space (RFC 5545 3.1).
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = "";
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > (out.length ? 74 : 75)) {
      out.push(cur);
      cur = ch;
    } else cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}

/** One calendar event (group calls, the planner's picked time). Calendar apps show it in local time. */
export function renderEventIcs({ uid, start, minutes, summary, description = "", url = "" }, now = Date.now()) {
  const s0 = new Date(start);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lightbound//Constellation calls//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT", `UID:${icsUid(uid)}@lightbound.uk`, `DTSTAMP:${icsTime(new Date(now).toISOString())}`,
    `DTSTART:${icsTime(s0.toISOString())}`, `DTEND:${icsTime(new Date(s0.getTime() + minutes * 60_000).toISOString())}`,
    `SUMMARY:${icsEsc(summary)}`, ...(description ? [`DESCRIPTION:${icsEsc(description)}`] : []), ...(url ? [`URL:${url}`] : []),
    "END:VEVENT", "END:VCALENDAR"];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

export function renderIcs(rec, now = Date.now()) {
  const stamp = icsTime(new Date(rec?.fetchedAt ? Date.parse(rec.fetchedAt) : now).toISOString());
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lightbound//Constellation launches//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "X-WR-CALNAME:Constellation · upcoming launches", "X-PUBLISHED-TTL:PT1H", "REFRESH-INTERVAL;VALUE=DURATION:PT1H"];
  for (const l of upcoming(rec?.data, now)) {
    if (!PRECISE.has(l.precision) && l.precision !== "DAY") continue; // no date yet: nothing to put in a calendar
    const timed = PRECISE.has(l.precision);
    const start = new Date(l.net);
    const end = timed ? new Date(Math.max(Date.parse(l.windowEnd ?? l.net), start.getTime() + 30 * 60_000)) : null;
    lines.push("BEGIN:VEVENT", `UID:${icsUid(l.id)}@lightbound.uk`, `DTSTAMP:${stamp}`,
      timed ? `DTSTART:${icsTime(start.toISOString())}` : `DTSTART;VALUE=DATE:${icsDate(l.net)}`,
      timed ? `DTEND:${icsTime(end.toISOString())}` : `DTEND;VALUE=DATE:${icsDate(new Date(start.getTime() + 86_400_000).toISOString())}`,
      `SUMMARY:${icsEsc(title(l))}`, `LOCATION:${icsEsc(l.location)}`,
      `DESCRIPTION:${icsEsc(`${l.provider}\nStatus: ${l.statusName || l.status}\nTime precision: ${l.precision}\nSource: The Space Devs Launch Library 2 via lightbound.uk/constellation`)}`,
      "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

// ---- Gauss plans (from tiers.js, priced from the sales plan) ----
// Support Constellation: a Stripe Payment Link (SUPPORT_URL in wrangler.jsonc vars; not a secret). The block
// stays hidden until a well-formed link is set. Contributions go to Lightbound Limited: not a charity donation.
const SUPPORT = /^https:\/\/(buy|donate)\.stripe\.com\/[A-Za-z0-9_-]{6,}$/;
export const supportLink = (url) => (SUPPORT.test(url ?? "") ? url : "");
export function renderSupport(url) {
  const href = supportLink(url);
  return href
    ? `<div class="support"><p class="label">SUPPORT</p><h3>Help keep it free.</h3><p>Constellation is free and non-commercial. If you'd like to help keep it running, chip in whatever you like. ` +
      `It's optional and changes nothing about membership.</p><p class="actions"><a class="btn ghost" href="${esc(href)}" rel="noopener">Support Constellation</a></p></div>`
    : "";
}

// Gauss Argo's calls to action follow ARGO_SALES: the list while it's off, a sign-in to start once it's open.
export function renderArgoActions(mode) {
  if (mode === "open") return `<a class="btn" href="/app/?argo=start">Start for ${esc(argoPrice)}</a> <a class="btn ghost" href="#how">How it works</a>`;
  return `<a class="btn" href="/argo/apply/">Request early access</a> ` + (mode === "invite" ? `<a class="btn ghost" href="/app/">Invited? Sign in to start</a>` : `<a class="btn ghost" href="#how">How it works</a>`);
}
export function renderArgoPlan(mode) {
  return `<p class="lead">${mode === "off" ? "Planned: " : ""}<strong>${esc(argoPrice)}</strong> per person, month to month: cancel any time, and a full refund if you're not satisfied (<a href="/terms/#cancel">terms</a>). For an operations team, <a href="mailto:jzwnathan@lightbound.uk?subject=Assured%20Connectivity%20pilot">ask about an Assured Connectivity pilot</a>: it adds guards that shed optional load when a Mac runs short of power, memory or disk, and team status in the Gauss console.</p>` +
    `<p class="actions">${mode === "open" ? `<a class="btn" href="/app/?argo=start">Start for ${esc(argoPrice)}</a>` : `<a class="btn" href="/argo/apply/">Request early access</a>`}</p>`;
}

// Gauss for Education: three plans; the buttons follow EDU_SALES, and the staff price is TBC until EDU_STAFF_PRICE is set.
export function renderEduActions(mode) {
  return mode === "open"
    ? `<a class="btn" href="/app/?edu=start">Start with your university email</a> <a class="btn ghost" href="/education/apply/">Department licence</a>`
    : `<a class="btn" href="/education/apply/">Register interest</a> <a class="btn ghost" href="#plans">See the plans</a>`;
}
export function renderEduPlans(mode, staffLabel) {
  const open = mode === "open";
  const plan = (stage, name, price, what, cta, now = false) =>
    `<li class="plan${now ? " now" : ""}"><span class="label">${esc(stage)}</span><h3>${esc(name)}</h3><p class="price">${esc(price)}</p><p>${esc(what)}</p><p class="actions">${cta}</p></li>`;
  const start = (label, ghost = true) => (open ? `<a class="btn${ghost ? " ghost" : ""}" href="/app/?edu=start">${esc(label)}</a>` : `<span class="btn ghost" aria-disabled="true">Opening soon</span>`);
  return `<ol class="plans three">` +
    plan("Students", "Student", "Free", "With your university email, for a year at a time. Renew with the same check.", start("Start free", false), true) +
    plan("Staff and research", "Staff and research", staffLabel, "Month to month: cancel any time, and a full refund if you're not satisfied. For lecturers, teaching assistants and research groups.", staffLabel === "Price TBC" ? `<span class="btn ghost" aria-disabled="true">Price TBC</span>` : start("Start")) +
    plan("Departments", "Department licence", "Quoted per year", "Every course in a department. Paid by invoice, 30 days to pay.", `<a class="btn ghost" href="/education/apply/">Ask for a quote</a>`) +
    `</ol><p class="note">For teaching and non-commercial research. Gauss is advisory: it shows evidence and never commands a spacecraft. Already signed up? <a href="/app/">Sign in</a>.</p>`;
}

export function renderPlans() {
  const cards = TIERS.map((t) => {
    const first = t.id === "pilot";
    const cta = first ? "Start with a pilot" : t.billing === "invoice" ? `Scope ${t.name.toLowerCase()}` : `Apply for ${t.name}`;
    return `<li class="plan${first ? " now" : ""}"><span class="label">${esc(t.stage)}</span><h3>${esc(t.name)}</h3>` +
      `<p class="price">${esc(priceLabel(t))}</p><p>${esc(t.outcome)}</p>` +
      `<ul class="ticks">${t.features.map((id) => `<li>${esc(FEATURES[id])}</li>`).join("")}</ul><p class="m">${esc(t.entry)}</p>` +
      `<p class="actions"><a class="btn${first ? "" : " ghost"}" href="/gauss/apply/?plan=${esc(t.id)}">${esc(cta)}</a></p></li>`;
  }).join("");
  return `<ol class="plans">${cards}</ol>` +
    `<p class="note">Your price is a fixed quote inside the range, agreed from your scope before you pay. Project work is billed by milestone. ` +
    `Every plan is advisory: Gauss shows evidence and never commands a spacecraft. Already a customer? <a href="/app/">Sign in</a>.</p>` +
    `<p class="note"><strong>Later, a strategic option:</strong> Federated Bridge Node, a hosted-payload or in-orbit demonstration, considered only after the stages before it. Future work, not on sale.</p>`;
}
