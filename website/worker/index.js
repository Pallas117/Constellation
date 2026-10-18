// lightbound.uk edge Worker. Static files are served by Cloudflare straight from public/ (free, no
// Worker run). The Worker runs only for the routes in wrangler.jsonc "run_worker_first":
//   /                 landing page: the Gauss door shows space weather now, Constellation the next launch
//   /gauss/           the "keep going" Constellation door shows the next launch
//   /constellation/   launch schedule, space weather, and the Gauss door's readout
//   /api/*            launches.json, launches.ics, space-weather.json, health
// and on the cron trigger, which refreshes the feeds into KV. Nothing here needs a secret.
import { FEEDS, feedState, readFeed, refreshFeeds } from "./feeds.js";
import { renderConstellationDoor, renderGaussDoor, renderIcs, renderLaunches, renderWeather } from "./render.js";
import { withSecurity } from "./headers.js";

const LIVE_PAGES = {
  "/": { "gauss-door": (f, t) => renderGaussDoor(f.weather, t), "constellation-door": (f, t) => renderConstellationDoor(f.launches, t) },
  "/gauss/": { "constellation-door": (f, t) => renderConstellationDoor(f.launches, t) },
  "/constellation/": {
    launches: (f, t) => renderLaunches(f.launches, t),
    weather: (f, t) => renderWeather(f.weather, t),
    "gauss-door": (f, t) => renderGaussDoor(f.weather, t),
  },
};
const ATTRIBUTION = {
  launches: "Data: The Space Devs Launch Library 2 (thespacedevs.com)",
  weather: "Data: NOAA Space Weather Prediction Center (swpc.noaa.gov)",
};

let bootstrapping = false;

async function readAll(env, ctx) {
  const [launches, weather] = await Promise.all([readFeed(env, "launches"), readFeed(env, "weather")]);
  // First request after a fresh deploy, before the cron has run: fetch once in the background.
  if ((!launches || !weather) && !bootstrapping) {
    bootstrapping = true;
    ctx.waitUntil(refreshFeeds(env).catch(() => {}));
  }
  return { launches, weather };
}

const respond = (body, status, type, extra = {}) =>
  new Response(body, { status, headers: withSecurity({ "content-type": type, ...extra }) });
const json = (obj, status = 200, cache = "public, max-age=300") =>
  respond(JSON.stringify(obj, null, 2), status, "application/json; charset=utf-8", { "cache-control": cache });

function fill(html, name, render) {
  const rx = new RegExp(`<!--live:${name}-->[\\s\\S]*?<!--/live:${name}-->`);
  return html.replace(rx, () => `<!--live:${name}-->${render()}<!--/live:${name}-->`);
}

async function livePage(request, url, env, ctx) {
  const asset = await env.ASSETS.fetch(new Request(url, { method: "GET" }));
  if (!asset.ok || !(asset.headers.get("content-type") ?? "").includes("text/html")) return asset;
  let html = await asset.text();
  const feeds = await readAll(env, ctx);
  const now = Date.now();
  for (const [name, render] of Object.entries(LIVE_PAGES[url.pathname])) html = fill(html, name, () => render(feeds, now));
  return respond(request.method === "HEAD" ? null : html, 200, "text/html; charset=utf-8", { "cache-control": "public, max-age=60" });
}

async function api(pathname, env, ctx) {
  const feeds = await readAll(env, ctx);
  const now = Date.now();
  const envelope = (name) => ({ ...feedState(name, feeds[name], now), attribution: ATTRIBUTION[name] });
  switch (pathname) {
    case "/api/launches":
      return json({ ...envelope("launches"), items: feeds.launches?.data ?? [] });
    case "/api/launches.ics":
      return respond(renderIcs(feeds.launches, now), 200, "text/calendar; charset=utf-8", {
        "cache-control": "public, max-age=900",
        "content-disposition": 'inline; filename="constellation-launches.ics"',
      });
    case "/api/space-weather":
      return json({ ...envelope("weather"), data: feeds.weather?.data ?? null });
    case "/api/health": {
      const status = Object.fromEntries(Object.keys(FEEDS).map((n) => [n, feedState(n, feeds[n], now)]));
      const ok = Object.values(status).every((s) => s.state === "live");
      return json({ ok, feeds: status, checkedAt: new Date(now).toISOString() }, ok ? 200 : 503, "no-store");
    }
    default:
      return json({ error: "not found" }, 404, "no-store");
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD")
      return respond("Method not allowed\n", 405, "text/plain; charset=utf-8", { allow: "GET, HEAD" });
    if (url.pathname.startsWith("/api/")) return api(url.pathname, env, ctx);
    if (url.pathname in LIVE_PAGES) return livePage(request, url, env, ctx);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refreshFeeds(env).then((r) => console.log(`refresh ${JSON.stringify(r)}`)));
  },
};
