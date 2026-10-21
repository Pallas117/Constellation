// Applications and accounts, in their own KV namespace (DATA), apart from the feed cache.
//   app:<id>       an application (Constellation membership or a Gauss plan); deleted after 180 days
//   appby:<email>  the latest application from that address (so the workspace needs one read, not a list)
//   acct:<email>   an account: which Gauss plan it has, pilot progress, Constellation membership
// Only what is needed is kept (UK GDPR data minimisation); see public/privacy/.

export const APPLICATION_DAYS = 180;
const DAY = 86_400;

const newId = (now) => `${now.toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
const summary = (a) => ({ id: a.id, kind: a.kind, name: a.name.slice(0, 80), email: a.email, plan: a.plan ?? null, status: a.status, at: a.at });

export async function saveApplication(env, fields, now = Date.now()) {
  const app = { ...fields, id: newId(now), status: "new", at: new Date(now).toISOString() };
  const expiration = Math.floor(now / 1000) + APPLICATION_DAYS * DAY;
  await env.DATA.put(`app:${app.id}`, JSON.stringify(app), { expiration, metadata: summary(app) });
  await env.DATA.put(`appby:${app.email.toLowerCase()}`, JSON.stringify(summary(app)), { expiration });
  return app;
}

/** The latest application from this address (status and date), or null. */
export async function latestApplication(env, email) {
  return env.DATA.get(`appby:${String(email).toLowerCase()}`, { type: "json" });
}

export async function getApplication(env, id) {
  return /^[a-z0-9-]{3,40}$/.test(id) ? env.DATA.get(`app:${id}`, { type: "json" }) : null;
}

export async function setApplicationStatus(env, app, status, by) {
  const next = { ...app, status, decidedBy: by, decidedAt: new Date().toISOString() };
  // Keep the original deletion date: 180 days from when it arrived.
  const expiration = Math.floor(Date.parse(app.at) / 1000) + APPLICATION_DAYS * DAY;
  await env.DATA.put(`app:${app.id}`, JSON.stringify(next), { expiration, metadata: summary(next) });
  const index = `appby:${app.email.toLowerCase()}`; // only if it still points at this application
  if ((await env.DATA.get(index, { type: "json" }))?.at === app.at) await env.DATA.put(index, JSON.stringify(summary(next)), { expiration });
  return next;
}

async function listAll(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.DATA.list({ prefix, cursor });
    out.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/** Newest first, from list metadata (no per-item reads). */
export async function listApplications(env) {
  return (await listAll(env, "app:")).map((k) => ({ id: k.name.slice(4), ...k.metadata })).sort((a, b) => (a.at < b.at ? 1 : -1));
}

export const accountKey = (email) => `acct:${email.toLowerCase()}`;

export async function getAccount(env, email) {
  return email ? env.DATA.get(accountKey(email), { type: "json" }) : null;
}

export async function putAccount(env, account, by) {
  const next = { ...account, email: account.email.toLowerCase(), updatedAt: new Date().toISOString(), updatedBy: by };
  await env.DATA.put(accountKey(next.email), JSON.stringify(next), {
    metadata: {
      tier: next.tier ?? null, quote: next.quote ?? null, billing: next.billing?.status ?? null, dueAt: next.billing?.dueAt ?? null, paidUntil: next.billing?.paidUntil ?? null,
      invoice: next.invoice === true, argo: next.argo ? (next.argo.billing?.status ?? "invited") : null,
      edu: next.edu ? [next.edu.plan ?? "eligible", next.edu.billing?.status].filter(Boolean).join(" ") : null, pilot: next.pilot ?? null, community: next.community ?? null, org: (next.org ?? "").slice(0, 80),
    },
  });
  return next;
}

export async function deleteAccount(env, email) {
  await env.DATA.delete(accountKey(email));
}

export async function listAccounts(env) {
  return (await listAll(env, "acct:")).map((k) => ({ email: k.name.slice(5), ...k.metadata })).sort((a, b) => (a.email < b.email ? -1 : 1));
}

/** The part of an address one sender controls: the whole IPv4 address, or an IPv6 /64 (a single host can hold a whole /64). */
export function senderOf(ip) {
  const s = String(ip ?? "unknown").toLowerCase();
  if (!s.includes(":")) return s;
  const [head, tail = ""] = s.split("::");
  const a = head ? head.split(":") : [];
  const b = s.includes("::") && tail ? tail.split(":") : [];
  const groups = s.includes("::") ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b] : a;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** At most `limit` submissions per hour per (hashed) sender; the raw address is never stored. */
export async function rateLimited(env, ip, limit = 5, now = Date.now()) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lightbound-apply:${senderOf(ip)}`));
  const hash = [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `rl:${hash}:${Math.floor(now / 3_600_000)}`;
  const count = Number((await env.DATA.get(key)) ?? 0);
  if (count >= limit) return true;
  await env.DATA.put(key, String(count + 1), { expirationTtl: 7200 });
  return false;
}
