import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadArchive } from "./replay.js";
import { DATASETS, fetchArchive, MAX_WINDOW_DAYS, pieceIds, splitWindow, validateSlug, validateWindow, type FetchOptions } from "./fetch-archive.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const T = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z";

/**
 * A recorded-shape iSWA HAPI answer (CSV, parameters in the requested order), synthetic and
 * tiny, generated for whatever time.min/time.max is asked: no network in tests (GAU-59).
 */
function fakeHapi(log: string[] = [], failFirst = 0): typeof fetch {
  let failures = failFirst;
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    log.push(url.searchParams.get("id") ?? "");
    if (failures > 0) {
      failures--;
      return new Response("busy", { status: 429, headers: { "retry-after": "1" } });
    }
    const id = url.searchParams.get("id");
    const [a, b] = [Date.parse(url.searchParams.get("time.min")!), Date.parse(url.searchParams.get("time.max")!)];
    const rows: string[] = ["# HAPI header line", ""];
    const step = id === "NOAA_KP_P3H" ? 3 * 3_600_000 : id === "goesp_part_flux_P5M" ? 300_000 : 60_000;
    for (let t = Math.ceil(a / step) * step; t <= b; t += step) {
      const tag = T(t);
      if (id === "swpc_rtsw_mag_P1M") rows.push(`${tag},1.5,-2.0,-4.5,5.2,1,DSCOVR`, `${tag},9,9,9,9,0,ACE`);
      else if (id === "swpc_rtsw_plasma_P1M") rows.push(`${tag},5.1,420,90000,1,DSCOVR`, `${tag},1,1,1,0,ACE`);
      else if (id === "goesp_part_flux_P5M") rows.push(url.searchParams.get("parameters")!.startsWith("P10") ? `${tag},0.1,0.02,0.01,GOES-19` : `${tag},12,GOES-19`);
      else if (id === "goesp_xray_flux_P1M") rows.push(`${tag},1e-7,2e-6,GOES-19`);
      else if (id === "NOAA_KP_P3H") rows.push(`${tag},3,${tag},${T(t + 3 * 3_600_000)}`);
    }
    return new Response(rows.join("\n"), { status: 200 });
  }) as typeof fetch;
}
const quick = (fetchImpl: typeof fetch): FetchOptions => ({ fetchImpl, sleep: async () => {}, now: () => Date.parse("2026-02-01T00:00:00Z") });

test("custom replay window: bounds are validated (zone required, from before to, not in the future) and the id is an allowlisted slug (GAU-59)", () => {
  const now = Date.parse("2026-02-01T00:00:00Z");
  assert.deepEqual(validateWindow("2026-01-19T00:00:00+08:00", "2026-01-19T12:00:00Z", now), { from: "2026-01-18T16:00:00.000Z", to: "2026-01-19T12:00:00.000Z" });
  assert.throws(() => validateWindow("2026-01-19T00:00:00", "2026-01-20T00:00:00Z", now), /ISO 8601 time with a zone/);
  assert.throws(() => validateWindow("yesterday", "2026-01-20T00:00:00Z", now), /ISO 8601/);
  assert.throws(() => validateWindow("2026-01-20T00:00:00Z", "2026-01-19T00:00:00Z", now), /must end after it starts/);
  assert.throws(() => validateWindow("2026-01-20T00:00:00Z", "2026-01-20T00:00:00Z", now), /must end after it starts/);
  assert.throws(() => validateWindow("2026-01-30T00:00:00Z", "2026-02-02T00:00:00Z", now), /in the future/);
  for (const bad of ["", "../x", "A", "a b", "a/b", "-a", "a".repeat(64)]) assert.throws(() => validateSlug(bad), /invalid archive id/);
  assert.equal(validateSlug("pilot-2026-01"), "pilot-2026-01");
});

