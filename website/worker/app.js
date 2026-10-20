// The signed-in side: /app/ (a customer's Gauss workspace, and Constellation membership) and
// /app/admin/ (applications, quotes, billing, invitations; for the emails in ADMIN_EMAILS).
// Every request is checked: a valid Cloudflare Access token for who, the account record for what.
// Paying happens on Stripe's own pages (checkout, or an invoice where an admin allows it); this side starts it and reads the result.
import { accessIdentity, isAdmin } from "./auth.js";
import { deleteAccount, getAccount, getApplication, listAccounts, listApplications, putAccount, setApplicationStatus } from "./data.js";
import { sameOrigin } from "./forms.js";
import { readFeed } from "./feeds.js";
import { esc, renderEventIcs, renderGaussDoor, supportLink } from "./render.js";
import { deleteCall, getCall, listCalls, renderCalls, renderCallsAdmin, rsvp, saveCall } from "./calls.js";
import { isZone, zonedToUtc } from "./timezones.js";
import { APP_CSP } from "./headers.js";
import { createArgoCheckout, createCheckout, createEduCheckout, createEduInvoice, createInvoice, createPortal, customerOf, eduInvoiceable, invoiceable, payable } from "./stripe.js";
import { renderClassroom } from "./classroom.js";
import { ARGO, BILLING, EDU, FEATURES, INVOICE_DAYS, PILOT_STEPS, TIERS, argoCanStart, argoPrice, billingStatus, eduEligible, eduMode, eduStaffLabel, eduStaffPrice, gbp, isAcademicEmail, priceLabel, quoteInRange, tierById, unlocked } from "./tiers.js";

export const APP_HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex", "Content-Security-Policy": APP_CSP };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]{2,}$/;

function pilotTrack(step) {
  const at = PILOT_STEPS.indexOf(step);
  return `<ol class="track">${PILOT_STEPS.map((s, i) => `<li class="${i < at ? "done" : i === at ? "here" : ""}"${i === at ? ' aria-current="step"' : ""}>${esc(s)}</li>`).join("")}</ol>`;
}

