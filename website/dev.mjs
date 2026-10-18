// Local preview of lightbound.uk with the real Worker code: node website/dev.mjs [--port 8788] [--offline]
// Emulates what Cloudflare provides: static assets from public/ (with _headers, trailing-slash
// handling, 404 page and byte ranges for the film), run_worker_first routing from wrangler.jsonc,
// an in-memory KV, and the 15-minute cron. --offline uses the test fixtures instead of the live feeds.
import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./worker/index.js";
import { refreshFeeds } from "./worker/feeds.js";
import { fixtureFetch } from "./test/fixtures/fetch.mjs";

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

const store = new Map();
const LIVE = {
  async get(key, opts) {
    const v = store.get(key);
    return v === undefined ? null : (opts?.type ?? opts) === "json" ? JSON.parse(v) : v;
  },
  async put(key, value) {
    store.set(key, String(value));
  },
};
const env = { ASSETS, LIVE };
const ctx = { waitUntil: (p) => Promise.resolve(p).catch((e) => console.error(e)), passThroughOnException() {} };
const fetchImpl = offline ? fixtureFetch : fetch;
const refresh = async () => console.log(new Date().toISOString(), "refresh", JSON.stringify(await refreshFeeds(env, { fetchImpl })));

await refresh();
setInterval(refresh, 15 * 60_000).unref();

createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host ?? `127.0.0.1:${port}`}${req.url}`;
    const request = new Request(url, { method: req.method, headers: req.headers });
    const { pathname } = new URL(url);
    const response = patterns.some((rx) => rx.test(pathname)) ? await worker.fetch(request, env, ctx) : await ASSETS.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    console.log(response.status, req.method, req.url);
  } catch (err) {
    console.error(err);
    res.writeHead(500).end("dev server error\n");
  }
}).listen(port, "127.0.0.1", () => console.log(`lightbound.uk preview on http://127.0.0.1:${port}/${offline ? " (offline fixtures)" : ""}`));
