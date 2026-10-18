// The signed-in side: /app/ (a customer's Gauss workspace) and /app/admin/ (applications and
// accounts, for the emails in ADMIN_EMAILS). Every request is checked: a valid Cloudflare Access
// token for who, the account record in KV for what. Pages are private and never cached.
import { accessIdentity, isAdmin } from "./auth.js";
import { deleteAccount, getAccount, getApplication, listAccounts, listApplications, putAccount, setApplicationStatus } from "./data.js";
import { sameOrigin } from "./forms.js";
import { readFeed } from "./feeds.js";
import { esc, renderGaussDoor } from "./render.js";
import { FEATURES, PILOT_STEPS, TIERS, tierById } from "./tiers.js";

export const APP_HEADERS = { "cache-control": "private, no-store", "x-robots-tag": "noindex" };
const day = (iso) => (iso ? iso.slice(0, 10) : "");

function pilotTrack(step) {
  const at = PILOT_STEPS.indexOf(step);
  return `<ol class="track">${PILOT_STEPS.map((s, i) => `<li class="${i < at ? "done" : i === at ? "here" : ""}"${i === at ? ' aria-current="step"' : ""}>${esc(s)}</li>`).join("")}</ol>`;
}

export function renderWorkspace({ email, account, admin, weather, consoleUrl }) {
  const tier = tierById(account?.tier);
  const who = esc(account?.name || email);
  const adminLink = admin ? `<p class="actions"><a class="btn ghost" href="/app/admin/">Applications and accounts</a></p>` : "";
  const member = account?.community === "member" ? `<span class="tag go">Constellation member</span>` : "";
  if (!tier) {
    return `<p class="k">00_WORKSPACE</p><h1 id="hero-h">Welcome, ${who}.</h1>${member ? `<p>${member}</p>` : ""}` +
      `<p class="lead">You're signed in as ${esc(email)}, but this account has no Gauss plan yet.</p>` +
      `<p class="actions"><a class="btn" href="/gauss/apply/">Apply for a plan</a> <a class="btn ghost" href="/gauss/#plans">See the plans</a></p>${adminLink}`;
  }
  const next = TIERS[TIERS.indexOf(tier) + 1];
  const included = tier.features.map((f) => `<li>${esc(FEATURES[f])}</li>`).join("");
  const more = next ? next.features.filter((f) => !tier.features.includes(f)).map((f) => `<li>${esc(FEATURES[f])}</li>`).join("") : "";
  const open = consoleUrl
    ? `<a class="btn" href="${esc(consoleUrl)}">Open the Gauss console</a>`
    : `<span class="btn ghost" aria-disabled="true">Console link coming by email</span>`;
  return (
    `<div class="section-head"><div><p class="k">00_WORKSPACE</p><h1 id="hero-h">Welcome, ${who}.</h1></div><span class="chip tier">${esc(tier.name)}</span></div>` +
    `<p class="lead">${esc(account.org ? `${account.org} · ` : "")}${esc(tier.stageName)} ${member}</p>` +
    `<p class="actions">${open} <a class="btn ghost" href="mailto:jzwnathan@lightbound.uk?subject=Gauss%20${encodeURIComponent(tier.name)}">Email your Lightbound contact</a></p>` +
    `<div class="tiles">` +
    `<article class="tile"><h2 class="label">Replay pilot</h2>${account.pilot ? pilotTrack(account.pilot) : `<p class="m">Not started. We'll set this up with you.</p>`}</article>` +
    `<article class="tile"><h2 class="label">Space environment</h2>${renderGaussDoor(weather) || `<p class="m">Space-weather data is unavailable right now.</p>`}</article>` +
    `</div>` +
    `<div class="two plan-lists"><div><h2 class="label">Included in ${esc(tier.name)}</h2><ul class="ticks">${included}</ul></div>` +
    (next ? `<div><h2 class="label">Next: ${esc(next.name)} (${esc(next.stage.toLowerCase())})</h2><ul class="locked">${more}</ul><p class="m">${esc(next.entry)}</p></div>` : "") +
    `</div><p class="note">Gauss is advisory: it shows evidence and never commands a spacecraft.</p>${adminLink}`
  );
}

