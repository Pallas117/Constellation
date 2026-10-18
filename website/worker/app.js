// The signed-in side: /app/ (a customer's Gauss workspace, and Constellation membership) and
// /app/admin/ (applications, quotes, billing, invitations; for the emails in ADMIN_EMAILS).
// Every request is checked: a valid Cloudflare Access token for who, the account record for what.
// Paying happens on Stripe's own pages; this side only starts checkout and reads the result.
import { accessIdentity, isAdmin } from "./auth.js";
import { deleteAccount, getAccount, getApplication, listAccounts, listApplications, putAccount, setApplicationStatus } from "./data.js";
import { sameOrigin } from "./forms.js";
import { readFeed } from "./feeds.js";
import { esc, renderGaussDoor } from "./render.js";
import { APP_CSP } from "./headers.js";
import { createCheckout, createPortal, payable } from "./stripe.js";
import { BILLING, FEATURES, PILOT_STEPS, TIERS, gbp, priceLabel, quoteInRange, tierById, unlocked } from "./tiers.js";

export const APP_HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex", "Content-Security-Policy": APP_CSP };
const day = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const EMAIL = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]{2,}$/;

function pilotTrack(step) {
  const at = PILOT_STEPS.indexOf(step);
  return `<ol class="track">${PILOT_STEPS.map((s, i) => `<li class="${i < at ? "done" : i === at ? "here" : ""}"${i === at ? ' aria-current="step"' : ""}>${esc(s)}</li>`).join("")}</ol>`;
}

const postButton = (action, label, cls = "btn") => `<form method="post" action="${action}" class="inline"><button class="${cls}">${esc(label)}</button></form>`;
const statusOf = (account, tier) => account?.billing?.status ?? (tier?.billing === "invoice" ? "invoiced" : "due");

function billingCard(account, tier) {
  const status = statusOf(account, tier);
  const quote = account.quote ? `${gbp(account.quote)} ${tier.billing === "subscription" ? "a year" : "one-off"}` : priceLabel(tier);
  const portal = account.billing?.customer ? postButton("/app/billing", "Manage billing", "btn ghost") : "";
  let body;
  if (tier.billing === "invoice") body = `<p class="m">Invoiced by milestone. Invoices come from Stripe by email, payable by bank transfer.</p>${portal}`;
  else if (status === "due" || status === "canceled")
    body = payable(account)
      ? `<p class="m">${status === "canceled" ? "Your plan was cancelled. You can start it again any time." : "Your quote is ready. You'll pay on Stripe's secure page; card details never reach Lightbound."}</p>${postButton("/app/checkout", status === "canceled" ? "Restart with Stripe" : "Pay securely with Stripe")}`
      : `<p class="m">We're preparing your quote. You'll see it here.</p>`;
  else if (status === "processing") body = `<p class="m">Payment processing. Bank payments can take a few working days.</p>`;
  else if (status === "past_due") body = `<p class="m warn">Your last payment failed. Please update your payment method.</p>${portal}`;
  else body = `<p class="m">${status === "active" ? "Renews yearly." : `Paid${account.billing?.updatedAt ? ` on ${esc(day(account.billing.updatedAt))}` : ""}.`}</p>${portal}`;
  return `<article class="tile billing"><h2 class="label">Billing</h2><p class="big">${esc(quote)}</p><p class="t">${esc(BILLING[status] ?? status)}</p>${body}</article>`;
}

function memberCard() {
  return `<article class="tile"><h2 class="label">Constellation</h2><p class="big">Member</p><p class="t">Free, by invitation.</p>` +
    `<p class="m">Community channels are shared with members directly. Launch calendar: <a href="/api/launches.ics">subscribe</a>.</p>` +
    `<p class="m"><a href="/constellation/">Constellation</a></p></article>`;
}

