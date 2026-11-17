// Applications: "Request an invitation" for Constellation (free, invite-only), the Gauss pilot
// brief (the sales plan's onboarding: fit, readiness, pilot brief), Gauss for Education and workshop
// requests. (Gauss Argo has no list any more: it's included for operators and staff.) Plain HTML forms that post to
// /api/apply, so they work without JavaScript. The server validates everything, drops bots (a
// hidden honeypot field plus a per-IP hourly limit) and uses post/redirect/get, so a refresh never
// resubmits. No personal data ever goes into a URL.
import { esc } from "./render.js";
import { TIERS, optionLabel } from "./tiers.js";
import { rateLimited, saveApplication, APPLICATION_DAYS } from "./data.js";
import { readCapped } from "./body.js";
import { CONTACT } from "./release.js";

const PLANS = TIERS.map((t) => [t.id, optionLabel(t)]);
const opts = (...xs) => xs.map((x) => [x, x]);

const FIELD = {
  name: { label: "Name", type: "text", max: 100, auto: "name", required: true },
  email: { label: "Email", type: "email", max: 254, auto: "email", required: true },
  org: { label: "Company", type: "text", max: 120, auto: "organization", required: true },
  role: { label: "Role", type: "text", max: 120, auto: "organization-title", required: true },
  referrer: { label: "Who invited or referred you (optional)", type: "text", max: 120, auto: "off", required: false },
  link: { label: "A link about your work (optional)", type: "url", max: 300, auto: "url", required: false },
  missionType: { label: "Mission type", type: "select", options: opts("Earth observation", "Communications", "Critical communications", "Navigation", "Science or cislunar", "Other"), required: true },
  stage: { label: "Programme stage", type: "select", options: opts("Concept or design", "In development", "Launched and operating"), required: true },
  groundStack: { label: "Ground stack", type: "select", options: opts("Yamcs / XTCE", "Other CCSDS ground stack", "Custom", "Not sure"), required: true },
  dataAccess: { label: "Evidence you can share", type: "select", options: opts("Historical packet archive", "Live or near-live feed", "Agreed synthetic fixture", "Not yet"), required: true },
  plan: { label: "Package", type: "select", options: PLANS, required: true },
  timeline: { label: "Target start", type: "select", options: opts("This quarter", "Next quarter", "Later"), required: true },
  message: { label: "Message", type: "textarea", min: 20, max: 2000, required: true },
  note: { label: "What breaks your connection today? (optional)", type: "textarea", max: 500, required: false },
  institution: { label: "University or school", type: "text", max: 160, auto: "organization", required: true },
  eduRole: { label: "Your role", type: "select", options: opts("Lecturer or teacher", "Researcher", "Department or programme lead", "Student", "Other"), required: true },
  course: { label: "Course, lab or department (optional)", type: "text", max: 160, auto: "off", required: false },
  seats: { label: "How many people", type: "select", options: opts("Just me", "2–20", "21–100", "More than 100"), required: true },
  topic: { label: "Workshop", type: "select", options: opts("Ethics", "Resilience", "Tech leadership", "A mix of the three"), required: true },
  format: { label: "Format", type: "select", options: opts("In person", "Online", "Either"), required: true },
  groupSize: { label: "Group size", type: "select", options: opts("Up to 10", "11–30", "31–100", "More than 100"), required: true },
};

// Gauss follows the onboarding flow in the sales plan: fit, readiness, pilot brief.
export const KINDS = Object.freeze({
  gauss: {
    steps: [
      { legend: "Fit", label: "01_FIT", fields: ["name", "email", "org", "role"] },
      { legend: "Readiness", label: "02_READINESS", fields: ["missionType", "stage", "groundStack", "dataAccess"] },
      { legend: "Pilot brief", label: "03_PILOT_BRIEF", fields: ["plan", "timeline", "message"] },
    ],
    labels: { email: "Work email", message: "Your highest-value outcome, and how we'd know the pilot succeeded" },
    button: "Send pilot brief",
  },
  constellation: {
    steps: [{ fields: ["name", "email", "role", "referrer", "link", "message"] }],
    labels: { role: "What you work on", message: "Why you'd like to join" },
    button: "Request an invitation",
  },
  workshop: {
    steps: [{ fields: ["name", "email", "org", "topic", "format", "groupSize", "timeline", "note"] }],
    labels: { org: "Organisation", timeline: "When", note: "What you'd like your team to come away with (optional)" },
    button: "Ask about a workshop",
  },
  edu: {
    steps: [{ fields: ["name", "email", "institution", "eduRole", "course", "seats", "note"] }],
    labels: { email: "University email", note: "What you'd like to teach or study with it (optional)" },
    button: "Send",
  },
});
/** Where each form's page lives. */
export const applyPath = (kind) => ({ edu: "/education/apply/", workshop: "/constellation/workshops/" })[kind] ?? `/${kind}/apply/`;
const fieldsOf = (kind) => KINDS[kind].steps.flatMap((st) => st.fields);

