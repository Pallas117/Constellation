// A fetch() stand-in that answers the upstream URLs: five responses recorded on 17 Oct 2026, a synthetic
// Luma calendar (luma-constellation.ics: example events only, no real names or places) and synthetic
// opportunity feeds (opportunities.mjs).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES } from "../../worker/feeds.js";
import { PROGRAMMES_URL, newsJson, programmesCsv, ukriXml, uksaAtom } from "./opportunities.mjs";

const dir = dirname(fileURLToPath(import.meta.url));
const FILES = { launches: "ll-upcoming.json", scales: "swpc-scales.json", kp: "swpc-kp.json", wind: "swpc-wind.json", mag: "swpc-mag.json", events: "luma-constellation.ics" };
export const RECORDED_AT = Date.parse("2026-10-17T13:00:00Z");

export const fixture = (name) => (name === "events" ? readFileSync(join(dir, FILES[name]), "utf8") : JSON.parse(readFileSync(join(dir, FILES[name]), "utf8")));

// Moves the example events by the same amount as the launches.
const shiftEvents = (ics, to) => ics.replace(/^(DT(?:START|END|STAMP)):(\d{8}T\d{6}Z)$/gm, (m, k, v) => {
  const t = Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8), +v.slice(9, 11), +v.slice(11, 13), +v.slice(13, 15)) + (to - RECORDED_AT);
  return `${k}:${new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`;
});

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
    const name = String(url) === PROGRAMMES_URL ? "programmes" : Object.keys(SOURCES).find((k) => SOURCES[k] === String(url));
    calls.push(name ?? String(url));
    if (!name) return new Response("unexpected URL", { status: 599 });
    if (failures[name]) return new Response("upstream error", { status: failures[name] });
    const now = shiftTo ?? RECORDED_AT;
    const made = { news: () => JSON.stringify(newsJson(now)), ukri: () => ukriXml(now), uksa: () => uksaAtom(now), programmes: () => programmesCsv(now) }[name];
    if (made) return new Response(made());
    if (name === "events") return new Response(shiftTo ? shiftEvents(fixture(name), shiftTo) : fixture(name), { headers: { "content-type": "text/calendar; charset=utf-8" } });
    let body = fixture(name);
    if (name === "launches" && shiftTo) body = shiftLaunches(body, shiftTo);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  };
  f.calls = calls;
  return f;
}

export const fixtureFetch = makeFetch({}, { shiftTo: Date.now() });
