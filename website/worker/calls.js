// Constellation group calls: an admin schedules a call; members book a seat; everyone sees the time in
// their own zone; the call link is shown only to people who booked. Free, members only.
//   call:<id>              { id, title, start (ISO UTC), minutes, capacity, link, notes }
//   rsvp:<callId>:<email>  one key per booking (separate keys, so two bookings never overwrite each other)
//   calls:index            upcoming calls with their bookings, so a member's page costs one read, not 1 + N lists
//                          (Workers Free allows 1,000 lists a day). Every write patches it; it is rebuilt from the keys
//                          above at most every 10 minutes, so a lost patch heals itself. The keys stay the source of truth.
// KV is eventually consistent: at a busy moment a call can go one or two over capacity. Fine at this size.
import { esc } from "./render.js";
import { DEFAULT_ZONES, formatIn, zoneLabel, ZONES } from "./timezones.js";

const newId = () => `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
const DAY = 86_400;

export async function saveCall(env, call) {
  const c = { ...call, id: call.id ?? newId() };
  const end = Math.floor(Date.parse(c.start) / 1000) + c.minutes * 60;
  await env.DATA.put(`call:${c.id}`, JSON.stringify(c), { expiration: end + 30 * DAY, metadata: { title: c.title.slice(0, 80), start: c.start } });
  await patchIndex(env, (calls) => [...calls.filter((x) => x.id !== c.id), { ...c, rsvps: calls.find((x) => x.id === c.id)?.rsvps ?? [] }]);
  return c;
}

export async function getCall(env, id) {
  return /^[a-z0-9-]{3,40}$/.test(id ?? "") ? env.DATA.get(`call:${id}`, { type: "json" }) : null;
}

async function keys(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.DATA.list({ prefix, cursor });
    out.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

const INDEX = "calls:index";
const INDEX_MAX_AGE = 10 * 60_000;
const upcoming = (calls, now) => calls.filter((c) => Date.parse(c.start) > now - 3_600_000).sort((a, b) => (a.start < b.start ? -1 : 1));

/** Every upcoming call and its bookings, read from the keys themselves (the expensive way). */
async function fromKeys(env, now) {
  const calls = upcoming((await keys(env, "call:")).map((k) => ({ id: k.name.slice(5), ...k.metadata })), now);
  return (await Promise.all(calls.map(async (c) => {
    const call = await getCall(env, c.id);
    return call && { ...call, rsvps: (await keys(env, `rsvp:${c.id}:`)).map((k) => k.name.split(":").slice(2).join(":")) };
  }))).filter(Boolean);
}

/** Upcoming calls (started less than an hour ago or later), soonest first, with their bookings. */
export async function listCalls(env, now = Date.now()) {
  const index = await env.DATA.get(INDEX, { type: "json" });
  if (index && now - index.builtAt < INDEX_MAX_AGE) return upcoming(index.calls, now);
  const calls = await fromKeys(env, now);
  await env.DATA.put(INDEX, JSON.stringify({ builtAt: now, calls }));
  return calls;
}

/** Apply a change to the cached index, if there is one (otherwise the next read builds it). */
async function patchIndex(env, change) {
  const index = await env.DATA.get(INDEX, { type: "json" });
  if (index) await env.DATA.put(INDEX, JSON.stringify({ ...index, calls: change(index.calls) }));
}

export async function deleteCall(env, id) {
  await Promise.all([(await keys(env, `rsvp:${id}:`)).map((k) => env.DATA.delete(k.name)), env.DATA.delete(`call:${id}`)].flat());
  await patchIndex(env, (calls) => calls.filter((c) => c.id !== id));
}

const withBooking = (id, email, want) => (calls) =>
  calls.map((c) => (c.id !== id ? c : { ...c, rsvps: want ? [...new Set([...c.rsvps, email])] : c.rsvps.filter((e) => e !== email) }));

/** Book or cancel a seat. Returns "booked", "cancelled", "full" or "gone". */
export async function rsvp(env, id, email, want, now = Date.now()) {
  const call = await getCall(env, id);
  if (!call || Date.parse(call.start) < now - 3_600_000) return "gone";
  const key = `rsvp:${id}:${email}`;
  if (!want) {
    await env.DATA.delete(key);
    await patchIndex(env, withBooking(id, email, false));
    return "cancelled";
  }
  if (await env.DATA.get(key)) return "booked";
  if ((await keys(env, `rsvp:${id}:`)).length >= call.capacity) return "full";
  const end = Math.floor(Date.parse(call.start) / 1000) + call.minutes * 60;
  await env.DATA.put(key, "1", { expiration: end + 30 * DAY });
  await patchIndex(env, withBooking(id, email, true));
  return "booked";
}

// ---- Rendering ----
const zoneSelect = (cur, name = "tz", label = "Your time zone") =>
  `<select name="${name}" aria-label="${esc(label)}">${ZONES.map(([z, l]) => `<option value="${esc(z)}"${z === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const postForm = (action, fields, label, cls = "btn") =>
  `<form method="post" action="${action}" class="inline">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}<button class="${cls}">${esc(label)}</button></form>`;

/** The member's view: upcoming calls in their zone, book/cancel, link once booked, calendar file. */
export function renderCalls({ calls, email, tz, notice = "" }) {
  const note = { booked: "You're booked. The call link is below.", cancelled: "Booking cancelled.", full: "Sorry, that call is full.", gone: "That call has finished or was removed." }[notice];
  const items = calls.map((c) => {
    const t = Date.parse(c.start);
    const mine = c.rsvps.includes(email);
    const left = Math.max(0, c.capacity - c.rsvps.length);
    const zs = [tz, ...DEFAULT_ZONES.filter((z) => z !== tz)].slice(0, 6);
    const planner = `/constellation/time/?${new URLSearchParams([["date", new Date(t).toISOString().slice(0, 10)], ...zs.map((z) => ["z", z]), ["at", String(new Date(t).getUTCHours())]])}#slot`;
    return `<li class="call"><div class="call-when"><b>${esc(formatIn(t, tz))}</b><span>${esc(zoneLabel(tz))} · ${esc(formatIn(t, "UTC"))} UTC · ${c.minutes} min</span></div>` +
      `<div class="call-what"><h3>${esc(c.title)}</h3>${c.notes ? `<p class="m">${esc(c.notes)}</p>` : ""}` +
      (mine && c.link ? `<p class="m">Join: <a href="${esc(c.link)}" rel="noopener noreferrer">${esc(c.link)}</a></p>` : "") + `</div>` +
      `<div class="call-act"><span class="tag${mine ? " go" : ""}">${mine ? "Booked" : `${left} of ${c.capacity} seats left`}</span>` +
      (mine ? postForm("/app/calls/rsvp", { id: c.id, want: "no" }, "Cancel", "btn ghost") : left > 0 ? postForm("/app/calls/rsvp", { id: c.id, want: "yes" }, "Book a seat") : "") +
      `<a class="btn ghost" href="/app/calls/${esc(c.id)}.ics">Add to calendar</a> <a href="${esc(planner)}">Other time zones</a></div></li>`;
  }).join("");
  return `<section class="calls" aria-labelledby="calls-h"><div class="section-head"><div><p class="label">GROUP_CALLS</p><h2 id="calls-h">Constellation group calls</h2></div>` +
    `<form method="post" action="/app/prefs" class="inline">${zoneSelect(tz)} <button class="btn ghost">Show my time</button></form></div>` +
    (note ? `<p class="banner" role="status">${esc(note)}</p>` : "") +
    (items ? `<ol class="call-list">${items}</ol>` : `<p class="muted">No calls scheduled yet. New calls appear here.</p>`) +
    `<p class="note">Free for members. Times show in your zone; calendar files show in each person's own zone.</p></section>`;
}

