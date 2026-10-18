// Local preview of lightbound.uk with the real Worker code: node website/dev.mjs [--port 8788] [--offline]
// Emulates what Cloudflare provides: static assets from public/ (with _headers, trailing-slash
// handling, 404 page and byte ranges for the film), run_worker_first routing from wrangler.jsonc,
// in-memory KV (LIVE and DATA), the 15-minute cron, and Cloudflare Access for /app/*: a local key
// pair signs the same kind of JWT Access sends, so the Worker's real verification code runs.
// --offline uses the recorded feed data instead of the live feeds. Demo accounts use example.test.
import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./worker/index.js";
import { refreshFeeds } from "./worker/feeds.js";
import { putAccount, saveApplication } from "./worker/data.js";
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
    const redirect = (to) => new Response(null, { status: 307, headers: { location: to } });
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
};
const admin = String(env.ADMIN_EMAILS).split(",")[0].trim();
const ctx = { waitUntil: (p) => Promise.resolve(p).catch((e) => console.error(e)), passThroughOnException() {} };
const fetchImpl = offline ? fixtureFetch : fetch;
const refresh = async () => console.log(new Date().toISOString(), "refresh", JSON.stringify(await refreshFeeds(env, { fetchImpl })));

// Demo data so the workspace and admin pages have something to show (dev only).
await putAccount(env, { email: "pilot@example.test", name: "Pilot team", org: "Example Orbital", tier: "tactical_fleet", pilot: "Data received" }, "dev-seed");
await saveApplication(env, { kind: "constellation", name: "Ada Example", email: "ada@example.test", role: "Satellite operations engineer", link: "https://example.test/ada", message: "I run ground passes for a small LEO fleet and track debris conjunctions in my spare time.", consent: true });
await saveApplication(env, { kind: "gauss", name: "Ops Example", email: "ops@example.test", org: "Example Space Ltd", role: "Head of mission operations", plan: "pilot", message: "We fly ONNX models on two smallsats and want to know which outputs to trust after the May storm.", consent: true });

await refresh();
setInterval(refresh, 15 * 60_000).unref();

const cookie = (req, name) => (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === name)?.[1];
const devLogin = (redirect) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in (local) · Lightbound</title><link rel="stylesheet" href="/assets/site.css">
<main class="vault wrap"><div class="narrow"><p class="k">LOCAL_PREVIEW · CLOUDFLARE_ACCESS</p><h1>Sign in</h1>
<p class="muted">On lightbound.uk, Cloudflare Access shows its own sign-in page and emails a one-time code. Locally, pick who to be:</p>
<p class="actions"><a class="btn" href="/__dev/login?as=${encodeURIComponent(admin)}&amp;redirect=${encodeURIComponent(redirect)}">Admin (${admin})</a>
<a class="btn ghost" href="/__dev/login?as=pilot%40example.test&amp;redirect=${encodeURIComponent(redirect)}">Pilot customer</a>
<a class="btn ghost" href="/__dev/login?as=visitor%40example.test&amp;redirect=${encodeURIComponent(redirect)}">Signed in, no plan</a></p></div></main>`;

createServer(async (req, res) => {
  try {
    const url = new URL(`http://${req.headers.host ?? `127.0.0.1:${port}`}${req.url}`);
    const send = (status, headers, body = "") => {
      res.writeHead(status, headers);
      res.end(body);
    };
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