export function renderWorkspace({ email, account, admin, weather, consoleUrl, applications = [], notice = "" }) {
  const tier = tierById(account?.tier);
  const who = esc(account?.name || email);
  const adminLink = admin ? `<p class="actions"><a class="btn ghost" href="/app/admin/">Applications and accounts</a></p>` : "";
  const member = account?.community === "member";
  const confirmed = unlocked(account?.billing?.status);
  const banner = notice === "success"
    ? `<p class="banner" role="status">${confirmed ? "Payment received. Thank you." : "Thank you. Stripe is confirming your payment; refresh this page in a minute."}</p>`
    : notice === "cancelled" ? `<p class="banner" role="status">Checkout cancelled. Nothing was charged.</p>` : "";
  if (!tier) {
    const pending = applications.filter((a) => a.status === "new");
    const status = pending.length
      ? `<p class="lead">Your application from ${esc(day(pending[0].at))} is with the Lightbound team. You'll hear from us by email.</p>`
      : `<p class="lead">You're signed in as ${esc(email)}.${member ? "" : " This account has no Gauss plan yet."}</p>`;
    return `<p class="k">00_WORKSPACE</p><h1 id="hero-h">Welcome, ${who}.</h1>${banner}${status}` +
      (member ? `<div class="tiles">${memberCard()}</div>` : "") +
      `<p class="actions"><a class="btn${member ? " ghost" : ""}" href="/gauss/#plans">See the Gauss plans</a>${pending.length ? "" : ` <a class="btn ghost" href="/gauss/apply/">Apply</a>`}</p>${adminLink}`;
  }
  const open = unlocked(statusOf(account, tier));
  const next = TIERS[TIERS.indexOf(tier) + 1];
  const list = (ids) => ids.map((f) => `<li>${esc(FEATURES[f])}</li>`).join("");
  const consoleBtn = !open ? "" : consoleUrl
    ? `<a class="btn" href="${esc(consoleUrl)}">Open the Gauss console</a>`
    : `<span class="btn ghost" aria-disabled="true">Console link coming by email</span>`;
  return (
    `<div class="section-head"><div><p class="k">00_WORKSPACE</p><h1 id="hero-h">Welcome, ${who}.</h1></div><span class="chip tier">${esc(tier.name)}</span></div>${banner}` +
    `<p class="lead">${esc(account.org ? `${account.org} · ` : "")}${esc(tier.outcome)}</p>` +
    (consoleBtn ? `<p class="actions">${consoleBtn}</p>` : "") +
    `<div class="tiles">${billingCard(account, tier)}` +
    (open ? `<article class="tile"><h2 class="label">Pilot</h2>${account.pilot ? pilotTrack(account.pilot) : `<p class="m">Not started. We'll set this up with you.</p>`}</article>` : "") +
    `<article class="tile"><h2 class="label">Space environment</h2>${renderGaussDoor(weather) || `<p class="m">Space-weather data is unavailable right now.</p>`}</article>` +
    (member ? memberCard() : "") + `</div>` +
    `<div class="two plan-lists"><div><h2 class="label">${open ? "Included" : "What you get"}: ${esc(tier.name)}</h2><ul class="ticks">${list(tier.features)}</ul></div>` +
    (next ? `<div><h2 class="label">Next: ${esc(next.name)}</h2><ul class="locked">${list(next.features.filter((f) => !tier.features.includes(f)))}</ul><p class="m">${esc(next.entry)} Planning range: ${esc(priceLabel(next))}.</p></div>` : "") +
    `</div><p class="actions"><a class="btn ghost" href="mailto:jzwnathan@lightbound.uk?subject=${encodeURIComponent(`Gauss ${tier.name}`)}">Email your Lightbound contact</a></p>` +
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
    const facts = [d.org, d.role, d.missionType, d.stage, d.groundStack, d.dataAccess, d.timeline, d.referrer ? `referred by ${d.referrer}` : "", d.link].filter(Boolean).join(" · ");
    const decide = a.status === "new"
      ? `<form method="post" action="/app/admin/decide" class="inline"><input type="hidden" name="id" value="${esc(a.id)}">` +
        (a.kind === "gauss" ? `${tierSelect(planId)} ${quoteInput(0)}` : `<input type="hidden" name="community" value="member">`) +
        `<button class="btn" name="decision" value="approve">${a.kind === "gauss" ? "Approve with quote" : "Invite"}</button> <button class="btn ghost" name="decision" value="decline">Decline</button></form>`
      : `<span class="tag${a.status === "approved" ? " go" : ""}">${esc(a.status)}</span>`;
    return `<li class="app-card"><div class="app-head"><span class="label">${esc(a.kind === "gauss" ? `GAUSS · ${tierById(a.plan)?.name ?? a.plan ?? ""}` : "CONSTELLATION · INVITATION REQUEST")}</span><time datetime="${esc(a.at)}">${esc(day(a.at))}</time></div>` +
      `<h3>${esc(a.name)} <span class="muted">${esc(a.email)}</span></h3>${facts ? `<p class="m">${esc(facts)}</p>` : ""}` +
      (d.message ? `<p class="msg">${esc(d.message)}</p>` : "") + decide + `</li>`;
  };
  const rows = accounts.map((u) =>
    `<tr><td>${esc(u.email)}<br><span class="muted">${esc(u.org ?? "")}</span></td><td><form method="post" action="/app/admin/account" class="inline">` +
    `<input type="hidden" name="email" value="${esc(u.email)}">${tierSelect(u.tier)} ${quoteInput(u.quote)} ${billingSelect()} ${pilotSelect(u.pilot)} ${communitySelect(u.community)} ` +
    `<button class="btn ghost" name="action" value="save">Save</button> <button class="btn ghost" name="action" value="delete">Remove</button></form>` +
    `${u.billing ? `<span class="tag">${esc(BILLING[u.billing] ?? u.billing)}</span>` : ""}</td></tr>`).join("");
  const banner = error === "quote"
    ? `<p class="banner warn" role="alert">Not approved: enter a quote inside the plan's range.</p>`
    : invited ? `<p class="banner" role="status">${esc(invited.email)} is now a Constellation member. <a href="${esc(inviteDraft(invited.email, invited.name))}">Draft the invitation email</a> (opens your mail app; nothing is sent automatically).</p>` : "";
  return (
    `<p class="k">00_ADMIN</p><h1 id="hero-h">Applications and accounts.</h1>${banner}` +
    `<h2>New (${open.length})</h2>${open.length ? `<ul class="apps">${open.map(card).join("")}</ul>` : `<p class="muted">Nothing waiting.</p>`}` +
    `<h2>Invite to Constellation</h2><p class="muted">Free and invite-only. This creates the membership; you send the invitation yourself.</p>` +
    `<form method="post" action="/app/admin/invite" class="inline add"><label class="sr" for="inv-email">Email</label><input id="inv-email" name="email" type="email" placeholder="email@example.com" required> ` +
    `<label class="sr" for="inv-name">Name</label><input id="inv-name" name="name" placeholder="Name" maxlength="100"> <button class="btn">Invite</button></form>` +
    `<h2>Accounts (${accounts.length})</h2><div class="tw"><table class="table"><thead><tr><th>Email</th><th>Plan, quote (£), billing, pilot, membership</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<form method="post" action="/app/admin/account" class="inline add"><label class="sr" for="new-email">Email</label><input id="new-email" name="email" type="email" placeholder="email@company.com" required> ` +
    `${tierSelect("")} ${quoteInput(0)} ${billingSelect()} ${pilotSelect("")} ${communitySelect("")} <button class="btn" name="action" value="save">Add account</button></form>` +
    `<h2>Decided (${done.length})</h2>${done.length ? `<ul class="apps">${done.map(card).join("")}</ul>` : `<p class="muted">None yet.</p>`}` +
    `<p class="note">Quotes must sit inside the plan's published range. Paid plans move to Active or Paid when Stripe confirms; "Billing" overrides that by hand (for example, for invoiced work). Applications delete themselves 180 days after they arrive.</p>`
  );
}

const signedOut = (respond) =>
  respond(`<!doctype html><meta charset="utf-8"><title>Sign in · Lightbound</title><link rel="stylesheet" href="/assets/site.css"><main class="vault wrap"><div><p class="k">401_SIGN_IN</p><h1>Please sign in.</h1><p class="muted">The workspace is for approved accounts and Constellation members.</p><p class="actions"><a class="btn" href="/app/">Sign in</a> <a class="btn ghost" href="/gauss/apply/">Apply</a></p></div></main>`,
    401, "text/html; charset=utf-8", APP_HEADERS);

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

  if (request.method === "POST") {
    if (!sameOrigin(request)) return fail(403, "Forbidden");
    // Customer actions: start checkout, open the billing portal (both on Stripe's own pages).
    if (url.pathname === "/app/checkout" || url.pathname === "/app/billing") {
      const account = await getAccount(env, id.email);
      try {
        const canPay = payable(account) && ["due", "canceled"].includes(statusOf(account, tierById(account.tier)));
        const session = url.pathname === "/app/checkout"
          ? (canPay ? await createCheckout(env, account, url.origin, fetchImpl) : null)
          : account?.billing?.customer ? await createPortal(env, account, url.origin, fetchImpl) : null;
        if (!session?.url) return back("/app/");
        return new Response(null, { status: 303, headers: { location: session.url, ...APP_HEADERS } });
      } catch {
        return respond(`<!doctype html><meta charset="utf-8"><title>Billing unavailable · Lightbound</title><link rel="stylesheet" href="/assets/site.css"><main class="vault wrap"><div><p class="k">503_BILLING</p><h1>Billing is unavailable right now.</h1><p class="muted">Nothing was charged. Please try again shortly, or email jzwnathan@lightbound.uk.</p><p class="actions"><a class="btn" href="/app/">Back to your workspace</a></p></div></main>`,
          503, "text/html; charset=utf-8", APP_HEADERS);
      }
    }
    if (!admin) return fail(403, "Forbidden");
    const form = new URLSearchParams(await request.text());
    const tier = tierById(form.get("tier"));
    const pilot = PILOT_STEPS.includes(form.get("pilot")) ? form.get("pilot") : null;
    const community = form.get("community") === "member" ? "member" : null;
    if (url.pathname === "/app/admin/decide") {
      const app = await getApplication(env, form.get("id") ?? "");
      if (!app || app.status !== "new") return back("/app/admin/");
      const approve = form.get("decision") === "approve";
      if (approve && app.kind === "gauss" && (!tier || (tier.billing !== "invoice" && quoteFrom(form, tier) === null))) return back("/app/admin/?error=quote");
      await setApplicationStatus(env, app, approve ? "approved" : "declined", id.email);
      if (approve) {
        const prev = (await getAccount(env, app.email)) ?? { email: app.email };
        const base = { ...prev, name: prev.name ?? app.name, org: prev.org ?? app.org ?? null };
        await putAccount(env, app.kind === "gauss"
          ? { ...base, tier: tier.id, quote: quoteFrom(form, tier), billing: { ...(prev.billing ?? {}), status: tier.billing === "invoice" ? "invoiced" : "due", eventAt: null }, pilot: prev.pilot ?? (tier.id === "pilot" ? "Scoping" : null) }
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
      const billing = status ? { ...(prev.billing ?? {}), status, ...(override || changed ? { eventAt: null } : {}) } : prev.billing ?? null;
      await putAccount(env, { ...prev, tier: tier?.id ?? null, quote, billing, pilot, community }, id.email);
      return back("/app/admin/");
    }
    return fail(404, "Not found");
  }

  if (url.pathname === "/app/admin/") {
    if (!admin) return fail(403, "Forbidden");
    const applications = await listApplications(env);
    const details = Object.fromEntries(await Promise.all(applications.filter((a) => a.status === "new").map(async (a) => [a.id, (await getApplication(env, a.id)) ?? {}])));
    const accounts = await listAccounts(env);
    const invitedEmail = url.searchParams.get("invited");
    const invited = invitedEmail ? await getAccount(env, invitedEmail) : null;
    const error = url.searchParams.get("error") === "quote" ? "quote" : null;
    return fillPage("/app/admin/", { admin: () => renderAdmin({ applications, accounts, details, invited: invited?.community === "member" ? invited : null, error }) }, 200, APP_HEADERS);
  }
  if (url.pathname === "/app/") {
    const [account, weather, applications] = await Promise.all([getAccount(env, id.email), readFeed(env, "weather"), listApplications(env)]);
    const mine = applications.filter((a) => a.email === id.email);
    const notice = ["success", "cancelled"].includes(url.searchParams.get("checkout")) ? url.searchParams.get("checkout") : "";
    return fillPage("/app/", { workspace: () => renderWorkspace({ email: id.email, account, admin, weather, consoleUrl: env.GAUSS_APP_URL || "", applications: mine, notice }) }, 200, APP_HEADERS);
  }
  return fail(404, "Not found");
}