const opt = (v, label, cur) => `<option value="${esc(v)}"${v === (cur ?? "") ? " selected" : ""}>${esc(label)}</option>`;
const tierSelect = (cur) => `<select name="tier" aria-label="Gauss plan">${opt("", "No Gauss plan", cur)}${TIERS.map((t) => opt(t.id, t.name, cur)).join("")}</select>`;
const pilotSelect = (cur) => `<select name="pilot" aria-label="Pilot step">${opt("", "No pilot", cur)}${PILOT_STEPS.map((s) => opt(s, s, cur)).join("")}</select>`;
const communitySelect = (cur) => `<select name="community" aria-label="Constellation">${opt("", "Not a member", cur)}${opt("member", "Constellation member", cur)}</select>`;

export function renderAdmin({ applications, accounts, details }) {
  const open = applications.filter((a) => a.status === "new");
  const done = applications.filter((a) => a.status !== "new");
  const card = (a) => {
    const d = details[a.id] ?? {};
    const planTier = a.plan && a.plan !== "pilot" ? a.plan : "tactical_fleet";
    const decide = a.status === "new"
      ? `<form method="post" action="/app/admin/decide" class="inline"><input type="hidden" name="id" value="${esc(a.id)}">` +
        (a.kind === "gauss" ? tierSelect(planTier) : `<input type="hidden" name="community" value="member">`) +
        `<button class="btn" name="decision" value="approve">Approve</button> <button class="btn ghost" name="decision" value="decline">Decline</button></form>`
      : `<span class="tag${a.status === "approved" ? " go" : ""}">${esc(a.status)}</span>`;
    return `<li class="app-card"><div class="app-head"><span class="label">${esc(a.kind === "gauss" ? `GAUSS · ${a.plan ?? ""}` : "CONSTELLATION")}</span><time datetime="${esc(a.at)}">${esc(day(a.at))}</time></div>` +
      `<h3>${esc(a.name)} <span class="muted">${esc(a.email)}</span></h3>` +
      `<p class="m">${esc([d.org, d.role, d.link].filter(Boolean).join(" · "))}</p>` +
      (d.message ? `<p class="msg">${esc(d.message)}</p>` : "") + decide + `</li>`;
  };
  const rows = accounts.map((u) =>
    `<tr><td>${esc(u.email)}<br><span class="muted">${esc(u.org ?? "")}</span></td><td colspan="3"><form method="post" action="/app/admin/account" class="inline">` +
    `<input type="hidden" name="email" value="${esc(u.email)}">${tierSelect(u.tier)} ${pilotSelect(u.pilot)} ${communitySelect(u.community)} ` +
    `<button class="btn ghost" name="action" value="save">Save</button> <button class="btn ghost" name="action" value="delete">Remove</button></form></td></tr>`).join("");
  return (
    `<p class="k">00_ADMIN</p><h1 id="hero-h">Applications and accounts.</h1>` +
    `<h2>New (${open.length})</h2>${open.length ? `<ul class="apps">${open.map(card).join("")}</ul>` : `<p class="muted">Nothing waiting.</p>`}` +
    `<h2>Accounts (${accounts.length})</h2><div class="tw"><table class="table"><thead><tr><th>Email</th><th>Gauss plan</th><th>Pilot</th><th>Constellation</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<form method="post" action="/app/admin/account" class="inline add"><label class="sr" for="new-email">Email</label><input id="new-email" name="email" type="email" placeholder="email@company.com" required> ` +
    `${tierSelect("")} ${pilotSelect("")} ${communitySelect("")} <button class="btn" name="action" value="save">Add account</button></form>` +
    `<h2>Decided (${done.length})</h2>${done.length ? `<ul class="apps">${done.map(card).join("")}</ul>` : `<p class="muted">None yet.</p>`}` +
    `<p class="note">Applications delete themselves 180 days after they arrive. To erase someone sooner, remove their account and decline their application.</p>`
  );
}