const postButton = (action, label, cls = "btn") => `<form method="post" action="${action}" class="inline"><button class="${cls}">${esc(label)}</button></form>`;
// Stripe's hosted invoice page (https), or a same-origin path (the local stand-in); anything else is not shown.
const linkable = (u) => /^(https:\/\/|\/(?!\/))[^\s"<>]*$/.test(u ?? "");

function billingCard(account, tier) {
  const status = billingStatus(account);
  const b = account.billing ?? {};
  const quote = account.quote ? `${gbp(account.quote)} ${tier.billing === "subscription" ? "a year" : "one-off"}` : priceLabel(tier);
  const portal = customerOf(account) ? postButton("/app/billing", "Manage billing", "btn ghost") : "";
  const invoice = linkable(b.invoiceUrl) ? `<p class="actions"><a class="btn" href="${esc(b.invoiceUrl)}" rel="noopener noreferrer">View invoice</a></p>` : "";
  let body;
  if (tier.billing === "invoice") body = `<p class="m">Billed by milestone, as agreed in your scope.</p>${portal}`;
  else if (status === "due" || status === "canceled")
    body = payable(account)
      ? `<p class="m">${status === "canceled" ? "Your plan was cancelled. You can start it again any time." : b.paidUntil ? "Your year is up. Renew to keep going." : "Your quote is ready."}</p>` +
        `<div class="pay">${postButton("/app/checkout", status === "canceled" ? "Restart plan" : b.paidUntil ? "Renew now" : "Pay now")}` +
        `${invoiceable(account) ? postButton("/app/invoice", "Request an invoice", "btn ghost") : ""}</div>` +
        (invoiceable(account) ? `<p class="m">An invoice gives you ${INVOICE_DAYS} days to pay, and your workspace opens straight away.</p>` : "")
      : `<p class="m">We're preparing your quote. You'll see it here.</p>`;
  else if (status === "invoice_open") body = `<p class="m">Sent to ${esc(account.email)}${b.dueAt ? `; due ${esc(day(b.dueAt))}` : ""}. Your workspace is open meanwhile.</p>${invoice}`;
  else if (status === "overdue") body = `<p class="m warn">Your invoice was due on ${esc(day(b.dueAt))}. The workspace reopens when it's paid.</p>${invoice}`;
  else if (status === "processing") body = `<p class="m">Payment processing. This can take a few working days.</p>`;
  else if (status === "past_due") body = `<p class="m warn">Your last payment failed. Please update your payment details.</p>${portal}`;
  else body = `<p class="m">${status === "active" ? "Renews yearly." : `Paid${b.updatedAt ? ` on ${esc(day(b.updatedAt))}` : ""}.${b.paidUntil ? ` Covers you until ${esc(day(b.paidUntil))}.` : ""}`}</p>${portal}`;
  return `<article class="tile billing"><h2 class="label">Billing</h2><p class="big">${esc(quote)}</p><p class="t">${esc(BILLING[status] ?? status)}</p>${body}</article>`;
}

/** Gauss Argo in the workspace: the list, a start button once ARGO_SALES allows it, then its own billing state. */
export function argoCard(env, account) {
  const a = account?.argo;
  const can = argoCanStart(env, account);
  if (!a && !can) return "";
  const status = a?.billing?.status ?? "due";
  const portal = customerOf(account) ? postButton("/app/billing", "Manage billing", "btn ghost") : "";
  let body;
  if (status === "active") body = `<p class="m">Renews monthly. We'll email your install link and setup steps.</p>${portal}`;
  else if (status === "past_due") body = `<p class="m warn">Your last payment failed. Please update your payment details.</p>${portal}`;
  else if (can) body = `<p class="m">${status === "canceled" ? "Cancelled. You can start again any time." : "Connectivity that heals itself, on your Mac or Linux machines."}</p>` +
    `<div class="pay">${postButton("/app/argo/checkout", status === "canceled" ? "Restart Gauss Argo" : "Start Gauss Argo")}</div>`;
  else body = `<p class="m">You're on the early-access list. We'll email you when it opens.</p>`;
  const state = a?.billing ? BILLING[status] ?? status : can ? "Ready to start" : "Early access";
  return `<article class="tile billing"><h2 class="label">${esc(ARGO.name)}</h2><p class="big">${esc(argoPrice)}</p><p class="t">${esc(state)}</p>${body}<p class="m"><a href="/argo/">About ${esc(ARGO.name)}</a></p></article>`;
}

const YEAR_MS = 365 * 86_400_000;
/** Education access is open: a free student year, a staff subscription, or a department licence (paid, or invoiced and not overdue). */
export const eduOpen = (account, now = Date.now()) => !!account?.edu?.billing && unlocked(billingStatus({ billing: account.edu.billing }, now));

/** Gauss for Education in the workspace: start (free student year or staff plan), or the department licence and its invoice. */
export function eduCard(env, account, email, start = false) {
  const e = account?.edu;
  const mode = eduMode(env);
  if (!e && !(mode === "open" && (start || isAcademicEmail(email)))) return "";
  const b = e?.billing;
  const status = b ? billingStatus({ billing: b }) : null;
  const classroom = `<p class="actions"><a class="btn" href="/app/edu/">Open the classroom</a></p>`;
  const invoiceLink = linkable(b?.invoiceUrl) ? `<p class="actions"><a class="btn ghost" href="${esc(b.invoiceUrl)}" rel="noopener noreferrer">View invoice</a></p>` : "";
  let price = "", state, body;
  if (e?.plan === "department") {
    price = e.quote ? `${gbp(e.quote)} a year` : "Quoted per year";
    state = status === "paid" ? "Licence active" : BILLING[status] ?? "Payment due";
    if (status === "paid") body = `<p class="m">Department licence until ${esc(day(b.paidUntil))}.</p>${classroom}`;
    else if (status === "invoice_open") body = `<p class="m">Invoice sent to ${esc(account.email)}${b.dueAt ? `; due ${esc(day(b.dueAt))}` : ""}. The classroom is open meanwhile.</p>${classroom}${invoiceLink}`;
    else if (status === "overdue") body = `<p class="m warn">Your invoice was due on ${esc(day(b.dueAt))}. The classroom reopens when it's paid.</p>${invoiceLink}`;
    else body = `<p class="m">Your department licence is approved. Ask for the invoice to start; you'll have ${INVOICE_DAYS} days to pay.</p><div class="pay">${postButton("/app/edu/invoice", "Request the invoice")}</div>`;
  } else if (status && unlocked(status)) {
    const student = e.plan === "student";
    price = student ? "Free" : eduStaffLabel(env);
    state = student ? "Student" : BILLING[status] ?? status;
    body = (status === "past_due" ? `<p class="m warn">Your last payment failed. Please update your payment details.</p>`
      : `<p class="m">${student ? `Free until ${esc(day(b.paidUntil))}; renew then with the same check.` : "Renews monthly."}</p>`) +
      classroom + (student || !customerOf(account) ? "" : postButton("/app/billing", "Manage billing", "btn ghost"));
  } else if (mode !== "open") {
    state = "Opening soon";
    body = `<p class="m">We'll email you when it opens.</p>`;
  } else if (!eduEligible(account, email)) {
    state = "University email needed";
    body = `<p class="m">Sign in with your university email to start, or <a href="/education/apply/">ask us to review</a> your request.</p>`;
  } else {
    const staff = eduStaffPrice(env);
    state = status === "due" && e?.plan === "student" ? "Renew your student year" : status === "canceled" ? "Cancelled" : "Ready to start";
    body = `<form method="post" action="/app/edu/student" class="edu-start"><label class="check"><input type="checkbox" name="student" value="yes" required> <span>I'm a student at this university, using it to study.</span></label>` +
      `<p class="actions"><button class="btn">Start free as a student</button></p></form>` +
      `<div class="pay">${staff ? postButton("/app/edu/checkout", `Staff and research · ${eduStaffLabel(env)}`, "btn ghost") : `<span class="btn ghost" aria-disabled="true">Staff and research: price TBC</span>`}</div>`;
  }
  return `<article class="tile billing"><h2 class="label">${esc(EDU.name)}</h2>${price ? `<p class="big">${esc(price)}</p>` : ""}<p class="t">${esc(state)}</p>${body}<p class="m"><a href="/education/">About ${esc(EDU.name)}</a></p></article>`;
}

function memberCard(supportUrl = "") {
  return `<article class="tile"><h2 class="label">Constellation</h2><p class="big">Member</p><p class="t">Free, by invitation.</p>` +
    `<p class="m">Community channels are shared with members directly. Launch calendar: <a href="/api/launches.ics">subscribe</a>.</p>` +
    (supportLink(supportUrl) ? `<p class="m"><a href="${esc(supportUrl)}" rel="noopener">Support Constellation</a> (optional)</p>` : "") +
    `<p class="m"><a href="/constellation/">Constellation</a></p></article>`;
}

export function renderWorkspace({ email, account, admin, weather, consoleUrl, supportUrl = "", argo = "", edu = "", applications = [], notice = "" }) {
  const tier = tierById(account?.tier);
  const who = esc(account?.name || email);
  const adminLink = admin ? `<p class="actions"><a class="btn ghost" href="/app/admin/">Applications and accounts</a></p>` : "";
  const member = account?.community === "member";
  const confirmed = unlocked(account?.billing?.status);
  const banner = {
    success: confirmed ? "Payment received. Thank you." : "Thank you. We're confirming your payment; refresh this page in a minute.",
    cancelled: "Checkout cancelled. Nothing was charged.",
    invoice: `Invoice sent to ${email}.`,
    argo: `Thank you. ${ARGO.name} is starting; refresh this page in a minute if it doesn't show as active.`,
    "edu-started": `Thank you. Your ${EDU.name} staff plan is starting; refresh this page in a minute if it doesn't show as active.`,
    "edu-student": `Welcome. Your free student year of ${EDU.name} has started: open the classroom below.`,
  }[notice];
  const bannerHtml = banner ? `<p class="banner" role="status">${esc(banner)}</p>` : "";
  if (!tier) {
    const pending = applications.filter((a) => a.status === "new");
    const status = pending.length
      ? `<p class="lead">Your application from ${esc(day(pending[0].at))} is with the Lightbound team. You'll hear from us by email.</p>`
      : `<p class="lead">You're signed in as ${esc(email)}.${member || argo || edu ? "" : " This account has no Gauss plan yet."}</p>`;
    return `<p class="k">00_WORKSPACE</p><h1 id="hero-h">Welcome, ${who}.</h1>${bannerHtml}${status}` +
      (member || argo || edu ? `<div class="tiles">${member ? memberCard(supportUrl) : ""}${argo}${edu}</div>` : "") +
      (member || argo || edu ? "" : `<p class="actions"><a class="btn" href="/gauss/#plans">See the Gauss plans</a>${pending.length ? "" : ` <a class="btn ghost" href="/gauss/apply/">Apply</a>`}</p>`) + adminLink;
  }
  const open = unlocked(billingStatus(account));
  const next = TIERS[TIERS.indexOf(tier) + 1];
  const list = (ids) => ids.map((f) => `<li>${esc(FEATURES[f])}</li>`).join("");
  const consoleBtn = !open ? "" : consoleUrl
    ? `<a class="btn" href="${esc(consoleUrl)}">Open the Gauss console</a>`
    : `<span class="btn ghost" aria-disabled="true">Console link coming by email</span>`;
  return (
    `<div class="section-head"><div><p class="k">00_WORKSPACE</p><h1 id="hero-h">Welcome, ${who}.</h1></div><span class="chip tier">${esc(tier.name)}</span></div>${bannerHtml}` +
    `<p class="lead">${esc(account.org ? `${account.org} · ` : "")}${esc(tier.outcome)}</p>` +
    (consoleBtn ? `<p class="actions">${consoleBtn}</p>` : "") +
    `<div class="tiles">${billingCard(account, tier)}` +
    (open ? `<article class="tile"><h2 class="label">Pilot</h2>${account.pilot ? pilotTrack(account.pilot) : `<p class="m">Not started. We'll set this up with you.</p>`}</article>` : "") +
    `<article class="tile"><h2 class="label">Space environment</h2>${renderGaussDoor(weather) || `<p class="m">Space-weather data is unavailable right now.</p>`}</article>` +
    (member ? memberCard(supportUrl) : "") + argo + edu + `</div>` +
    `<div class="two plan-lists"><div><h2 class="label">${open ? "Included" : "What you get"}: ${esc(tier.name)}</h2><ul class="ticks">${list(tier.features)}</ul></div>` +
    (next ? `<div><h2 class="label">Next: ${esc(next.name)}</h2><ul class="locked">${list(next.features.filter((f) => !tier.features.includes(f)))}</ul><p class="m">${esc(next.entry)} Planning range: ${esc(priceLabel(next))}.</p></div>` : "") +
    `</div><p class="actions"><a class="btn ghost" href="mailto:jzwnathan@lightbound.uk?subject=${encodeURIComponent(`Gauss ${tier.name}`)}">Email Josh, the founder</a></p>` +
    `<p class="note">Gauss is advisory: it shows evidence and never commands a spacecraft.</p>${adminLink}`
  );
}

// ---- Admin ----
const opt = (v, label, cur) => `<option value="${esc(v)}"${v === (cur ?? "") ? " selected" : ""}>${esc(label)}</option>`;
const tierSelect = (cur) => `<select name="tier" aria-label="Gauss plan">${opt("", "No Gauss plan", cur)}${TIERS.map((t) => opt(t.id, `${t.name} (${priceLabel(t)})`, cur)).join("")}</select>`;
const quoteInput = (pence) => `<label class="money"><span>£</span><input name="quote" type="number" inputmode="numeric" min="0" step="500" aria-label="Quote in pounds" placeholder="Quote" value="${pence ? pence / 100 : ""}"></label>`;
// Defaults to "automatic" (keep, or reset to due when the plan or quote changes); the current state shows as a tag.
const billingSelect = () => `<select name="billing" aria-label="Billing override">${opt("", "Billing: automatic", "")}${Object.entries(BILLING).map(([k, l]) => opt(k, `Set: ${l}`, null)).join("")}</select>`;
const pilotSelect = (cur) => `<select name="pilot" aria-label="Pilot step">${opt("", "No pilot", cur)}${PILOT_STEPS.map((s) => opt(s, s, cur)).join("")}</select>`;
const invoiceCheck = (on, id) => `<label class="check" for="${id}"><input id="${id}" type="checkbox" name="invoice" value="yes"${on ? " checked" : ""}> Allow invoice</label>`;
const communitySelect = (cur) => `<select name="community" aria-label="Constellation">${opt("", "Not a member", cur)}${opt("member", "Constellation member", cur)}</select>`;

const inviteDraft = (email, name) => {
  const body = `Hello${name ? ` ${name}` : ""},\n\nYou're invited to Constellation, Lightbound's space community group. Membership is free.\n\nSign in with this email address at https://lightbound.uk/app/ (we'll email you a one-time code; there's no password).\n\nJoshua`;
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Your invitation to Constellation")}&body=${encodeURIComponent(body)}`;
};

export function renderAdmin({ applications, accounts, details, invited, error }) {
  const open = applications.filter((a) => a.status === "new");
  const done = applications.filter((a) => a.status !== "new");
  const card = (a) => {
    const d = details[a.id] ?? {};
    const planId = tierById(a.plan) ? a.plan : "pilot";
    const facts = [d.org, d.role, d.topic, d.format, d.groupSize ? `group: ${d.groupSize}` : "", d.institution, d.eduRole, d.course, d.seats ? `${d.seats} (people)` : "", d.missionType, d.stage, d.groundStack, d.dataAccess, d.timeline, d.interest, d.platform, d.devices ? `${d.devices} devices` : "",
      d.referrer ? `referred by ${d.referrer}` : "", d.link].filter(Boolean).join(" · ");
    const decide = a.status === "new"
      ? `<form method="post" action="/app/admin/decide" class="inline"><input type="hidden" name="id" value="${esc(a.id)}">` +
        (a.kind === "gauss" ? `${tierSelect(planId)} ${quoteInput(0)} ${invoiceCheck(false, `inv-${esc(a.id)}`)}` : a.kind === "constellation" ? `<input type="hidden" name="community" value="member">` : a.kind === "edu" ? `${quoteInput(0)} ` : "") +
        `<button class="btn" name="decision" value="approve">${{ gauss: "Approve with quote", constellation: "Invite", argo: "Invite to early access", edu: "Approve for self-serve", workshop: "Mark contacted" }[a.kind] ?? "Approve"}</button> ` +
        (a.kind === "edu" ? `<button class="btn ghost" name="decision" value="department">Department licence at this yearly quote</button> ` : "") +
        `<button class="btn ghost" name="decision" value="decline">Decline</button></form>`
      : `<span class="tag${a.status === "approved" ? " go" : ""}">${esc(a.status)}</span>`;
    const kicker = { gauss: `GAUSS · ${tierById(a.plan)?.name ?? a.plan ?? ""}`, constellation: "CONSTELLATION · INVITATION REQUEST", argo: "ARGO · EARLY ACCESS AND RELAY WAITLIST", edu: `EDUCATION · ${d.eduRole ?? ""}`, workshop: `WORKSHOP · ${d.topic ?? ""}` }[a.kind] ?? a.kind;
    return `<li class="app-card"><div class="app-head"><span class="label">${esc(kicker)}</span><time datetime="${esc(a.at)}">${esc(day(a.at))}</time></div>` +
      `<h3>${esc(a.name)} <span class="muted">${esc(a.email)}</span></h3>${facts ? `<p class="m">${esc(facts)}</p>` : ""}` +
      (d.message || d.note ? `<p class="msg">${esc(d.message || d.note)}</p>` : "") + decide + `</li>`;
  };
  const rows = accounts.map((u, i) => {
    const status = u.billing ? billingStatus({ tier: u.tier, billing: { status: u.billing, dueAt: u.dueAt, paidUntil: u.paidUntil } }) : null;
    return `<tr><td>${esc(u.email)}<br><span class="muted">${esc(u.org ?? "")}</span></td><td><form method="post" action="/app/admin/account" class="inline">` +
      `<input type="hidden" name="email" value="${esc(u.email)}">${tierSelect(u.tier)} ${quoteInput(u.quote)} ${billingSelect()} ${invoiceCheck(u.invoice, `acct-inv-${i}`)} ${pilotSelect(u.pilot)} ${communitySelect(u.community)} ` +
      `<button class="btn ghost" name="action" value="save">Save</button> <button class="btn ghost" name="action" value="delete">Remove</button></form>` +
      `${status ? `<span class="tag${status === "overdue" || status === "past_due" ? " warn" : ""}">${esc(BILLING[status] ?? status)}</span>` : ""}` +
      `${u.argo ? ` <span class="tag">Argo: ${esc(u.argo === "invited" ? "invited" : BILLING[u.argo] ?? u.argo)}</span>` : ""}` +
      `${u.edu ? ` <span class="tag">Education: ${esc(u.edu)}</span>` : ""}</td></tr>`;
  }).join("");
  const banner = error === "quote" || error === "edu"
    ? `<p class="banner warn" role="alert">${error === "edu" ? "Not approved: enter the department licence's yearly quote in pounds." : "Not approved: enter a quote inside the plan's range."}</p>`
    : invited ? `<p class="banner" role="status">${esc(invited.email)} is now a Constellation member. <a href="${esc(inviteDraft(invited.email, invited.name))}">Draft the invitation email</a> (opens your mail app; nothing is sent automatically).</p>` : "";
  return (
    `<p class="k">00_ADMIN</p><h1 id="hero-h">Applications and accounts.</h1>${banner}` +
    `<h2>New (${open.length})</h2>${open.length ? `<ul class="apps">${open.map(card).join("")}</ul>` : `<p class="muted">Nothing waiting.</p>`}` +
    `<h2>Invite to Constellation</h2><p class="muted">Free and invite-only. This creates the membership; you send the invitation yourself.</p>` +
    `<form method="post" action="/app/admin/invite" class="inline add"><label class="sr" for="inv-email">Email</label><input id="inv-email" name="email" type="email" placeholder="email@example.com" required> ` +
    `<label class="sr" for="inv-name">Name</label><input id="inv-name" name="name" placeholder="Name" maxlength="100"> <button class="btn">Invite</button></form>` +
    `<h2>Accounts (${accounts.length})</h2><div class="tw"><table class="table"><thead><tr><th>Email</th><th>Plan, quote (£), billing, invoice, pilot, membership</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<form method="post" action="/app/admin/account" class="inline add"><label class="sr" for="new-email">Email</label><input id="new-email" name="email" type="email" placeholder="email@company.com" required> ` +
    `${tierSelect("")} ${quoteInput(0)} ${billingSelect()} ${invoiceCheck(false, "new-inv")} ${pilotSelect("")} ${communitySelect("")} <button class="btn" name="action" value="save">Add account</button></form>` +
    `<h2>Decided (${done.length})</h2>${done.length ? `<ul class="apps">${done.map(card).join("")}</ul>` : `<p class="muted">None yet.</p>`}` +
    `<p class="note">Quotes must sit inside the plan's published range. Paid plans move to Active or Paid when Stripe confirms; "Billing" overrides that by hand. ` +
    `"Allow invoice" lets that customer ask for a Stripe invoice (${INVOICE_DAYS} days to pay) instead of paying by card: their workspace opens at once and locks if the invoice goes overdue. ` +
    `Applications delete themselves 180 days after they arrive.</p>`
  );
}

const signedOut = (respond) =>
  respond(`<!doctype html><meta charset="utf-8"><title>Sign in · Lightbound</title><link rel="stylesheet" href="/assets/site.css"><main class="vault wrap"><div><p class="k">401_SIGN_IN</p><h1>Please sign in.</h1><p class="muted">The workspace is for approved accounts and Constellation members.</p><p class="actions"><a class="btn" href="/app/">Sign in</a> <a class="btn ghost" href="/gauss/apply/">Apply</a></p></div></main>`,
    401, "text/html; charset=utf-8", APP_HEADERS);

// A new plan or quote starts billing afresh: no earlier invoice, paid year or event can count towards it.
const FRESH = { eventAt: null, invoice: null, invoiceUrl: null, dueAt: null, paidUntil: null };

/** Quote from the form, in pence, only if it sits inside the plan's range. */
function quoteFrom(form, tier) {
  const pounds = Number(form.get("quote"));
  return tier && quoteInRange(tier, pounds) ? Math.round(pounds * 100) : null;
}

/** Everything under /app/. */
export async function handleApp(request, env, url, { respond, fillPage, fetchImpl }) {
  const id = await accessIdentity(request, env, { fetchImpl });
  if (!id) return signedOut(respond);
  const admin = isAdmin(env, id.email);
  const back = (to) => new Response(null, { status: 303, headers: { location: to, ...APP_HEADERS } });
  const fail = (status, text) => respond(`${text}\n`, status, "text/plain; charset=utf-8", APP_HEADERS);
  const billingDown = () => respond(`<!doctype html><meta charset="utf-8"><title>Billing unavailable · Lightbound</title><link rel="stylesheet" href="/assets/site.css"><main class="vault wrap"><div><p class="k">503_BILLING</p><h1>Billing is unavailable right now.</h1><p class="muted">Nothing was charged. Please try again shortly, or email jzwnathan@lightbound.uk.</p><p class="actions"><a class="btn" href="/app/">Back to your workspace</a></p></div></main>`,
    503, "text/html; charset=utf-8", APP_HEADERS);

  if (request.method === "POST") {
    if (!sameOrigin(request)) return fail(403, "Forbidden");
    // Customer actions: start checkout or open the billing portal (both on Stripe's own pages), or ask for an invoice.
    if (url.pathname === "/app/checkout" || url.pathname === "/app/billing" || url.pathname === "/app/invoice") {
      const account = await getAccount(env, id.email);
      try {
        const canPay = payable(account) && ["due", "canceled"].includes(billingStatus(account));
        if (url.pathname === "/app/invoice") {
          if (!canPay || !invoiceable(account)) return back("/app/");
          const inv = await createInvoice(env, account, fetchImpl);
          await putAccount(env, { ...account, billing: { ...(account.billing ?? {}), status: "invoice_open", customer: inv.customer ?? account.billing?.customer ?? null, invoice: inv.id,
            invoiceUrl: inv.hosted_invoice_url ?? null, dueAt: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null } }, id.email);
          return back("/app/?invoice=sent");
        }
        const session = url.pathname === "/app/checkout"
          ? (canPay ? await createCheckout(env, account, url.origin, fetchImpl) : null)
          : customerOf(account) ? await createPortal(env, account, url.origin, fetchImpl) : null;
        if (!session?.url) return back("/app/");
        return new Response(null, { status: 303, headers: { location: session.url, ...APP_HEADERS } });
      } catch {
        return billingDown();
      }
    }
    if (url.pathname.startsWith("/app/edu/")) {
      const account = (await getAccount(env, id.email)) ?? { email: id.email };
      const form = new URLSearchParams(await request.text());
      const ready = eduMode(env) === "open" && eduEligible(account, id.email) && !eduOpen(account);
      try {
        if (url.pathname === "/app/edu/student") {
          if (!ready || form.get("student") !== "yes") return back("/app/");
          const now = new Date();
          await putAccount(env, { ...account, edu: { ...(account.edu ?? {}), plan: "student", studentConfirmedAt: now.toISOString(),
            billing: { status: "paid", free: true, paidUntil: new Date(now.getTime() + YEAR_MS).toISOString() } } }, id.email);
          return back("/app/?edu=student");
        }
        if (url.pathname === "/app/edu/checkout") {
          const price = eduStaffPrice(env);
          if (!ready || !price) return back("/app/");
          if (!account.updatedAt) await putAccount(env, account, id.email); // the webhook needs an account to update
          const session = await createEduCheckout(env, account, url.origin, price, fetchImpl);
          if (!session?.url) return back("/app/");
          return new Response(null, { status: 303, headers: { location: session.url, ...APP_HEADERS } });
        }
        if (url.pathname === "/app/edu/invoice") {
          if (!eduInvoiceable(account) || !["due", "canceled"].includes(billingStatus({ billing: account.edu.billing }))) return back("/app/");
          const inv = await createEduInvoice(env, account, fetchImpl);
          await putAccount(env, { ...account, edu: { ...account.edu, customer: inv.customer ?? account.edu.customer ?? null, billing: { ...(account.edu.billing ?? {}), status: "invoice_open",
            invoice: inv.id, invoiceUrl: inv.hosted_invoice_url ?? null, dueAt: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null } } }, id.email);
          return back("/app/?invoice=sent");
        }
      } catch {
        return billingDown();
      }
      return fail(404, "Not found");
    }
    if (url.pathname === "/app/argo/checkout") {
      const account = (await getAccount(env, id.email)) ?? { email: id.email };
      if (!argoCanStart(env, account) || ["active", "past_due"].includes(account.argo?.billing?.status)) return back("/app/");
      try {
        if (!account.updatedAt) await putAccount(env, account, id.email); // the webhook needs an account to update
        const session = await createArgoCheckout(env, account, url.origin, fetchImpl);
        if (!session?.url) return back("/app/");
        return new Response(null, { status: 303, headers: { location: session.url, ...APP_HEADERS } });
      } catch {
        return billingDown();
      }
    }
    const isMember = admin || (await getAccount(env, id.email))?.community === "member";
    if (url.pathname === "/app/prefs") {
      const tz = new URLSearchParams(await request.text()).get("tz");
      if (isZone(tz)) await putAccount(env, { ...((await getAccount(env, id.email)) ?? { email: id.email }), tz }, id.email);
      return back("/app/#calls-h");
    }
    if (url.pathname === "/app/calls/rsvp") {
      if (!isMember) return fail(403, "Forbidden");
      const f = new URLSearchParams(await request.text());
      const result = await rsvp(env, f.get("id") ?? "", id.email, f.get("want") === "yes");
      return back(`/app/?call=${result}#calls-h`);
    }
    if (!admin) return fail(403, "Forbidden");
    const form = new URLSearchParams(await request.text());
    if (url.pathname === "/app/admin/calls") {
      if (form.get("action") === "delete") {
        if (await getCall(env, form.get("id") ?? "")) await deleteCall(env, form.get("id"));
        return back("/app/admin/#calls");
      }
      const title = String(form.get("title") ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
      const start = zonedToUtc(form.get("start"), form.get("zone"));
      const minutes = [30, 45, 60, 90].includes(Number(form.get("minutes"))) ? Number(form.get("minutes")) : 60;
      const capacity = Math.min(200, Math.max(2, Number.parseInt(form.get("capacity") ?? "20", 10) || 20));
      const link = String(form.get("link") ?? "").trim();
      const notes = String(form.get("notes") ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
      if (!title || start === null || start < Date.now() || (link && !/^https:\/\/[^\s<>"]+\.[^\s<>"]+$/i.test(link)) || link.length > 300)
        return back("/app/admin/?error=call#calls");
      await saveCall(env, { title, start: new Date(start).toISOString(), minutes, capacity, link, notes });
      return back("/app/admin/#calls");
    }
    const tier = tierById(form.get("tier"));
    const pilot = PILOT_STEPS.includes(form.get("pilot")) ? form.get("pilot") : null;
    const community = form.get("community") === "member" ? "member" : null;
    if (url.pathname === "/app/admin/decide") {
      const app = await getApplication(env, form.get("id") ?? "");
      if (!app || app.status !== "new") return back("/app/admin/");
      const department = app.kind === "edu" && form.get("decision") === "department";
      const approve = form.get("decision") === "approve" || department;
      const pounds = Number(form.get("quote"));
      if (department && !(Number.isFinite(pounds) && pounds > 0 && pounds <= 1_000_000)) return back("/app/admin/?error=edu");
      if (approve && app.kind === "gauss" && (!tier || (tier.billing !== "invoice" && quoteFrom(form, tier) === null))) return back("/app/admin/?error=quote");
      await setApplicationStatus(env, app, approve ? "approved" : "declined", id.email);
      if (approve && app.kind === "edu") { // self-serve eligibility, or a department licence at a yearly quote (pence)
        const prev = (await getAccount(env, app.email)) ?? { email: app.email };
        const edu = { ...(prev.edu ?? {}), approvedAt: new Date().toISOString(),
          ...(department ? { plan: "department", quote: Math.round(pounds * 100), institution: app.institution ?? null, seats: app.seats ?? null, billing: { status: "due" } } : {}) };
        await putAccount(env, { ...prev, name: prev.name ?? app.name, org: prev.org ?? app.institution ?? null, edu }, id.email);
      } else if (approve && app.kind === "argo") { // early access: they can start once ARGO_SALES is "invite" or "open"; no Gauss plan or membership
        const prev = (await getAccount(env, app.email)) ?? { email: app.email };
        await putAccount(env, { ...prev, name: prev.name ?? app.name, argo: { ...(prev.argo ?? {}), invitedAt: new Date().toISOString() } }, id.email);
      } else if (approve && app.kind !== "workshop") { // a workshop request is a lead: "Mark contacted" changes no account
        const prev = (await getAccount(env, app.email)) ?? { email: app.email };
        const base = { ...prev, name: prev.name ?? app.name, org: prev.org ?? app.org ?? null };
        await putAccount(env, app.kind === "gauss"
          ? { ...base, tier: tier.id, quote: quoteFrom(form, tier), invoice: form.get("invoice") === "yes", billing: { ...(prev.billing ?? {}), ...FRESH, status: tier.billing === "invoice" ? "invoiced" : "due" }, pilot: prev.pilot ?? (tier.id === "pilot" ? "Scoping" : null) }
          : { ...base, community: "member", invitedAt: new Date().toISOString() }, id.email);
        if (app.kind === "constellation") return back(`/app/admin/?invited=${encodeURIComponent(app.email)}`);
      }
      return back("/app/admin/");
    }
    if (url.pathname === "/app/admin/invite") {
      const email = String(form.get("email") ?? "").trim().toLowerCase();
      if (!EMAIL.test(email)) return back("/app/admin/");
      const prev = (await getAccount(env, email)) ?? { email };
      const name = String(form.get("name") ?? "").trim().slice(0, 100) || prev.name || null;
      await putAccount(env, { ...prev, name, community: "member", invitedAt: new Date().toISOString() }, id.email);
      return back(`/app/admin/?invited=${encodeURIComponent(email)}`);
    }
    if (url.pathname === "/app/admin/account") {
      const email = String(form.get("email") ?? "").trim().toLowerCase();
      if (!EMAIL.test(email)) return back("/app/admin/");
      if (form.get("action") === "delete") {
        await deleteAccount(env, email);
        return back("/app/admin/");
      }
      const prev = (await getAccount(env, email)) ?? { email };
      const quote = quoteFrom(form, tier);
      const changed = (tier?.id ?? null) !== (prev.tier ?? null) || (quote ?? null) !== (prev.quote ?? null);
      const override = Object.hasOwn(BILLING, form.get("billing") ?? "") ? form.get("billing") : null;
      const status = override ?? (changed ? (tier?.billing === "invoice" ? "invoiced" : tier ? "due" : null) : prev.billing?.status ?? null);
      const billing = status ? { ...(prev.billing ?? {}), ...(changed ? FRESH : override ? { eventAt: null } : {}), status } : prev.billing ?? null;
      await putAccount(env, { ...prev, tier: tier?.id ?? null, quote, invoice: form.get("invoice") === "yes", billing, pilot, community }, id.email);
      return back("/app/admin/");
    }
    return fail(404, "Not found");
  }

  const ics = /^\/app\/calls\/([a-z0-9-]{3,40})\.ics$/.exec(url.pathname);
  if (ics) {
    const account = await getAccount(env, id.email);
    if (!admin && account?.community !== "member") return fail(403, "Forbidden");
    const call = await getCall(env, ics[1]);
    if (!call) return fail(404, "Not found");
    const booked = admin || !!(await env.DATA.get(`rsvp:${call.id}:${id.email}`));
    const body = renderEventIcs({ uid: `call-${call.id}`, start: call.start, minutes: call.minutes, summary: `Constellation: ${call.title}`,
      description: [call.notes, booked && call.link ? `Join: ${call.link}` : "Book a seat at https://lightbound.uk/app/ to get the link."].filter(Boolean).join("\n"),
      url: booked && call.link ? call.link : "" });
    return respond(body, 200, "text/calendar; charset=utf-8", { ...APP_HEADERS, "content-disposition": 'attachment; filename="constellation-call.ics"' });
  }
  if (url.pathname === "/app/edu/") {
    const account = await getAccount(env, id.email);
    if (!admin && !eduOpen(account)) return back("/app/");
    return fillPage("/app/", { workspace: () => renderClassroom() }, 200, APP_HEADERS);
  }
  if (url.pathname === "/app/admin/") {
    if (!admin) return fail(403, "Forbidden");
    const applications = await listApplications(env);
    const details = Object.fromEntries(await Promise.all(applications.filter((a) => a.status === "new").map(async (a) => [a.id, (await getApplication(env, a.id)) ?? {}])));
    const accounts = await listAccounts(env);
    const invitedEmail = url.searchParams.get("invited");
    const invited = invitedEmail ? await getAccount(env, invitedEmail) : null;
    const error = ["quote", "call", "edu"].includes(url.searchParams.get("error")) ? url.searchParams.get("error") : null;
    const calls = await listCalls(env);
    return fillPage("/app/admin/", { admin: () => renderAdmin({ applications, accounts, details, invited: invited?.community === "member" ? invited : null, error }) +
      `<div id="calls">${error === "call" ? `<p class="banner warn" role="alert">Not scheduled: give a title, a future start time and an https link (or none).</p>` : ""}` +
      `${renderCallsAdmin(calls, accounts.filter((a) => a.community === "member").map((a) => a.email), url.origin)}</div>` }, 200, APP_HEADERS);
  }
  if (url.pathname === "/app/") {
    const [account, weather, applications] = await Promise.all([getAccount(env, id.email), readFeed(env, "weather"), listApplications(env)]);
    const mine = applications.filter((a) => a.email === id.email);
    const eduNotice = { started: "edu-started", student: "edu-student" }[url.searchParams.get("edu")];
    const notice = eduNotice ?? (url.searchParams.get("argo") === "started" ? "argo" : url.searchParams.get("invoice") === "sent" ? "invoice" : ["success", "cancelled"].includes(url.searchParams.get("checkout")) ? url.searchParams.get("checkout") : "");
    const member = admin || account?.community === "member";
    const calls = member ? await listCalls(env) : [];
    const callNotice = url.searchParams.get("call") ?? "";
    return fillPage("/app/", { workspace: () => renderWorkspace({ email: id.email, account, admin, weather, consoleUrl: env.GAUSS_APP_URL || "", supportUrl: env.SUPPORT_URL || "", argo: argoCard(env, account ?? { email: id.email }), edu: eduCard(env, account ?? { email: id.email }, id.email, url.searchParams.get("edu") === "start"), applications: mine, notice }) +
      (member ? renderCalls({ calls, email: id.email, tz: isZone(account?.tz) ? account.tz : "UTC", notice: callNotice }) : "") }, 200, APP_HEADERS);
  }
  return fail(404, "Not found");
}