// Announcements are drafts the admin sends: an email to all members (Bcc) or a message for the members'
// WhatsApp group. Nothing is sent from here and no messaging service or token is involved.
export function announcement(call, origin) {
  const t = Date.parse(call.start);
  const planner = `${origin}/constellation/time/?${new URLSearchParams([["date", call.start.slice(0, 10)], ...DEFAULT_ZONES.map((z) => ["z", z]), ["at", String(new Date(t).getUTCHours())]])}#slot`;
  return `Constellation group call: ${call.title}\n${formatIn(t, "UTC")} UTC, ${call.minutes} min\nIn your time zone: ${planner}\nBook a seat (members): ${origin}/app/`;
}
const MAILTO_MAX = 1800; // longer mailto links are cut off by some mail apps
function announceLinks(call, members, origin) {
  const text = announcement(call, origin);
  const subject = `Constellation call: ${call.title}`;
  const bcc = members.map(encodeURIComponent).join(",");
  const tail = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  const withBcc = `mailto:?bcc=${bcc}&${tail}`;
  const mail = members.length && withBcc.length <= MAILTO_MAX ? withBcc : `mailto:?${tail}`;
  return `<p class="m announce">Announce: <a href="${esc(mail)}">Draft an email to ${members.length} member${members.length === 1 ? "" : "s"}</a>` +
    `${mail === withBcc || !members.length ? "" : " (add the addresses yourself: too many for one link)"} · ` +
    `<a href="${esc(`https://wa.me/?text=${encodeURIComponent(text)}`)}" rel="noopener noreferrer">Draft a WhatsApp message</a> (you choose the group and press send)</p>`;
}