const signedOut = (respond) =>
  respond(`<!doctype html><meta charset="utf-8"><title>Sign in · Lightbound</title><link rel="stylesheet" href="/assets/site.css"><main class="vault wrap"><div><p class="k">401_SIGN_IN</p><h1>Please sign in.</h1><p class="muted">The Gauss workspace is for approved accounts.</p><p class="actions"><a class="btn" href="/app/">Sign in</a> <a class="btn ghost" href="/gauss/apply/">Apply</a></p></div></main>`,
    401, "text/html; charset=utf-8", APP_HEADERS);

/** Everything under /app/. */
export async function handleApp(request, env, url, { respond, fillPage, fetchImpl }) {
  const id = await accessIdentity(request, env, { fetchImpl });
  if (!id) return signedOut(respond);
  const admin = isAdmin(env, id.email);
  const back = (to) => new Response(null, { status: 303, headers: { location: to, ...APP_HEADERS } });

  if (request.method === "POST") {
    if (!admin) return respond("Forbidden\n", 403, "text/plain; charset=utf-8", APP_HEADERS);
    if (!sameOrigin(request)) return respond("Forbidden\n", 403, "text/plain; charset=utf-8", APP_HEADERS);
    const form = new URLSearchParams(await request.text());
    const tier = tierById(form.get("tier"))?.id ?? null;
    const pilot = PILOT_STEPS.includes(form.get("pilot")) ? form.get("pilot") : null;
    const community = form.get("community") === "member" ? "member" : null;
    if (url.pathname === "/app/admin/decide") {
      const app = await getApplication(env, form.get("id") ?? "");
      if (!app || app.status !== "new") return back("/app/admin/");
      const approve = form.get("decision") === "approve";
      await setApplicationStatus(env, app, approve ? "approved" : "declined", id.email);
      if (approve) {
        const prev = (await getAccount(env, app.email)) ?? { email: app.email };
        await putAccount(env, {
          ...prev, name: prev.name ?? app.name, org: prev.org ?? app.org ?? null,
          ...(app.kind === "gauss" ? { tier: tier ?? "tactical_fleet", pilot: prev.pilot ?? "Scoping" } : { community: "member" }),
        }, id.email);
      }
      return back("/app/admin/");
    }
    if (url.pathname === "/app/admin/account") {
      const email = String(form.get("email") ?? "").trim().toLowerCase();
      if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]{2,}$/.test(email)) return back("/app/admin/");
      if (form.get("action") === "delete") await deleteAccount(env, email);
      else await putAccount(env, { ...((await getAccount(env, email)) ?? { email }), tier, pilot, community }, id.email);
      return back("/app/admin/");
    }
    return respond("Not found\n", 404, "text/plain; charset=utf-8", APP_HEADERS);
  }

  if (url.pathname === "/app/admin/") {
    if (!admin) return respond("Forbidden\n", 403, "text/plain; charset=utf-8", APP_HEADERS);
    const applications = await listApplications(env);
    const details = Object.fromEntries(
      await Promise.all(applications.filter((a) => a.status === "new").map(async (a) => [a.id, (await getApplication(env, a.id)) ?? {}])),
    );
    const accounts = await listAccounts(env);
    return fillPage("/app/admin/", { admin: () => renderAdmin({ applications, accounts, details }) }, 200, APP_HEADERS);
  }
  if (url.pathname === "/app/") {
    const [account, weather] = await Promise.all([getAccount(env, id.email), readFeed(env, "weather")]);
    return fillPage("/app/", { workspace: () => renderWorkspace({ email: id.email, account, admin, weather, consoleUrl: env.GAUSS_APP_URL || "" }) }, 200, APP_HEADERS);
  }
  return respond("Not found\n", 404, "text/plain; charset=utf-8", APP_HEADERS);
}
