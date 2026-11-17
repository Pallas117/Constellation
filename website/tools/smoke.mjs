// Smoke check for a deployed public release (GAU-178): the pages answer with the security headers, the closed routes
// answer 404, the apply pages offer the email route, /api/health is green and names the commit you meant to deploy.
// usage: npm run smoke:website -- https://lightbound-site.<account>.workers.dev [expected-commit-sha]
// Read-only apart from two empty POSTs that must be refused. Exits 1 on any failure.
import { SECURITY_HEADERS } from "../worker/headers.js";

const base = (process.argv[2] ?? "").replace(/\/+$/, "");
const expectSha = process.argv[3] ?? "";
if (!/^https:\/\/[^/]+$|^http:\/\/127\.0\.0\.1:\d+$/.test(base)) { // or a local preview: RELEASE=public npm run site:dev
  console.error("usage: npm run smoke:website -- https://<host> [expected-commit-sha]");
  process.exit(2);
}
let failed = 0;
const check = (ok, what, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail && !ok ? `: ${detail}` : ""}`);
};
const get = (path, init = {}) => fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init });

const PAGES = ["/", "/gauss/", "/gauss/evidence/", "/constellation/", "/constellation/time/", "/turnstone/", "/education/", "/privacy/", "/terms/"];
const EMAIL_ROUTES = ["/gauss/apply/", "/constellation/apply/", "/education/apply/", "/constellation/workshops/"];

for (const path of [...PAGES, ...EMAIL_ROUTES]) {
  const res = await get(path);
  const body = await res.text();
  const wrong = Object.entries(SECURITY_HEADERS).filter(([k, v]) => res.headers.get(k) !== v).map(([k]) => k);
  check(res.status === 200 && wrong.length === 0, `${path} 200 with security headers`, `status ${res.status}${wrong.length ? `, headers wrong: ${wrong.join(", ")}` : ""}`);
  if (EMAIL_ROUTES.includes(path)) check(!/<form/.test(body) && /BY_EMAIL/.test(body), `${path} offers the email route, no form`);
  else check(!/href="\/app\//.test(body), `${path} has no sign-in link`);
}
for (const [path, method] of [["/app/", "GET"], ["/app/admin/", "GET"], ["/argo/", "GET"], ["/api/apply", "POST"], ["/api/stripe/webhook", "POST"]]) {
  const res = await get(path, { method, ...(method === "POST" ? { body: "", headers: { "content-type": "application/x-www-form-urlencoded" } } : {}) });
  check(res.status === 404, `${method} ${path} is closed (404)`, `status ${res.status}`);
}
for (const path of ["/api/launches", "/api/space-weather", "/api/launches.ics"]) check((await get(path)).status === 200, `${path} 200`);

// A fresh deploy fills its feeds on the first request; give it up to a minute.
let health = null;
for (let i = 0; i < 7; i++) {
  const res = await get("/api/health");
  health = { status: res.status, ...(await res.json().catch(() => ({}))) };
  if (health.status === 200) break;
  await new Promise((r) => setTimeout(r, 10_000));
}
check(health.status === 200 && health.ok === true, "/api/health 200 (feeds live)", JSON.stringify(health.feeds ?? health));
check(health.release === "public", "release is public", String(health.release));
if (expectSha) check(health.source === expectSha, `deployed commit is ${expectSha.slice(0, 7)}`, `health says ${health.source}`);
else console.log(`info deployed commit: ${health.source ?? "not set (deploy with --var SOURCE_SHA:<sha>)"}`);

// Custom domains: plain HTTP must go to HTTPS (Cloudflare's "Always Use HTTPS"). workers.dev is HTTPS-only already.
if (base.startsWith("https://") && !new URL(base).hostname.endsWith(".workers.dev")) {
  const res = await fetch(base.replace(/^https:/, "http:") + "/", { redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch((e) => ({ status: 0, headers: new Headers(), e }));
  check([301, 302, 307, 308].includes(res.status) && (res.headers.get("location") ?? "").startsWith("https://"), "http:// redirects to https://", `status ${res.status}`);
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