const label = (kind, f) => KINDS[kind].labels[f] ?? FIELD[f].label;
const SHORT = { name: "name", email: "email", org: "company", role: "role", referrer: "referral", link: "link", missionType: "mission type", stage: "programme stage",
  groundStack: "ground stack", dataAccess: "evidence", plan: "package", timeline: "target start", message: "message", consent: "privacy agreement",
  interest: "what you'd like", platform: "platform", devices: "devices", note: "note", institution: "university or school", eduRole: "role", course: "course", seats: "how many people", topic: "workshop", format: "format", groupSize: "group size" };

function control(kind, f, value, error) {
  const d = FIELD[f];
  const id = `f-${f}`;
  const common = `id="${id}" name="${f}"${d.required ? " required" : ""}${error ? ` aria-invalid="true" aria-describedby="${id}-err"` : ""}`;
  let input;
  if (d.type === "textarea") input = `<textarea ${common} rows="${d.min ? 6 : 3}"${d.min ? ` minlength="${d.min}"` : ""} maxlength="${d.max}">${esc(value)}</textarea>`;
  else if (d.type === "select") {
    const cur = d.options.some(([v]) => v === value) ? value : d.options[0][0]; // unknown value (e.g. in a link): first option
    input = `<select ${common}>${d.options.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  } else input = `<input ${common} type="${d.type}" maxlength="${d.max}" autocomplete="${d.auto}" value="${esc(value)}">`;
  const err = error ? `<p class="err" id="${id}-err">${esc(error)}</p>` : "";
  return `<div class="field"><label for="${id}">${esc(label(kind, f))}</label>${input}${err}</div>`;
}

/** The form. With no values or errors it is identical to the static fallback in the page (tested). */
export function renderApplyForm(kind, values = {}, errors = {}) {
  const k = KINDS[kind];
  const summary = Object.keys(errors).length
    ? `<div class="form-errors" role="alert"><p>Please check: ${Object.keys(errors).map((f) => esc(SHORT[f])).join(", ")}.</p></div>`
    : "";
  const steps = k.steps.map((st) => {
    const inner = st.fields.map((f) => control(kind, f, values[f] ?? "", errors[f])).join("");
    return st.legend ? `<fieldset class="step"><legend><span class="label">${esc(st.label)}</span> ${esc(st.legend)}</legend>${inner}</fieldset>` : inner;
  }).join("");
  return (
    `<form class="form" method="post" action="/api/apply">${summary}` +
    `<input type="hidden" name="kind" value="${kind}">${steps}` +
    `<div class="hp" aria-hidden="true"><label for="f-website">Leave this empty</label><input id="f-website" name="website" tabindex="-1" autocomplete="off"></div>` +
    `<label class="check"><input type="checkbox" name="consent" value="yes" required${values.consent ? " checked" : ""}> <span>Lightbound may keep this for up to ${APPLICATION_DAYS} days to review it. <a href="/privacy/">Privacy</a></span></label>` +
    (errors.consent ? `<p class="err">${esc(errors.consent)}</p>` : "") +
    `<p class="actions"><button class="btn" type="submit">${esc(k.button)}</button></p></form>`
  );
}

const SENT = {
  gauss: ["Thank you. Your pilot brief is with the Lightbound team.", "If it's a fit, we'll reply with a fixed quote. Once approved, you sign in to pay and start.", "/gauss/", "Back to Gauss"],
  constellation: ["Thank you. Your request is with the Constellation team.", "Membership is free and by invitation. If it's a fit, you'll receive an invitation by email.", "/constellation/", "Back to Constellation"],
  workshop: ["Thank you. Your workshop request is with the Constellation team.", "A person reads every request and replies with a proposal for your team.", "/constellation/", "Back to Constellation"],
  edu: ["Thank you. Your request is with the Gauss for Education team.", "With a university email you can start now: sign in with that address. Otherwise we'll review your request; for a department licence we'll reply with a yearly quote.", "/education/", "Back to Gauss for Education"],
};

// A useful next step after sending, beside the way back.
const NEXT = {
  gauss: ["/gauss/evidence/", "See a sample evidence report"],
  constellation: ["https://luma.com/constellation", "Follow Constellation on Luma"],
  workshop: ["https://luma.com/constellation", "See dates on Luma"],
  edu: ["/education/#labs", "See the labs"],
};

export function renderSent(kind) {
  const [title, lead, href, back] = SENT[kind];
  const [nextHref, nextLabel] = NEXT[kind];
  const next = `<a class="btn" href="${nextHref}"${nextHref.startsWith("https://") ? ' rel="noopener"' : ""}>${nextLabel}</a> <a class="btn ghost" href="${href}">${back}</a>`;
  return `<div class="sent" role="status"><p class="k">RECEIVED</p><h2>${title}</h2><p class="lead">${lead}</p><p class="actions">${next}</p></div>`;
}

// The public release (release.js) collects nothing: each form's page asks for the same answers by email instead.
const BY_EMAIL = {
  gauss: ["Send your pilot brief by email.", "Answer these in an email. A person reads every brief and replies with whether a replay pilot fits, and a fixed quote if it does.", "Email your pilot brief", "Gauss brief"],
  constellation: ["Ask for an invitation by email.", "Membership is free and by invitation. Answer these in an email; a person reads every request.", "Email your request", "Constellation invitation"],
  workshop: ["Ask about a workshop by email.", "Answer these in an email and a person replies with a proposal for your team.", "Email your request", "Constellation workshop"],
  edu: ["Tell us about your course by email.", "Gauss for Education is opening soon. Answer these in an email and we'll be in touch.", "Email us", "Gauss for Education"],
};

/** The email route: the form's questions, and a mailto link that carries them (and the chosen package), never any answers. */
export function renderContact(kind, { plan = "" } = {}) {
  const [title, lead, button, subject] = BY_EMAIL[kind];
  const tier = kind === "gauss" ? (TIERS.find((t) => t.id === plan) ?? TIERS[0]) : null;
  const asks = fieldsOf(kind).filter((f) => f !== "email").map((f) => [label(kind, f), f === "plan" && tier ? optionLabel(tier) : ""]);
  const body = `${asks.map(([q, a]) => `${q}: ${a}`).join("\n\n")}\n`;
  const mailto = `mailto:${CONTACT}?subject=${encodeURIComponent(tier ? `${subject} · ${tier.short}` : subject)}&body=${encodeURIComponent(body)}`;
  return `<div class="sent"><p class="k">BY_EMAIL</p><h2>${esc(title)}</h2><p class="lead">${esc(lead)}</p>` +
    `<ul class="ticks">${asks.map(([q, a]) => `<li>${esc(q)}${a ? `: ${esc(a)}` : ""}</li>`).join("")}</ul>` +
    `<p class="actions"><a class="btn" href="${esc(mailto)}">${esc(button)}</a></p>` +
    `<p class="muted">Or write to <a href="mailto:${CONTACT}">${CONTACT}</a>. <a href="/privacy/">Privacy</a></p></div>`;
}

const clean = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function validate(kind, form) {
  const values = {};
  const errors = {};
  for (const f of fieldsOf(kind)) {
    const d = FIELD[f];
    const raw = f === "message" ? String(form.get(f) ?? "").replace(/\r\n/g, "\n").trim() : clean(form.get(f), (d.max ?? 80) + 1);
    values[f] = raw.slice(0, d.max ?? 80);
    if (d.required && !raw) errors[f] = "Required.";
    else if (d.max && raw.length > d.max) errors[f] = `At most ${d.max} characters.`;
    else if (d.type === "select" && !d.options.some(([v]) => v === raw)) errors[f] = "Please choose an option.";
    else if (f === "name" && raw.length < 2) errors[f] = "At least 2 characters.";
    else if (f === "email" && !/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]{2,}$/.test(raw)) errors[f] = "Please enter a valid email address.";
    else if (f === "link" && raw && !/^https?:\/\/[^\s<>"]+\.[^\s<>"]+$/i.test(raw)) errors[f] = "Please enter a full link starting with https://";
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
  const body = await readCapped(request, MAX_BODY);
  if (body === null) return respond("Too large\n", 413, "text/plain; charset=utf-8");
  const form = new URLSearchParams(body);
  const kind = form.get("kind");
  if (!Object.hasOwn(KINDS, kind)) return respond("Unknown form\n", 400, "text/plain; charset=utf-8");
  const done = () => new Response(null, { status: 303, headers: { location: `${applyPath(kind)}?sent=1`, "cache-control": "no-store" } });
  if (form.get("website")) return done(); // honeypot: a bot filled the hidden field; pretend all is well
  const { values, errors } = validate(kind, form);
  if (Object.keys(errors).length) return fillPage(applyPath(kind), { apply: () => renderApplyForm(kind, values, errors) }, 422);
  if (await rateLimited(env, request.headers.get("cf-connecting-ip") ?? "unknown"))
    return fillPage(applyPath(kind), { apply: () => `<div class="form-errors" role="alert"><p>Too many applications from this connection. Please try again in an hour.</p></div>` }, 429);
  const { consent, ...fields } = values;
  await saveApplication(env, { kind, ...fields, consent: true });
  return done();
}
