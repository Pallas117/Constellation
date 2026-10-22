// Time zones for Constellation group calls. Constellation spans many regions, so every time is shown
// in each person's own zone, computed on the server with the runtime's IANA database (Intl), so
// daylight-saving changes are handled and no script runs in the browser.
import { esc } from "./render.js";

export const ZONES = Object.freeze([
  ["UTC", "UTC"],
  ["Europe/London", "London"],
  ["Europe/Paris", "Paris, Berlin"],
  ["Europe/Istanbul", "Istanbul"],
  ["Africa/Lagos", "Lagos"],
  ["Africa/Nairobi", "Nairobi"],
  ["Asia/Riyadh", "Riyadh"],
  ["Asia/Dubai", "Dubai"],
  ["Asia/Karachi", "Karachi"],
  ["Asia/Kolkata", "India"],
  ["Asia/Dhaka", "Dhaka"],
  ["Asia/Jakarta", "Jakarta"],
  ["Asia/Kuala_Lumpur", "Kuala Lumpur"],
  ["Asia/Singapore", "Singapore"],
  ["Asia/Shanghai", "Beijing, Shanghai"],
  ["Asia/Tokyo", "Tokyo"],
  ["Australia/Sydney", "Sydney"],
  ["Pacific/Auckland", "Auckland"],
  ["America/Sao_Paulo", "São Paulo"],
  ["America/New_York", "New York"],
  ["America/Chicago", "Chicago"],
  ["America/Denver", "Denver"],
  ["America/Los_Angeles", "Los Angeles"],
]);
export const DEFAULT_ZONES = Object.freeze(["Europe/London", "Asia/Dubai", "Asia/Kolkata", "Asia/Kuala_Lumpur", "America/New_York"]);
const LABEL = Object.fromEntries(ZONES);
export const isZone = (z) => Object.hasOwn(LABEL, z);
export const zoneLabel = (z) => LABEL[z] ?? z;

const partsCache = new Map();
function parts(date, tz) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
    partsCache.set(tz, f);
  }
  return Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
}

/** Milliseconds the zone is ahead of UTC at that instant. */
export function tzOffset(ms, tz) {
  const p = parts(new Date(ms), tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

/** "2026-10-23T13:00" read as wall-clock time in `tz` -> UTC milliseconds (null if invalid). */
export function zonedToUtc(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local ?? "");
  if (!m || !isZone(tz)) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let utc = guess - tzOffset(guess, tz);
  utc = guess - tzOffset(utc, tz); // second pass settles daylight-saving edges
  return Number.isFinite(utc) ? utc : null;
}

/** "Thu 23 Oct, 13:00" in the zone. */
export function formatIn(ms, tz) {
  const p = parts(new Date(ms), tz);
  const month = new Intl.DateTimeFormat("en-GB", { timeZone: tz, month: "short" }).format(new Date(ms));
  return `${p.weekday} ${+p.day} ${month}, ${p.hour}:${p.minute}`;
}
export const localHour = (ms, tz) => +parts(new Date(ms), tz).hour;

// ---- The public planner (/constellation/time/) ----
const WORK = (h) => h >= 8 && h < 20;
const QUIET = (h) => h >= 22 || h < 7;

export function plannerParams(url, now = Date.now()) {
  const zones = [...new Set(url.searchParams.getAll("z").filter(isZone))].slice(0, 8);
  const d = url.searchParams.get("date");
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d ?? "") && Number.isFinite(Date.parse(`${d}T00:00:00Z`)) ? d : new Date(now).toISOString().slice(0, 10);
  const at = Number.parseInt(url.searchParams.get("at") ?? "", 10);
  return { zones: zones.length ? zones : [...DEFAULT_ZONES], date, at: at >= 0 && at <= 23 ? at : null };
}

export function renderPlanner({ zones, date, at }) {
  const day0 = Date.parse(`${date}T00:00:00Z`);
  const hours = Array.from({ length: 24 }, (_, h) => day0 + h * 3_600_000);
  const working = hours.map((t) => zones.filter((z) => WORK(localHour(t, z))).length);
  const best = Math.max(...working);
  const bestHours = hours.map((t, h) => (working[h] === best && best > 0 ? h : -1)).filter((h) => h >= 0);
  const qs = (extra) => {
    const u = new URLSearchParams([["date", date], ...zones.map((z) => ["z", z]), ...Object.entries(extra)]);
    return `/constellation/time/?${esc(u.toString())}`;
  };
  const checkboxes = ZONES.map(([z, l]) => `<label class="zone"><input type="checkbox" name="z" value="${esc(z)}"${zones.includes(z) ? " checked" : ""}> ${esc(l)}</label>`).join("");
  const head = hours.map((t, h) => `<th scope="col" class="${bestHours.includes(h) ? "best" : ""}${at === h ? " picked" : ""}"><a href="${qs({ at: h })}#slot">${String(h).padStart(2, "0")}</a></th>`).join("");
  const rows = zones.map((z) =>
    `<tr><th scope="row">${esc(zoneLabel(z))}</th>${hours.map((t, h) => {
      const lh = localHour(t, z);
      const cls = [WORK(lh) ? "work" : QUIET(lh) ? "quiet" : "edge", bestHours.includes(h) ? "best" : "", at === h ? "picked" : ""].filter(Boolean).join(" ");
      return `<td class="${cls}">${String(lh).padStart(2, "0")}</td>`;
    }).join("")}</tr>`).join("");
  const summary = best === zones.length
    ? `Everyone is within 08:00–20:00 local time at ${bestHours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")} UTC.`
    : best > 0
      ? `No hour suits everyone. Best: ${best} of ${zones.length} zones in working hours at ${bestHours.map((h) => `${String(h).padStart(2, "0")}:00`).join(", ")} UTC.`
      : "No hour falls in working hours for these zones.";
  const slot = at === null ? "" : (() => {
    const t = day0 + at * 3_600_000;
    const list = zones.map((z) => `<li><b>${esc(zoneLabel(z))}</b> ${esc(formatIn(t, z))}</li>`).join("");
    const ics = `/api/call.ics?start=${encodeURIComponent(new Date(t).toISOString())}`;
    return `<div class="slot" id="slot"><p class="label">PICKED_TIME</p><h2>${esc(formatIn(t, "UTC"))} UTC</h2><ul class="slot-list">${list}</ul>` +
      `<p class="actions"><a class="btn" href="${esc(ics)}">Add to calendar (.ics)</a></p><p class="m">Calendar apps show it in each person's own time zone. Copy this page's address to share the time.</p></div>`;
  })();
  return (
    `<form class="planner-form" method="get" action="/constellation/time/"><div class="field"><label for="p-date">Date</label><input id="p-date" type="date" name="date" value="${esc(date)}"></div>` +
    `<fieldset class="zones"><legend>Time zones (up to 8)</legend>${checkboxes}</fieldset><p class="actions"><button class="btn" type="submit">Show</button></p></form>` +
    `<p class="lead planner-summary">${esc(summary)}</p>` +
    `<div class="tw"><table class="planner"><caption class="sr">Local hour in each zone for each UTC hour on ${esc(date)}</caption><thead><tr><th scope="col">UTC</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>` +
    `<p class="src">Shaded: 08:00–20:00 local. Dim: 22:00–07:00. Outlined: the best hours. Pick a UTC hour to see it everywhere and add it to a calendar.</p>${slot}`
  );
}
