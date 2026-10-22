// Local preview of lightbound.uk with the real Worker code: node website/dev.mjs [--port 8788] [--offline]
// Emulates what Cloudflare provides: static assets from public/ (with _headers, trailing-slash
// handling, 404 page and byte ranges for the film), run_worker_first routing from wrangler.jsonc,
// in-memory KV (LIVE and DATA), the 15-minute cron, Cloudflare Access for /app/* (a local key pair
// signs the same kind of JWT Access sends, so the Worker's real verification code runs), and a
// local Stripe stand-in (/__stripe/: test checkout, invoices and billing portal that send signed webhooks).
// No real keys are used locally; the values below are labelled placeholders.
// --offline uses the recorded feed data instead of the live feeds. Demo accounts use example.test.
import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./worker/index.js";
import { refreshFeeds } from "./worker/feeds.js";
import { putAccount, saveApplication } from "./worker/data.js";
import { saveCall } from "./worker/calls.js";
import { signPayload } from "./worker/stripe.js";
import { esc } from "./worker/render.js";
import { gbp } from "./worker/tiers.js";
import { fixtureFetch } from "./test/fixtures/fetch.mjs";
import { memoryKV } from "./test/fixtures/kv.mjs";
import { makeAccess } from "./test/fixtures/access.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const root = join(dir, "public");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]) || 8788;
const offline = args.includes("--offline");

export function parseJsonc(text) {
  let out = "";
  for (let i = 0, inStr = false; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else out += c;
  }
  return JSON.parse(out);
}

const config = parseJsonc(readFileSync(join(dir, "wrangler.jsonc"), "utf8"));
const patterns = config.assets.run_worker_first.map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`));

// _headers: "/path-pattern" lines followed by indented "Name: value" lines.
const headerRules = [];
for (const line of readFileSync(join(root, "_headers"), "utf8").split("\n")) {
  if (!line.trim() || line.trim().startsWith("#")) continue;
  if (!/^\s/.test(line)) headerRules.push({ rx: new RegExp(`^${line.trim().replace(/\*/g, ".*")}$`), headers: {} });
  else {
    const i = line.indexOf(":");
    headerRules.at(-1).headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
}

// _redirects: "from to status" lines (exact paths only; that's all this site uses).
const redirects = new Map(readFileSync(join(root, "_redirects"), "utf8").split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"))
  .map((l) => l.trim().split(/\s+/)).map(([from, to, status]) => [from, { to, status: Number(status) || 301 }]));

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".mp4": "video/mp4", ".jpg": "image/jpeg", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };

async function serveFile(file, pathname, request, status = 200) {
  // Cloudflare's default for static assets is to revalidate every time; _headers can override it.
  const headers = new Headers({ "content-type": TYPES[extname(file)] ?? "application/octet-stream", "accept-ranges": "bytes",
    "cache-control": "public, max-age=0, must-revalidate" });
  for (const r of headerRules) if (r.rx.test(pathname)) for (const [k, v] of Object.entries(r.headers)) headers.set(k, v);
  const body = await readFile(file);
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && status === 200) {
    const start = range[1] ? Number(range[1]) : body.length - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    headers.set("content-range", `bytes ${start}-${end}/${body.length}`);
    return new Response(body.subarray(start, end + 1), { status: 206, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, { status, headers });
}

const ASSETS = {
  async fetch(input) {
    const request = input instanceof Request ? input : new Request(input);
    const { pathname } = new URL(request.url);
    const abs = normalize(join(root, decodeURIComponent(pathname)));
    if (!abs.startsWith(root) || pathname.split("/").some((s) => s.startsWith("_") || s.startsWith("."))) return serveFile(join(root, "404.html"), pathname, request, 404);
    const redirect = (to, status = 307) => new Response(null, { status, headers: { location: to } });
    if (redirects.has(pathname)) return redirect(redirects.get(pathname).to, redirects.get(pathname).status);
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      if (!pathname.endsWith("/")) return redirect(`${pathname}/`);
      if (existsSync(join(abs, "index.html"))) return serveFile(join(abs, "index.html"), pathname, request);
    } else if (existsSync(abs)) {
      if (pathname.endsWith("/index.html")) return redirect(pathname.slice(0, -"index.html".length));
      return serveFile(abs, pathname, request);
    }
    return serveFile(join(root, "404.html"), pathname, request, 404);
  },
};

// ---- Cloudflare Access, emulated: a dev key pair signs the JWT the Worker verifies ----
const access = await makeAccess();
const env = {
  ASSETS, LIVE: memoryKV(), DATA: memoryKV(),
  ...config.vars,
  ...access.env,
  STRIPE_API_BASE: `http://127.0.0.1:${port}/__stripe`,
  STRIPE_SECRET_KEY: "dev-local-placeholder",
  STRIPE_WEBHOOK_SECRET: "dev-local-webhook-placeholder",
  SUPPORT_URL: process.env.SUPPORT_URL ?? "", // e.g. SUPPORT_URL=https://buy.stripe.com/test_... npm run site:dev
  ARGO_SALES: process.env.ARGO_SALES ?? "open", // the preview shows Gauss Argo on sale; production defaults to "off"
  EDU_SALES: process.env.EDU_SALES ?? "open", // the preview opens Gauss for Education; production defaults to "off"
  EDU_STAFF_PRICE: process.env.EDU_STAFF_PRICE ?? "", // empty = "Price TBC" (no staff checkout), as in production until Josh sets it
};
const admin = String(env.ADMIN_EMAILS).split(",")[0].trim();
const ctx = { waitUntil: (p) => Promise.resolve(p).catch((e) => console.error(e)), passThroughOnException() {} };
const fetchImpl = offline ? fixtureFetch : fetch;
const refresh = async () => console.log(new Date().toISOString(), "refresh", JSON.stringify(await refreshFeeds(env, { fetchImpl })));

