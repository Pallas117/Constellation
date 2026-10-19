// lightbound.uk edge Worker. Static files are served by Cloudflare straight from public/ (free, no
// Worker run). The Worker runs only for the routes in wrangler.jsonc "run_worker_first":
//   /                       landing: the Gauss door shows space weather now, Constellation the next launch
//   /gauss/                 plans (from tiers.js) and the Constellation door's next launch
//   /constellation/         launch schedule, space weather, and the Gauss door's readout
//   /gauss/apply/, /constellation/apply/   application forms (plan preselected, "received" state)
//   /constellation/time/    public time-zone planner for group calls (no data stored)
//   /app/*                  signed-in workspace and admin (Cloudflare Access in front; see app.js)
//   /api/*                  launches.json, launches.ics, space-weather.json, health, POST apply,
//                           POST stripe/webhook (signed by Stripe; unlocks paid plans)
// and on the cron trigger, which refreshes the feeds into KV. Nothing here needs a secret.
import { FEEDS, feedState, readFeed, refreshFeeds } from "./feeds.js";
import { renderConstellationDoor, renderEventIcs, renderGaussDoor, renderIcs, renderLaunches, renderPlans, renderWeather } from "./render.js";
import { plannerParams, renderPlanner } from "./timezones.js";
import { handleApply, renderApplyForm, renderSent } from "./forms.js";
import { handleApp } from "./app.js";
import { handleWebhook } from "./stripe.js";
import { withSecurity } from "./headers.js";

const applyPage = (kind) => () => ({
  apply: (f, t, url) => (url.searchParams.get("sent") === "1" ? renderSent(kind) : renderApplyForm(kind, { plan: url.searchParams.get("plan") ?? "" })),
});
const LIVE_PAGES = {
  "/": () => ({ "gauss-door": (f, t) => renderGaussDoor(f.weather, t), "constellation-door": (f, t) => renderConstellationDoor(f.launches, t) }),
  "/gauss/": () => ({ plans: () => renderPlans(), "constellation-door": (f, t) => renderConstellationDoor(f.launches, t) }),
  "/constellation/": () => ({
    launches: (f, t) => renderLaunches(f.launches, t),
    weather: (f, t) => renderWeather(f.weather, t),
    "gauss-door": (f, t) => renderGaussDoor(f.weather, t),
  }),
  "/constellation/time/": () => ({ planner: (f, t, url) => renderPlanner(plannerParams(url, t)) }),
  "/gauss/apply/": applyPage("gauss"),
  "/constellation/apply/": applyPage("constellation"),
};
const NEEDS_FEEDS = new Set(["/", "/gauss/", "/constellation/"]);
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

/** Fetch a static page and fill its live sections. */
function pageFiller(request, env) {
  return async (path, renders, status = 200, extra = { "cache-control": "public, max-age=60" }) => {
    const asset = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: "GET" }));
    if (!asset.ok || !(asset.headers.get("content-type") ?? "").includes("text/html")) return asset;
    let html = await asset.text();
    for (const [name, render] of Object.entries(renders)) html = fill(html, name, render);
    return respond(request.method === "HEAD" ? null : html, status, "text/html; charset=utf-8", extra);
  };
}

async function api(request, url, env, ctx) {
  if (url.pathname === "/api/stripe/webhook") {
    if (request.method !== "POST") return respond("Method not allowed\n", 405, "text/plain; charset=utf-8", { allow: "POST" });
    return handleWebhook(request, env, respond);
  }
  if (url.pathname === "/api/apply") {
    if (request.method !== "POST") return respond("Method not allowed\n", 405, "text/plain; charset=utf-8", { allow: "POST" });
    return handleApply(request, env, respond, pageFiller(request, env));
  }
  if (request.method === "POST") return respond("Method not allowed\n", 405, "text/plain; charset=utf-8", { allow: "GET, HEAD" });
  const feeds = await readAll(env, ctx);
  const now = Date.now();
  const envelope = (name) => ({ ...feedState(name, feeds[name], now), attribution: ATTRIBUTION[name] });
  switch (url.pathname) {
    case "/api/launches":
      return json({ ...envelope("launches"), items: feeds.launches?.data ?? [] });
    case "/api/call.ics": {
      // A picked time from the public planner. Fixed title; the only input is the start time.
      const start = Date.parse(url.searchParams.get("start") ?? "");
      if (!Number.isFinite(start) || Math.abs(start - now) > 400 * 86_400_000) return json({ error: "start must be an ISO time within 400 days" }, 400, "no-store");
      return respond(renderEventIcs({ uid: `slot-${start}`, start: new Date(start).toISOString(), minutes: 60, summary: "Constellation group call",
        description: "Time picked with the Constellation time-zone planner: https://lightbound.uk/constellation/time/" }, now), 200, "text/calendar; charset=utf-8",
        { "cache-control": "public, max-age=86400", "content-disposition": 'attachment; filename="constellation-call.ics"' });
    }
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

const ALLOWED = new Set(["GET", "HEAD", "POST"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (pathname.startsWith("/api/")) {
      if (!ALLOWED.has(request.method)) return respond("Method not allowed\n", 405, "text/plain; charset=utf-8", { allow: "GET, HEAD, POST" });
      return api(request, url, env, ctx);
    }
    if (pathname === "/app" || pathname.startsWith("/app/")) {
      if (!ALLOWED.has(request.method)) return respond("Method not allowed\n", 405, "text/plain; charset=utf-8", { allow: "GET, HEAD, POST" });
      if (pathname === "/app") return new Response(null, { status: 307, headers: { location: "/app/" } });
      return handleApp(request, env, url, { respond, fillPage: pageFiller(request, env), fetchImpl: fetch });
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return respond("Method not allowed\n", 405, "text/plain; charset=utf-8", { allow: "GET, HEAD" });
    if (Object.hasOwn(LIVE_PAGES, pathname)) {
      const feeds = NEEDS_FEEDS.has(pathname) ? await readAll(env, ctx) : {};
      const now = Date.now();
      const renders = Object.fromEntries(Object.entries(LIVE_PAGES[pathname]()).map(([k, r]) => [k, () => r(feeds, now, url)]));
      const extra = pathname.endsWith("/apply/") ? { "cache-control": "no-store" } : undefined;
      return pageFiller(request, env)(pathname, renders, 200, extra);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refreshFeeds(env).then((r) => console.log(`refresh ${JSON.stringify(r)}`)));
  },
};