test("custom replay window: a period over 31 days is split into contiguous archives that cover it exactly (GAU-59)", () => {
  assert.equal(MAX_WINDOW_DAYS, 31);
  const one = splitWindow("2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
  assert.deepEqual(one, [{ start: "2026-01-01T00:00:00.000Z", end: "2026-02-01T00:00:00.000Z" }], "exactly 31 days is one archive");
  const pieces = splitWindow("2026-01-01T00:00:00.000Z", "2026-03-15T06:00:00.000Z");
  assert.equal(pieces.length, 3);
  assert.equal(pieces[0].start, "2026-01-01T00:00:00.000Z");
  assert.equal(pieces[2].end, "2026-03-15T06:00:00.000Z");
  pieces.forEach((p, i) => {
    assert.ok(Date.parse(p.end) - Date.parse(p.start) <= 31 * 86_400_000);
    if (i > 0) assert.equal(p.start, pieces[i - 1].end, "no gap and no overlap");
  });
  assert.deepEqual(pieceIds("acme", 1), ["acme"]);
  assert.deepEqual(pieceIds("acme", 3), ["acme-p1", "acme-p2", "acme-p3"]);
});

test("custom replay window: the archive has the named-event format and records source, retrieval time and dataset ids (GAU-59)", async () => {
  const log: string[] = [];
  const archive = await fetchArchive({ id: "custom-demo", title: "Customer window", start: "2026-01-19T02:00:00.000Z", end: "2026-01-19T04:00:00.000Z" }, quick(fakeHapi(log)));
  const named = loadArchive(here("events/jan-2026.json.gz"));
  assert.deepEqual(Object.keys(archive), Object.keys(named), "same keys, same order as a named event");
  for (const k of ["mag", "plasma", "protons", "electrons", "xrays", "kp"] as const) {
    assert.deepEqual(archive[k][0].map((v) => typeof v), named[k][0].map((v) => typeof v), `${k} rows have the named-event column types`);
  }
  assert.equal(archive.fetchedAt, "2026-02-01T00:00:00.000Z");
  assert.equal(archive.sources[0].dataset, DATASETS.join(", "));
  assert.match(archive.sources[0].url, /^https:\/\/iswa\.gsfc\.nasa\.gov\//);
  assert.equal(archive.terms, named.terms);
  assert.ok(archive.mag.every((r) => r[5] === "DSCOVR"), "only the primary spacecraft, as the named events");
  assert.equal(archive.mag[0][0], "2026-01-18T20:00:00.000Z", "inputs start 6 h before the window (warm-up)");
  assert.ok(Date.parse(archive.mag.at(-1)![0]) <= Date.parse(archive.end));
  assert.deepEqual(log.slice(0, 6), ["swpc_rtsw_mag_P1M", "swpc_rtsw_plasma_P1M", "goesp_part_flux_P5M", "goesp_part_flux_P5M", "goesp_xray_flux_P1M", "NOAA_KP_P3H"], "one request at a time");
  assert.ok(!JSON.stringify(archive).toLowerCase().includes("kyoto"), "no Kyoto Dst");
});

test("custom replay window: 429 and 5xx back off and retry, a 404 or an empty answer fails with a reason, upstream text is not echoed (GAU-59)", async () => {
  const sleeps: number[] = [];
  const spec = { id: "retry", title: "t", start: "2026-01-19T02:00:00.000Z", end: "2026-01-19T02:30:00.000Z" };
  const archive = await fetchArchive(spec, { ...quick(fakeHapi([], 2)), sleep: async (ms) => void sleeps.push(ms) });
  assert.ok(archive.mag.length > 0);
  assert.deepEqual(sleeps.slice(0, 2), [1000, 1000], "Retry-After is honoured");
  await assert.rejects(fetchArchive(spec, { ...quick(fakeHapi([], 99)), attempts: 3 }), /HTTP 429 after 3 attempts/);
  const notFound = (async () => new Response("secret upstream detail", { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(fetchArchive(spec, quick(notFound)), (e: Error) => /HTTP 404/.test(e.message) && !/secret/.test(e.message));
  const empty = (async () => new Response("# nothing\n", { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(fetchArchive(spec, quick(empty)), /no L1 data returned/);
});