/** The admin's view: schedule a call; list calls with bookings and announcement drafts. */
export function renderCallsAdmin(calls, members = [], origin = "https://lightbound.uk") {
  const rows = calls.map((c) => `<li class="app-card"><div class="app-head"><span class="label">${esc(formatIn(Date.parse(c.start), "UTC"))} UTC · ${c.minutes} min</span><span>${c.rsvps.length} of ${c.capacity} booked</span></div>` +
    `<h3>${esc(c.title)}</h3>${c.rsvps.length ? `<p class="m">${c.rsvps.map(esc).join(", ")}</p>` : ""}${announceLinks(c, members, origin)}` +
    postForm("/app/admin/calls", { action: "delete", id: c.id }, "Remove call", "btn ghost") + `</li>`).join("");
  return `<h2>Group calls (${calls.length})</h2>` +
    `<form method="post" action="/app/admin/calls" class="form call-form"><input type="hidden" name="action" value="create">` +
    `<div class="field"><label for="c-title">Title</label><input id="c-title" name="title" required maxlength="80" placeholder="Monthly members' call"></div>` +
    `<div class="inline"><label class="sr" for="c-start">Start (local)</label><input id="c-start" type="datetime-local" name="start" required> ${zoneSelect("Europe/London", "zone", "Start time zone")} ` +
    `<select name="minutes" aria-label="Length">${[30, 45, 60, 90].map((m) => `<option value="${m}"${m === 60 ? " selected" : ""}>${m} min</option>`).join("")}</select> ` +
    `<label class="money"><span>Seats</span><input name="capacity" type="number" min="2" max="200" value="20" aria-label="Seats"></label></div>` +
    `<div class="field"><label for="c-link">Call link (shown only to members who book)</label><input id="c-link" name="link" type="url" maxlength="300" placeholder="https://meet.example.com/..."></div>` +
    `<div class="field"><label for="c-notes">Notes (optional)</label><input id="c-notes" name="notes" maxlength="500"></div>` +
    `<p class="actions"><button class="btn">Schedule call</button></p></form>` +
    (rows ? `<ul class="apps">${rows}</ul>` : `<p class="muted">No calls scheduled.</p>`);
}