// Demo data so the workspace and admin pages have something to show (dev only).
await putAccount(env, { email: "pilot@example.test", name: "Pilot team", org: "Example Orbital", tier: "pilot", quote: 2_800_000, invoice: true, billing: { status: "due" }, pilot: "Scoping" }, "dev-seed");
await putAccount(env, { email: "fleet@example.test", name: "Fleet ops", org: "Example Constellation Ltd", tier: "fleet_integration", quote: 7_500_000, billing: { status: "active", customer: "cus_dev_seed", subscription: "sub_dev_seed" }, pilot: "Evidence report delivered" }, "dev-seed");
await putAccount(env, { email: "member@example.test", name: "Grace Example", community: "member", tz: "Asia/Kuala_Lumpur", invitedAt: new Date().toISOString() }, "dev-seed");
{ // A members' call three days out at 13:00 UTC (dev only).
  const d = new Date(Date.now() + 3 * 86_400_000); d.setUTCHours(13, 0, 0, 0);
  await saveCall(env, { title: "Monthly members' call", start: d.toISOString(), minutes: 60, capacity: 12, link: "https://meet.example.test/constellation", notes: "Launch round-up and ASTRA VIGILIS planning." });
}
await saveApplication(env, { kind: "edu", name: "Dr Lee Example", email: "lee@example.test", institution: "Example University", eduRole: "Department or programme lead", course: "MSc Space Systems", seats: "21–100", note: "A space-weather module for 40 students next term.", consent: true });
await saveApplication(env, { kind: "argo", name: "Kai Example", email: "kai@example.test", interest: "Both", platform: "macOS", devices: "2–5", note: "Hotel and airport Wi-Fi keep breaking our calls.", consent: true });
await saveApplication(env, { kind: "constellation", name: "Ada Example", email: "ada@example.test", role: "Satellite operations engineer", link: "https://example.test/ada", message: "I run ground passes for a small LEO fleet and track debris conjunctions in my spare time.", consent: true });
await saveApplication(env, { kind: "gauss", name: "Ops Example", email: "ops@example.test", org: "Example Space Ltd", role: "Head of mission operations", missionType: "Earth observation", stage: "Launched and operating", groundStack: "Yamcs / XTCE", dataAccess: "Historical packet archive", plan: "pilot", timeline: "This quarter", message: "We fly ONNX models on two smallsats and want to know which outputs to trust after the May storm.", consent: true });

await refresh();
setInterval(refresh, 15 * 60_000).unref();

