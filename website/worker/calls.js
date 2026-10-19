// Constellation group calls: an admin schedules a call; members book a seat; everyone sees the time in
// their own zone; the call link is shown only to people who booked. Free, members only.
//   call:<id>              { id, title, start (ISO UTC), minutes, capacity, link, notes }
//   rsvp:<callId>:<email>  one key per booking (separate keys, so two bookings never overwrite each other)
// KV is eventually consistent: at a busy moment a call can go one or two over capacity. Fine at this size.
import { esc } from "./render.js";
import { DEFAULT_ZONES, formatIn, zoneLabel, ZONES } from "./timezones.js";

const newId = () => `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
const DAY = 86_400;

export async function saveCall(env, call) {
  const c = { ...call, id: call.id ?? newId() };
  const end = Math.floor(Date.parse(c.start) / 1000) + c.minutes * 60;
  await env.DATA.put(`call:${c.id}`, JSON.stringify(c), { expiration: end + 30 * DAY, metadata: { title: c.title.slice(0, 80), start: c.start } });
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

/** Upcoming calls (started less than an hour ago or later), soonest first, with their bookings. */
export async function listCalls(env, now = Date.now()) {
  const calls = (await keys(env, "call:")).map((k) => ({ id: k.name.slice(5), ...k.metadata }))
    .filter((c) => Date.parse(c.start) > now - 3_600_000).sort((a, b) => (a.start < b.start ? -1 : 1));
  return Promise.all(calls.map(async (c) => ({ ...(await getCall(env, c.id)), rsvps: (await keys(env, `rsvp:${c.id}:`)).map((k) => k.name.split(":").slice(2).join(":")) })));
}

export async function deleteCall(env, id) {
  await Promise.all([(await keys(env, `rsvp:${id}:`)).map((k) => env.DATA.delete(k.name)), env.DATA.delete(`call:${id}`)].flat());
}

/** Book or cancel a seat. Returns "booked", "cancelled", "full" or "gone". */
export async function rsvp(env, id, email, want, now = Date.now()) {
  const call = await getCall(env, id);
  if (!call || Date.parse(call.start) < now - 3_600_000) return "gone";
  const key = `rsvp:${id}:${email}`;
  if (!want) {
    await env.DATA.delete(key);
    return "cancelled";
  }
  if (await env.DATA.get(key)) return "booked";
  if ((await keys(env, `rsvp:${id}:`)).length >= call.capacity) return "full";
  const end = Math.floor(Date.parse(call.start) / 1000) + call.minutes * 60;
  await env.DATA.put(key, "1", { expiration: end + 30 * DAY });
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
    (items ? `<ol class="call-list">${items}</ol>` : `<p class="muted">No calls scheduled yet. Members hear about new ones by email.</p>`) +
    `<p class="note">Free for members. Times show in your zone; calendar files show in each person's own zone.</p></section>`;
}

/** The admin's view: schedule a call; list calls with bookings. */
export function renderCallsAdmin(calls) {
  const rows = calls.map((c) => `<li class="app-card"><div class="app-head"><span class="label">${esc(formatIn(Date.parse(c.start), "UTC"))} UTC · ${c.minutes} min</span><span>${c.rsvps.length} of ${c.capacity} booked</span></div>` +
    `<h3>${esc(c.title)}</h3>${c.rsvps.length ? `<p class="m">${c.rsvps.map(esc).join(", ")}</p>` : ""}` +
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
