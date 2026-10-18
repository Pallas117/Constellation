// Applications and accounts, in their own KV namespace (DATA), apart from the feed cache.
//   app:<id>       an application (Constellation membership or a Gauss plan); deleted after 180 days
//   acct:<email>   an account: which Gauss plan it has, pilot progress, Constellation membership
// Only what is needed is kept (UK GDPR data minimisation); see public/privacy/.

export const APPLICATION_DAYS = 180;
const DAY = 86_400;

const newId = (now) => `${now.toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
const summary = (a) => ({ kind: a.kind, name: a.name.slice(0, 80), email: a.email, plan: a.plan ?? null, status: a.status, at: a.at });

export async function saveApplication(env, fields, now = Date.now()) {
  const app = { ...fields, id: newId(now), status: "new", at: new Date(now).toISOString() };
  const expiration = Math.floor(now / 1000) + APPLICATION_DAYS * DAY;
  await env.DATA.put(`app:${app.id}`, JSON.stringify(app), { expiration, metadata: summary(app) });
  return app;
}

export async function getApplication(env, id) {
  return /^[a-z0-9-]{3,40}$/.test(id) ? env.DATA.get(`app:${id}`, { type: "json" }) : null;
}

export async function setApplicationStatus(env, app, status, by) {
  const next = { ...app, status, decidedBy: by, decidedAt: new Date().toISOString() };
  // Keep the original deletion date: 180 days from when it arrived.
  const expiration = Math.floor(Date.parse(app.at) / 1000) + APPLICATION_DAYS * DAY;
  await env.DATA.put(`app:${app.id}`, JSON.stringify(next), { expiration, metadata: summary(next) });
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
    metadata: { tier: next.tier ?? null, quote: next.quote ?? null, billing: next.billing?.status ?? null, pilot: next.pilot ?? null, community: next.community ?? null, org: (next.org ?? "").slice(0, 80) },
  });
  return next;
}

export async function deleteAccount(env, email) {
  await env.DATA.delete(accountKey(email));
}

export async function listAccounts(env) {
  return (await listAll(env, "acct:")).map((k) => ({ email: k.name.slice(5), ...k.metadata })).sort((a, b) => (a.email < b.email ? -1 : 1));
}

/** At most `limit` submissions per hour per (hashed) IP address; the raw address is never stored. */
export async function rateLimited(env, ip, limit = 5, now = Date.now()) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`lightbound-apply:${ip}`));
  const hash = [...new Uint8Array(digest).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const key = `rl:${hash}:${Math.floor(now / 3_600_000)}`;
  const count = Number((await env.DATA.get(key)) ?? 0);
  if (count >= limit) return true;
  await env.DATA.put(key, String(count + 1), { expirationTtl: 7200 });
  return false;
}