const cookie = (req, name) => (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === name)?.[1];
const devLogin = (redirect) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in (local) · Lightbound</title><link rel="stylesheet" href="/assets/site.css">
<main class="vault wrap"><div class="narrow"><p class="k">LOCAL_PREVIEW · CLOUDFLARE_ACCESS</p><h1>Sign in</h1>
<p class="muted">On lightbound.uk, Cloudflare Access shows its own sign-in page and emails a one-time code. Locally, pick who to be:</p>
<p class="actions"><a class="btn" href="/__dev/login?as=${encodeURIComponent(admin)}&amp;redirect=${encodeURIComponent(redirect)}">Admin (${admin})</a>
<a class="btn ghost" href="/__dev/login?as=pilot%40example.test&amp;redirect=${encodeURIComponent(redirect)}">Approved, payment due (invoice allowed)</a>
<a class="btn ghost" href="/__dev/login?as=fleet%40example.test&amp;redirect=${encodeURIComponent(redirect)}">Fleet Integration, active</a>
<a class="btn ghost" href="/__dev/login?as=member%40example.test&amp;redirect=${encodeURIComponent(redirect)}">Constellation member</a>
<a class="btn ghost" href="/__dev/login?as=visitor%40example.test&amp;redirect=${encodeURIComponent(redirect)}">Signed in, no plan</a>
<a class="btn ghost" href="/__dev/login?as=student%40example.ac.uk&amp;redirect=${encodeURIComponent(redirect)}">University email (education)</a></p></div></main>`;

// ---- Stripe, emulated: just enough of Checkout, the billing portal and webhooks ----
const sessions = new Map();
const invoices = new Map(); // in_dev_N -> { id, customer, metadata, description, amount, created, due_date, status }
const customers = new Map(); // customer -> { email, plan, subscription }
let seq = 0;
const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
};
async function deliver(type, object) {
  const payload = JSON.stringify({ id: `evt_dev_${++seq}`, type, created: Math.floor(Date.now() / 1000), data: { object } });
  const res = await worker.fetch(new Request(`http://127.0.0.1:${port}/api/stripe/webhook`, {
    method: "POST", body: payload, headers: { "content-type": "application/json", "stripe-signature": await signPayload(env.STRIPE_WEBHOOK_SECRET, payload) },
  }), env, ctx);
  console.log("stripe stand-in ->", type, res.status);
}
const standInPage = (title, body) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} (local Stripe stand-in)</title><link rel="stylesheet" href="/assets/site.css">
<main class="vault wrap"><div class="narrow"><p class="k">LOCAL_PREVIEW · STRIPE_STAND_IN</p>${body}<p class="muted">On lightbound.uk this is Stripe's own page. Nothing here is charged.</p></div></main>`;

