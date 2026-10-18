// Live feeds for lightbound.uk: upcoming launches (The Space Devs Launch Library 2) and space weather
// (NOAA SWPC). A cron trigger refreshes them into KV every 15 minutes. Pages and the API only ever read
// KV, so visitor traffic never reaches the upstream services (LL2 allows 15 anonymous calls an hour).
// A failed refresh keeps the last good data and records the error; /api/health reports both.

export const SOURCES = Object.freeze({
  launches: "https://ll.thespacedevs.com/2.3.0/launches/upcoming/?limit=12&mode=normal&hide_recent_previous=true",
  scales: "https://services.swpc.noaa.gov/products/noaa-scales.json",
  kp: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
  wind: "https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json",
  mag: "https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json",
});

// refreshMin: how often to call upstream. staleMin: when the page starts saying "stale".
export const FEEDS = Object.freeze({
  launches: { key: "feed:launches", refreshMin: 30, staleMin: 120 },
  weather: { key: "feed:weather", refreshMin: 15, staleMin: 45 },
});

const UA = "lightbound.uk-site/1 (+https://lightbound.uk)";
const MIN = 60_000;

const clean = (v, max = 140) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const num = (v) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
// NOAA time tags often have no offset; they are UTC. Without the Z, Date.parse would use local time.
const utc = (v) => {
  if (typeof v !== "string" || !v) return null;
  const s = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(v) ? v : `${v}Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const iso = (ms) => new Date(ms).toISOString();

export function normaliseLaunches(json) {
  if (!Array.isArray(json?.results)) throw new Error("LL2: no results array");
  const items = json.results
    .map((r) => ({
      id: clean(r?.id, 64),
      name: clean(r?.name),
      vehicle: clean(r?.rocket?.configuration?.full_name || r?.rocket?.configuration?.name, 80),
      mission: clean(r?.mission?.name),
      orbit: clean(r?.mission?.orbit?.abbrev, 16),
      provider: clean(r?.launch_service_provider?.name, 80),
      location: clean(r?.pad?.location?.name, 100),
      net: utc(r?.net),
      precision: clean(r?.net_precision?.abbrev, 8) || "DAY", // unknown precision: show the date only
      windowEnd: utc(r?.window_end),
      status: clean(r?.status?.abbrev, 16),
      statusName: clean(r?.status?.name, 40),
    }))
    .filter((l) => l.id && l.net && (l.name || l.vehicle));
  if (!items.length) throw new Error("LL2: no usable launches");
  return items;
}

export function normaliseWeather({ scales, kp, wind, mag }) {
  const now = scales?.["0"];
  if (!now?.G || !now?.S || !now?.R) throw new Error("NOAA scales: no current entry");
  const level = (o) => {
    const n = Number.parseInt(o?.Scale, 10);
    return Number.isInteger(n) && n >= 0 && n <= 5 ? n : null;
  };
  const scale = (o) => ({ level: level(o), text: clean(o?.Text, 20) || null });
  const out = { at: utc(`${now.DateStamp}T${now.TimeStamp}`), G: scale(now.G), S: scale(now.S), R: scale(now.R), kp: null, wind: null };
  const last = Array.isArray(kp) ? kp.at(-1) : null;
  const kpValue = num(Array.isArray(last) ? last[1] : last?.Kp);
  const kpAt = utc(Array.isArray(last) ? last[0] : last?.time_tag);
  if (kpValue !== null && kpValue >= 0 && kpValue <= 9 && kpAt) out.kp = { value: kpValue, at: kpAt };
  const w = Array.isArray(wind) ? wind[0] : null;
  const m = Array.isArray(mag) ? mag[0] : null;
  const speed = num(w?.proton_speed);
  const bz = num(m?.bz_gsm);
  if (speed !== null || bz !== null) out.wind = { speed, bz, bt: num(m?.bt), at: utc(w?.time_tag ?? m?.time_tag) };
  return out;
}

async function fetchJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": UA }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.json();
}

const LOADERS = {
  launches: async (f) => normaliseLaunches(await fetchJson(SOURCES.launches, f)),
  weather: async (f) => {
    // The storm scales are required; Kp and solar wind are extras that may be missing.
    const [scales, kp, wind, mag] = await Promise.allSettled(["scales", "kp", "wind", "mag"].map((k) => fetchJson(SOURCES[k], f)));
    if (scales.status === "rejected") throw scales.reason;
    const v = (r) => (r.status === "fulfilled" ? r.value : null);
    return normaliseWeather({ scales: scales.value, kp: v(kp), wind: v(wind), mag: v(mag) });
  },
};

export async function readFeed(env, name) {
  try {
    return (await env.LIVE.get(FEEDS[name].key, { type: "json" })) ?? null;
  } catch {
    return null;
  }
}

function isDue(rec, feed, now) {
  if (!rec?.fetchedAt || rec.error) return true;
  return now - Date.parse(rec.fetchedAt) >= (feed.refreshMin - 2) * MIN; // cron jitter
}

const errorText = (err) => clean(err?.name === "TimeoutError" ? "upstream timed out" : String(err?.message ?? err), 200);

/** Called by the cron trigger. Returns what happened to each feed, for the log. */
export async function refreshFeeds(env, { fetchImpl = fetch, now = Date.now(), force = false } = {}) {
  const results = {};
  for (const [name, feed] of Object.entries(FEEDS)) {
    const prev = await readFeed(env, name);
    if (!force && !isDue(prev, feed, now)) {
      results[name] = "fresh";
      continue;
    }
    try {
      const data = await LOADERS[name](fetchImpl);
      await env.LIVE.put(feed.key, JSON.stringify({ data, fetchedAt: iso(now), attemptAt: iso(now), error: null }));
      results[name] = "updated";
    } catch (err) {
      const error = errorText(err);
      await env.LIVE.put(feed.key, JSON.stringify({ data: prev?.data ?? null, fetchedAt: prev?.fetchedAt ?? null, attemptAt: iso(now), error }));
      results[name] = `failed: ${error}`;
    }
  }
  return results;
}

/** live = fresh data; stale = older than staleMin (still shown, labelled); offline = nothing to show. */
export function feedState(name, rec, now = Date.now()) {
  const fetched = rec?.fetchedAt ? Date.parse(rec.fetchedAt) : NaN;
  const ageMin = Number.isFinite(fetched) ? Math.round((now - fetched) / MIN) : null;
  const state = !rec?.data ? "offline" : ageMin > FEEDS[name].staleMin ? "stale" : "live";
  return { state, ageMin, fetchedAt: rec?.fetchedAt ?? null, attemptAt: rec?.attemptAt ?? null, error: rec?.error ?? null };
}
