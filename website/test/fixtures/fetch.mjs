// A fetch() stand-in that answers the five upstream URLs from responses recorded on 17 Oct 2026.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES } from "../../worker/feeds.js";

const dir = dirname(fileURLToPath(import.meta.url));
const FILES = { launches: "ll-upcoming.json", scales: "swpc-scales.json", kp: "swpc-kp.json", wind: "swpc-wind.json", mag: "swpc-mag.json" };
export const RECORDED_AT = Date.parse("2026-10-17T13:00:00Z");

export const fixture = (name) => JSON.parse(readFileSync(join(dir, FILES[name]), "utf8"));

// Moves every launch time by the same amount, so "upcoming" stays upcoming whenever the tests run.
function shiftLaunches(json, to) {
  const d = to - RECORDED_AT;
  const move = (v) => (v ? new Date(Date.parse(v) + d).toISOString() : v);
  for (const r of json.results) Object.assign(r, { net: move(r.net), window_start: move(r.window_start), window_end: move(r.window_end) });
  return json;
}

/**
 * makeFetch({ launches: 429 }) makes that upstream fail with the status;
 * makeFetch({}, { shiftTo: Date.now() }) replays the launches as if recorded now.
 */
export function makeFetch(failures = {}, { shiftTo } = {}) {
  const calls = [];
  const f = async (url) => {
    const name = Object.keys(SOURCES).find((k) => SOURCES[k] === String(url));
    calls.push(name ?? String(url));
    if (!name) return new Response("unexpected URL", { status: 599 });
    if (failures[name]) return new Response("upstream error", { status: failures[name] });
    let body = fixture(name);
    if (name === "launches" && shiftTo) body = shiftLaunches(body, shiftTo);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
}

export const fixtureFetch = makeFetch({}, { shiftTo: Date.now() });