async function stripeStandIn(req, url, send) {
  const html = (body) => send(200, { "content-type": "text/html; charset=utf-8" }, body);
  const json = (obj) => send(200, { "content-type": "application/json" }, JSON.stringify(obj));
  const parts = url.pathname.split("/").filter(Boolean); // __stripe, ...
  if (req.method === "POST" && url.pathname.startsWith("/__stripe/v1/")) {
    if (req.headers.authorization !== `Bearer ${env.STRIPE_SECRET_KEY}`) return send(401, { "content-type": "application/json" }, '{"error":{"code":"auth"}}');
    const form = new URLSearchParams(await readBody(req));
    if (url.pathname === "/__stripe/v1/checkout/sessions") {
      const id = `cs_dev_${++seq}`;
      sessions.set(id, {
        id, mode: form.get("mode"), amount: Number(form.get("line_items[0][price_data][unit_amount]")), name: form.get("line_items[0][price_data][product_data][name]"),
        email: form.get("client_reference_id"), plan: form.get("metadata[plan]"), product: form.get("metadata[product]"), offer: form.get("metadata[offer]"), customer: form.get("customer") || `cus_dev_${seq}`,
        yearly: form.get("line_items[0][price_data][recurring][interval]") === "year", success: form.get("success_url"), cancel: form.get("cancel_url"),
      });
      // Same origin as the site the visitor is on, so the page's CSP (form-action) allows the redirect.
      return json({ id, url: `${new URL(form.get("success_url")).origin}/__stripe/checkout/${id}` });
    }
    if (url.pathname === "/__stripe/v1/customers") {
      const id = `cus_dev_${++seq}`;
      customers.set(id, { email: form.get("email"), plan: form.get("metadata[plan]") });
      return json({ id });
    }
    if (url.pathname === "/__stripe/v1/invoices") {
      const inv = { id: `in_dev_${++seq}`, customer: form.get("customer"), description: form.get("description"), days: Number(form.get("days_until_due")),
        metadata: Object.fromEntries([...form].filter(([k]) => /^metadata\[[a-z_]+\]$/.test(k)).map(([k, v]) => [k.slice(9, -1), v])), amount: 0, created: Math.floor(Date.now() / 1000), status: "draft" };
      invoices.set(inv.id, inv);
      return json(inv);
    }
    if (url.pathname === "/__stripe/v1/invoiceitems") {
      const inv = invoices.get(form.get("invoice"));
      if (!inv) return send(404, { "content-type": "application/json" }, '{"error":{"code":"resource_missing"}}');
      inv.amount += Number(form.get("amount"));
      return json({ id: `ii_dev_${++seq}`, invoice: inv.id });
    }
    const invAction = /^\/__stripe\/v1\/invoices\/([^/]+)\/(finalize|send)$/.exec(url.pathname);
    if (invAction && invoices.has(invAction[1])) {
      const inv = invoices.get(invAction[1]);
      if (inv.status === "draft") Object.assign(inv, { status: "open", due_date: inv.created + inv.days * 86_400 });
      if (invAction[2] === "send") console.log("stripe stand-in: invoice", inv.id, "would be emailed to", inv.metadata.email);
      // A same-origin path, so the link works whichever host name the preview is opened on.
      return json({ ...inv, hosted_invoice_url: `/__stripe/invoice/${inv.id}` });
    }
    if (url.pathname === "/__stripe/v1/billing_portal/sessions") return json({ url: `${new URL(form.get("return_url")).origin}/__stripe/portal/${encodeURIComponent(form.get("customer"))}?return=${encodeURIComponent(form.get("return_url"))}` });
    return send(404, {}, "");
  }
  if (parts[1] === "checkout" && sessions.has(parts[2])) {
    const cs = sessions.get(parts[2]);
    if (req.method === "POST" && parts[3] === "pay") {
      const meta = cs.product ? { email: cs.email, product: cs.product, ...(cs.offer ? { offer: cs.offer } : {}) } : { email: cs.email, plan: cs.plan };
      const subscription = cs.mode === "subscription" ? `sub_dev_${++seq}` : null;
      customers.set(cs.customer, { ...meta, meta, subscription });
      await deliver("checkout.session.completed", { id: cs.id, mode: cs.mode, payment_status: "paid", customer: cs.customer, subscription, client_reference_id: cs.email, metadata: meta });
      if (subscription) await deliver("customer.subscription.created", { id: subscription, status: "active", customer: cs.customer, metadata: meta });
      return send(303, { location: cs.success });
    }
    const price = cs.product ? `$${cs.amount / 100} a month` : `${gbp(cs.amount)}${cs.yearly ? " a year" : ""}`;
    return html(standInPage("Checkout", `<h1>${esc(cs.name)}</h1><p class="lead">${esc(price)} · ${esc(cs.email)}</p>
<form method="post" action="/__stripe/checkout/${cs.id}/pay"><p class="actions"><button class="btn">Pay (test)</button> <a class="btn ghost" href="${esc(cs.cancel)}">Cancel</a></p></form>`));
  }
  if (parts[1] === "invoice" && invoices.has(parts[2])) {
    const inv = invoices.get(parts[2]);
    if (req.method === "POST" && inv.status === "open" && ["pay", "void"].includes(parts[3])) {
      inv.status = parts[3] === "pay" ? "paid" : "void";
      await deliver(parts[3] === "pay" ? "invoice.paid" : "invoice.voided", { id: inv.id, customer: inv.customer, created: inv.created, status: inv.status, metadata: inv.metadata });
      return send(303, { location: "/app/" });
    }
    const due = inv.due_date ? new Date(inv.due_date * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "";
    return html(standInPage("Invoice", `<h1>${esc(inv.description)}</h1><p class="lead">${esc(gbp(inv.amount))} · ${esc(inv.metadata.email)}${due ? ` · due ${esc(due)}` : ""} · ${esc(inv.status)}</p>` +
      (inv.status === "open" ? `<div class="actions"><form method="post" action="/__stripe/invoice/${inv.id}/pay" class="inline"><button class="btn">Pay invoice (test)</button></form>` +
        `<form method="post" action="/__stripe/invoice/${inv.id}/void" class="inline"><button class="btn ghost">Void (test)</button></form></div>` : "") +
      `<p class="actions"><a class="btn ghost" href="/app/">Back to Lightbound</a></p>`));
  }
  if (parts[1] === "portal") {
    const customer = decodeURIComponent(parts[2] ?? "");
    const back = url.searchParams.get("return") ?? "/app/";
    const c = customers.get(customer) ?? (customer === "cus_dev_seed" ? { email: "fleet@example.test", plan: "fleet_integration", subscription: "sub_dev_seed" } : null);
    if (req.method === "POST" && c?.subscription) {
      const action = parts[3];
      const metadata = c.meta ?? { email: c.email, plan: c.plan };
      if (action === "fail") await deliver("customer.subscription.updated", { id: c.subscription, status: "past_due", customer, metadata });
      if (action === "fix") await deliver("customer.subscription.updated", { id: c.subscription, status: "active", customer, metadata });
      if (action === "cancel") await deliver("customer.subscription.deleted", { id: c.subscription, status: "canceled", customer, metadata });
      return send(303, { location: back });
    }
    const q = `?return=${encodeURIComponent(back)}`;
    const buttons = c?.subscription
      ? ["fail", "Simulate a failed renewal", "fix", "Update card (test)", "cancel", "Cancel subscription"].reduce((acc, v, i, a) => (i % 2 ? acc : acc + `<form method="post" action="/__stripe/portal/${encodeURIComponent(customer)}/${a[i]}${q}" class="inline"><button class="btn ghost">${a[i + 1]}</button></form> `), "")
      : `<p class="muted">Invoices and receipts appear here.</p>`;
    return html(standInPage("Billing portal", `<h1>Billing</h1><p class="lead">${esc(c?.email ?? customer)}</p><div class="actions">${buttons}</div><p class="actions"><a class="btn" href="${esc(back)}">Back to Lightbound</a></p>`));
  }
  return send(404, {}, "");
}

createServer(async (req, res) => {
  try {
    const url = new URL(`http://${req.headers.host ?? `127.0.0.1:${port}`}${req.url}`);
    const send = (status, headers, body = "") => {
      res.writeHead(status, headers);
      res.end(body);
    };
    if (url.pathname.startsWith("/__stripe/")) return stripeStandIn(req, url, send);
    if (url.pathname === "/__dev/login") {
      const as = url.searchParams.get("as");
      const to = url.searchParams.get("redirect")?.startsWith("/") ? url.searchParams.get("redirect") : "/app/";
      if (as && /^[^@\s]+@[^@\s]+$/.test(as)) return send(302, { location: to, "set-cookie": `dev_access=${encodeURIComponent(as)}; Path=/; HttpOnly; SameSite=Lax` });
      return send(200, { "content-type": "text/html; charset=utf-8" }, devLogin(to));
    }
    if (url.pathname === "/cdn-cgi/access/logout") return send(302, { location: "/", "set-cookie": "dev_access=; Path=/; Max-Age=0" });

    const headers = new Headers(Object.entries(req.headers).filter(([, v]) => typeof v === "string"));
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      const who = cookie(req, "dev_access");
      if (!who) return send(302, { location: `/__dev/login?redirect=${encodeURIComponent(url.pathname)}` });
      headers.set("cf-access-jwt-assertion", await access.sign(decodeURIComponent(who)));
    }
    headers.set("cf-connecting-ip", req.socket.remoteAddress ?? "127.0.0.1");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks);
    const request = new Request(url, { method: req.method, headers, body });
    const response = patterns.some((rx) => rx.test(url.pathname)) ? await worker.fetch(request, env, ctx) : await ASSETS.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    console.log(response.status, req.method, url.pathname);
  } catch (err) {
    console.error(err);
    res.writeHead(500).end("dev server error\n");
  }
}).listen(port, "127.0.0.1", () => console.log(`lightbound.uk preview on http://127.0.0.1:${port}/${offline ? " (offline fixtures)" : ""}  ·  sign in: /app/`));
