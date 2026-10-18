// Applications: "Apply to join" for Constellation and "Apply for a plan" for Gauss. Plain HTML forms
// that post to /api/apply, so they work without JavaScript. The server validates everything,
// drops bots (a hidden honeypot field plus a per-IP hourly limit) and uses post/redirect/get, so
// a refresh never resubmits. No personal data ever goes into a URL.
import { esc } from "./render.js";
import { TIERS } from "./tiers.js";
import { rateLimited, saveApplication, APPLICATION_DAYS } from "./data.js";

const PLANS = [["pilot", "30-day replay pilot"], ...TIERS.map((t) => [t.id, `${t.name} (${t.stageName})`])];

const FIELD = {
  name: { label: "Name", type: "text", max: 100, auto: "name", required: true },
  email: { label: "Email", type: "email", max: 254, auto: "email", required: true },
  org: { label: "Organisation", type: "text", max: 120, auto: "organization", required: true },
  role: { label: "Role", type: "text", max: 120, auto: "organization-title", required: true },
  link: { label: "A link about your work (optional)", type: "url", max: 300, auto: "url", required: false },
  plan: { label: "Plan", type: "select", required: true },
  message: { label: "Message", type: "textarea", min: 20, max: 2000, required: true },
};

export const KINDS = Object.freeze({
  constellation: {
    fields: ["name", "email", "role", "link", "message"],
    labels: { role: "What you work on", message: "Why do you want to join?" },
    button: "Send application",
  },
  gauss: {
    fields: ["name", "email", "org", "role", "plan", "message"],
    labels: { message: "Your mission, and the logs or data you have" },
    button: "Apply",
  },
});

const label = (kind, f) => KINDS[kind].labels[f] ?? FIELD[f].label;
const SHORT = { name: "name", email: "email", org: "organisation", role: "role", link: "link", plan: "plan", message: "message", consent: "privacy agreement" };

