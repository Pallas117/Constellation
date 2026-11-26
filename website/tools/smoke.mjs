// Smoke check for a deployed release (GAU-178): the pages answer with the security headers, the apply pages offer the
// route this release uses, /api/health is green, names the release and the commit you meant to deploy.
//   public (default): the closed routes answer 404, the apply pages offer the email route, no page links to sign-in.
//   --full (accounts open): every page header says Sign in, the apply pages have their form, /app/ asks for a sign-in
//          (Access's redirect on lightbound.space, the Worker's own 401 on workers.dev), /argo/ opens, and unsigned
//          posts are refused (403 without our origin, 400 without Stripe's signature), never 404 or 5xx.
// usage: npm run smoke:website -- [--full] https://lightbound-site.<account>.workers.dev [expected-commit-sha]
// Read-only apart from two empty POSTs that must be refused. Exits 1 on any failure.
import { SECURITY_HEADERS } from "../worker/headers.js";

const args = process.argv.slice(2);
const full = args.includes("--full");
const [baseArg = "", expectSha = ""] = args.filter((a) => a !== "--full");
const base = baseArg.replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$|^http:\/\/127\.0\.0\.1:\d+$/.test(base)) { // or a local preview: RELEASE=public npm run site:dev
  console.error("usage: npm run smoke:website -- [--full] https://<host> [expected-commit-sha]");
  process.exit(2);
}
const release = full ? "full" : "public";
let failed = 0;
const check = (ok, what, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail && !ok ? `: ${detail}` : ""}`);
};
const get = (path, init = {}) => fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(15_000), ...init });

const PAGES = ["/", "/gauss/", "/gauss/evidence/", "/gauss/storms/", "/constellation/", "/constellation/time/", "/turnstone/", "/education/", "/privacy/", "/terms/"];
const EMAIL_ROUTES = ["/gauss/apply/", "/constellation/apply/", "/education/apply/", "/constellation/workshops/"];

const SIGN_IN = '<a href="/app/" class="signin">Sign in</a>';
for (const path of [...PAGES, ...EMAIL_ROUTES]) {
  const res = await get(path);
  const body = await res.text();
  const wrong = Object.entries(SECURITY_HEADERS).filter(([k, v]) => res.headers.get(k) !== v).map(([k]) => k);
  check(res.status === 200 && wrong.length === 0, `${path} 200 with security headers`, `status ${res.status}${wrong.length ? `, headers wrong: ${wrong.join(", ")}` : ""}`);
  if (full) {
    check(body.includes(SIGN_IN), `${path} header says Sign in`);
    if (EMAIL_ROUTES.includes(path)) check(/<form[^>]*action="\/api\/apply"/.test(body) && !/BY_EMAIL/.test(body), `${path} has its form`);
  } else if (EMAIL_ROUTES.includes(path)) check(!/<form/.test(body) && /BY_EMAIL/.test(body), `${path} offers the email route, no form`);
  else check(!/href="\/app\//.test(body), `${path} has no sign-in link`);
}
const post = (path) => get(path, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded" } });
if (full) {
  for (const path of ["/app/", "/app/admin/"]) {
    const res = await get(path);
    const to = res.headers.get("location") ? new URL(res.headers.get("location"), base).href : "";
    // The local preview (dev.mjs) stands in for Access with its own /__dev/login page.
    const access = [302, 303].includes(res.status) && (/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com\//.test(to) || (base.startsWith("http://127.0.0.1:") && to.startsWith(`${base}/__dev/login?`)));
    check(access || res.status === 401, `GET ${path} asks for a sign-in (Access redirect or 401)`, `status ${res.status}${to ? ` to ${new URL(to, base).host}` : ""}`);
  }
  check((await get("/argo/")).status === 200, "GET /argo/ 200");
  check((await post("/api/apply")).status === 403, "POST /api/apply without our origin is refused (403)");
  check((await post("/api/stripe/webhook")).status === 400, "POST /api/stripe/webhook without a signature is refused (400)");
} else {
  for (const [path, method] of [["/app/", "GET"], ["/app/admin/", "GET"], ["/argo/", "GET"], ["/api/apply", "POST"], ["/api/stripe/webhook", "POST"]]) {
    const res = await (method === "POST" ? post(path) : get(path));
    check(res.status === 404, `${method} ${path} is closed (404)`, `status ${res.status}`);
  }
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
check(health.release === release, `release is ${release}`, String(health.release));
if (expectSha) check(health.source === expectSha, `deployed commit is ${expectSha.slice(0, 7)}`, `health says ${health.source}`);
else console.log(`info deployed commit: ${health.source ?? "not set (deploy with --var SOURCE_SHA:<sha>)"}`);

// Custom domains: plain HTTP must go to HTTPS (Cloudflare's "Always Use HTTPS"). workers.dev is HTTPS-only already.
if (base.startsWith("https://") && !new URL(base).hostname.endsWith(".workers.dev")) {
  const res = await fetch(base.replace(/^https:/, "http:") + "/", { redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch((e) => ({ status: 0, headers: new Headers(), e }));
  check([301, 302, 307, 308].includes(res.status) && (res.headers.get("location") ?? "").startsWith("https://"), "http:// redirects to https://", `status ${res.status}`);
}
console.log(failed ? `${failed} check(s) failed` : "all checks passed");
process.exit(failed ? 1 : 0);