function control(kind, f, value, error) {
  const d = FIELD[f];
  const id = `f-${f}`;
  const common = `id="${id}" name="${f}"${d.required ? " required" : ""}${error ? ` aria-invalid="true" aria-describedby="${id}-err"` : ""}`;
  let input;
  if (d.type === "textarea") input = `<textarea ${common} rows="6" minlength="${d.min}" maxlength="${d.max}">${esc(value)}</textarea>`;
  else if (d.type === "select") {
    const cur = PLANS.some(([v]) => v === value) ? value : "pilot"; // unknown plan in the link: default to the pilot
    input = `<select ${common}>${PLANS.map(([v, l]) => `<option value="${v}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  }
  else input = `<input ${common} type="${d.type}" maxlength="${d.max}" autocomplete="${d.auto}" value="${esc(value)}">`;
  const err = error ? `<p class="err" id="${id}-err">${esc(error)}</p>` : "";
  return `<div class="field"><label for="${id}">${esc(label(kind, f))}</label>${input}${err}</div>`;
}

/** The form. With no values or errors it is identical to the static fallback in the page (tested). */
export function renderApplyForm(kind, values = {}, errors = {}) {
  const k = KINDS[kind];
  const summary = Object.keys(errors).length
    ? `<div class="form-errors" role="alert"><p>Please check: ${Object.keys(errors).map((f) => esc(SHORT[f])).join(", ")}.</p></div>`
    : "";
  return (
    `<form class="form" method="post" action="/api/apply">${summary}` +
    `<input type="hidden" name="kind" value="${kind}">` +
    k.fields.map((f) => control(kind, f, values[f] ?? "", errors[f])).join("") +
    `<div class="hp" aria-hidden="true"><label for="f-website">Leave this empty</label><input id="f-website" name="website" tabindex="-1" autocomplete="off"></div>` +
    `<label class="check"><input type="checkbox" name="consent" value="yes" required${values.consent ? " checked" : ""}> <span>Lightbound may keep this application for up to ${APPLICATION_DAYS} days to review it. <a href="/privacy/">Privacy</a></span></label>` +
    (errors.consent ? `<p class="err">${esc(errors.consent)}</p>` : "") +
    `<p class="actions"><button class="btn" type="submit">${esc(k.button)}</button></p></form>`
  );
}

export function renderSent(kind) {
  const next = kind === "gauss"
    ? `<p class="actions"><a class="btn ghost" href="/gauss/">Back to Gauss</a></p>`
    : `<p class="actions"><a class="btn ghost" href="/constellation/">Back to Constellation</a></p>`;
  return `<div class="sent" role="status"><p class="k">RECEIVED</p><h2>Thank you. Your application is with the Lightbound team.</h2>` +
    `<p class="lead">If it's a fit, we'll write to the email you gave. Nothing else happens with it.</p>${next}</div>`;
}

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function validate(kind, form) {
  const values = {};
  const errors = {};
  for (const f of KINDS[kind].fields) {
    const d = FIELD[f];
    const raw = f === "message" ? String(form.get(f) ?? "").replace(/\r\n/g, "\n").trim() : clean(form.get(f), (d.max ?? 40) + 1);
    values[f] = raw.slice(0, d.max ?? 40);
    if (d.required && !raw) errors[f] = "Required.";
    else if (d.max && raw.length > d.max) errors[f] = `At most ${d.max} characters.`;
    else if (f === "name" && raw.length < 2) errors[f] = "At least 2 characters.";
    else if (f === "email" && !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]{2,}$/.test(raw)) errors[f] = "Please enter a valid email address.";
    else if (f === "link" && raw && !/^https?:\/\/[^\s<>"]+\.[^\s<>"]+$/i.test(raw)) errors[f] = "Please enter a full link starting with https://";
    else if (f === "plan" && !PLANS.some(([v]) => v === raw)) errors[f] = "Please choose a plan.";
    else if (f === "message" && raw.length < d.min) errors[f] = `Please write at least ${d.min} characters.`;
  }
  if (form.get("consent") !== "yes") errors.consent = "Please agree, so we can keep your application to review it.";
  else values.consent = "yes";
  return { values, errors };
}

/** Accept only form posts made from our own pages (stops cross-site form posting). */
export function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

const MAX_BODY = 16 * 1024;

/** POST /api/apply */
export async function handleApply(request, env, respond, fillPage) {
  if (!sameOrigin(request)) return respond("Forbidden\n", 403, "text/plain; charset=utf-8");
  if (!(request.headers.get("content-type") ?? "").startsWith("application/x-www-form-urlencoded"))
    return respond("Unsupported form encoding\n", 415, "text/plain; charset=utf-8");
  const body = await request.text();
  if (body.length > MAX_BODY) return respond("Too large\n", 413, "text/plain; charset=utf-8");
  const form = new URLSearchParams(body);
  const kind = form.get("kind");
  if (!Object.hasOwn(KINDS, kind)) return respond("Unknown form\n", 400, "text/plain; charset=utf-8");
  const done = () => new Response(null, { status: 303, headers: { location: `/${kind}/apply/?sent=1`, "cache-control": "no-store" } });
  if (form.get("website")) return done(); // honeypot: a bot filled the hidden field; pretend all is well
  const { values, errors } = validate(kind, form);
  if (Object.keys(errors).length) return fillPage(`/${kind}/apply/`, { apply: () => renderApplyForm(kind, values, errors) }, 422);
  if (await rateLimited(env, request.headers.get("cf-connecting-ip") ?? "unknown"))
    return fillPage(`/${kind}/apply/`, { apply: () => `<div class="form-errors" role="alert"><p>Too many applications from this connection. Please try again in an hour.</p></div>` }, 429);
  const { consent, ...fields } = values;
  await saveApplication(env, { kind, ...fields, consent: true });
  return done();
}
