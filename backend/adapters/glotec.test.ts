import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fetchGlotec, freshIonosphere, getGlotecStatus, GLOTEC_MAX_AGE_MS, parseIndex, pickBaseline, resetGlotecForTests, summarizeGlotec, withRate } from "./glotec.js";
import { fetchSwpcResponse } from "./swpc-fetch.js";

// Recorded 18 Nov 2026 from services.swpc.noaa.gov/products/glotec (25 cells near Malaysia + 2 far cells).
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/glotec-20261118T013500Z-sample.geojson", import.meta.url), "utf8")) as {
  features: Array<{ geometry: { coordinates: number[] }; properties: Record<string, number> }>;
  time_tag: string;
};
const INDEX_TAIL = readFileSync(new URL("./fixtures/glotec-index-tail.txt", import.meta.url), "utf8");
const OBSERVED = Date.parse("2026-11-18T01:35:00Z");
const NOW = OBSERVED + 27 * 60_000; // the step is listed ~26 min after its valid time

/** A copy of the fixture with `edit` applied to each feature. */
function variant(edit: (f: (typeof FIXTURE.features)[number]) => void, timeTag = FIXTURE.time_tag) {
  const copy = structuredClone(FIXTURE);
  copy.features.forEach(edit);
  copy.time_tag = timeTag;
  return { type: "FeatureCollection", ...copy };
}
const doc = (timeTag = FIXTURE.time_tag) => variant(() => {}, timeTag);

test("GloTEC: the Malaysian box summary matches the recorded cells, with source and model time", () => {
  const s = summarizeGlotec(doc(), NOW)!;
  const cells = FIXTURE.features.filter((f) => {
    const [lon, lat] = f.geometry.coordinates;
    return lat >= 2 && lat <= 7 && lon >= 100 && lon <= 119;
  });
  assert.equal(s.source, "glotec-swpc");
  assert.equal(s.observedAt, "2026-11-18T01:35:00.000Z");
  assert.equal(s.cells, 8, "lat 3.75 and 6.25 x lon 102.5, 107.5, 112.5, 117.5");
  assert.equal(s.cells, cells.length);
  assert.equal(s.constrainedCells, cells.filter((c) => c.properties.quality_flag >= 1).length);
  assert.ok(Math.abs(s.meanTecu - cells.reduce((a, c) => a + c.properties.tec, 0) / cells.length) < 1e-9);
  assert.equal(s.minTecu, Math.min(...cells.map((c) => c.properties.tec)));
  assert.equal(s.maxTecu, Math.max(...cells.map((c) => c.properties.tec)));
  assert.deepEqual([s.nearestKl.lat, s.nearestKl.lon], [3.75, 102.5], "the cell nearest Kuala Lumpur (3.14 N, 101.69 E)");
  assert.deepEqual(s.region, { latMin: 2, latMax: 7, lonMin: 100, lonMax: 119 });
  assert.ok(s.meanTecu > 35 && s.meanTecu < 50, `equatorial anomaly TEC is tens of TECU (got ${s.meanTecu})`);
});

test("GloTEC: out-of-range, non-numeric and off-globe cells are skipped, never read as 0", () => {
  const bad = (tec: unknown) => variant((f) => {
    if (f.geometry.coordinates[0] === 102.5 && f.geometry.coordinates[1] === 3.75) f.properties.tec = tec as number;
  });
  for (const tec of [-1, 300.5, Number.NaN, null, "43", Infinity]) {
    const s = summarizeGlotec(bad(tec), NOW)!;
    assert.equal(s.cells, 7, `tec ${String(tec)} is dropped`);
    assert.notEqual(s.nearestKl.lat, 3.75, "the invalid nearest cell is not used");
  }
  const off = variant((f) => { f.geometry.coordinates = [f.geometry.coordinates[0], 95]; });
  assert.equal(summarizeGlotec(off, NOW), null, "latitude 95 is not on the globe");
});

test("GloTEC: malformed documents, a missing or future time tag, a mismatched tag and an empty box are unknown", () => {
  assert.equal(summarizeGlotec(null, NOW), null);
  assert.equal(summarizeGlotec("x", NOW), null);
  assert.equal(summarizeGlotec({ type: "FeatureCollection", features: "no", time_tag: FIXTURE.time_tag }, NOW), null);
  assert.equal(summarizeGlotec({ ...doc(), time_tag: undefined }, NOW), null);
  assert.equal(summarizeGlotec(doc("2026-11-18T05:00:00Z"), NOW), null, "a model time hours in the future");
  assert.equal(summarizeGlotec(doc(), NOW, "2026-11-18T01:25:00Z"), null, "tag differs from the index entry");
  const farOnly = { ...doc(), features: FIXTURE.features.filter((f) => f.geometry.coordinates[1] > 40 || f.geometry.coordinates[1] < -80) };
  assert.equal(summarizeGlotec(farOnly, NOW), null, "no cell in the box");
});

test("GloTEC: quality_flag 0 cells are counted as not observation-constrained", () => {
  const allZero = variant((f) => { f.properties.quality_flag = 0; });
  assert.equal(summarizeGlotec(allZero, NOW)!.constrainedCells, 0);
  const junk = variant((f) => { f.properties.quality_flag = 9; });
  assert.equal(summarizeGlotec(junk, NOW)!.constrainedCells, 0, "an out-of-range flag claims no observations");
});

test("GloTEC: the index parses from a byte-range tail and from a full array; bad entries are dropped", () => {
  const tail = parseIndex(INDEX_TAIL);
  assert.ok(tail.length >= 6);
  assert.equal(tail[tail.length - 1].timeTag, "2026-11-18T01:35:00Z");
  assert.ok(tail.every((e, i) => i === 0 || Date.parse(e.timeTag) > Date.parse(tail[i - 1].timeTag)), "oldest first");
  const full = parseIndex(JSON.stringify([
    { url: "/products/glotec/geojson_2d_urt/glotec_icao_20261118T013500Z.geojson", time_tag: "2026-11-18T01:35:00Z" },
    { url: "https://evil.example/x.geojson", time_tag: "2026-11-18T01:45:00Z" },
    { url: "/products/glotec/geojson_2d_urt/glotec_icao_20261118T012500Z.geojson", time_tag: "not a date" },
    { url: "/products/glotec/../../secret.geojson", time_tag: "2026-11-18T01:55:00Z" },
  ]));
  assert.equal(full.length, 1, "only SWPC glotec paths with a valid time tag");
  assert.deepEqual(parseIndex("<html>503</html>"), []);
});

test("GloTEC: rate of change is TECU per hour against a 20-90 min older step, else unknown", () => {
  const now = summarizeGlotec(doc(), NOW)!;
  const older = (minutes: number, delta: number) => ({ ...now, observedAt: new Date(OBSERVED - minutes * 60_000).toISOString(), meanTecu: now.meanTecu - delta });
  assert.equal(pickBaseline(now, [older(10, 1)]), null, "10 min is too short");
  assert.equal(pickBaseline(now, [older(120, 1)]), null, "120 min is too long");
  assert.equal(pickBaseline(now, [{ ...older(30, 1), cells: 7 }]), null, "a different cell set is not comparable");
  const base = pickBaseline(now, [older(60, 5), older(30, 1), older(20, 0.5)])!;
  assert.equal(base.observedAt, "2026-11-18T01:05:00.000Z", "the step closest to 30 min back");
  const r = withRate(now, base);
  assert.ok(Math.abs(r.rateTecuPerHour! - 2) < 1e-9, "+1 TECU in 30 min = +2 TECU/h");
  assert.equal(r.rateBaselineAt, base.observedAt);
  assert.equal(withRate(now, null).rateTecuPerHour, null);
});

test("GloTEC: a reading older than the freshness bound, or from the future, is unknown (null)", () => {
  const reading = withRate(summarizeGlotec(doc(), NOW)!, null);
  assert.equal(GLOTEC_MAX_AGE_MS, 60 * 60_000);
  assert.equal(freshIonosphere(reading, OBSERVED + 59 * 60_000), reading);
  assert.equal(freshIonosphere(reading, OBSERVED + 61 * 60_000), null, "61 min old");
  assert.equal(freshIonosphere(reading, OBSERVED - 3 * 3_600_000), null, "model time in the future");
  assert.equal(freshIonosphere(null, NOW), null);
});

test("GloTEC: only SWPC hosts are fetched; a feed on another host is refused before any request", async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
  try {
    await assert.rejects(fetchSwpcResponse("https://evil.example/products/glotec/x.geojson", { signal: AbortSignal.timeout(1000) }), /Refused/);
    await assert.rejects(fetchSwpcResponse("https://services.swpc.noaa.gov/x?token=1", { signal: AbortSignal.timeout(1000) }), /Refused/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/** A fetch that serves the recorded index tail and the same recorded cells for any step, stamped with that step's time. */
function serve(opts: { failFile?: boolean; log?: string[] } = {}) {
  return (async (input: URL | string, init?: RequestInit) => {
    const url = String(input);
    opts.log?.push(url.replace("https://services.swpc.noaa.gov", ""));
    if (url.endsWith("geojson_2d_urt.json")) {
      assert.match(String((init?.headers as Record<string, string>)?.Range), /^bytes=-\d+$/, "index is read as a byte-range tail");
      return new Response(INDEX_TAIL, { status: 206 });
    }
    if (opts.failFile) return new Response("nope", { status: 503 });
    const m = /glotec_icao_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(url)!;
    const tag = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
    // Older steps are 1 TECU lower per 30 min, so the rate is +2 TECU/h.
    const shift = -((OBSERVED - Date.parse(tag)) / (30 * 60_000));
    return new Response(JSON.stringify(variant((f) => { f.properties.tec += shift; }, tag)));
  }) as typeof fetch;
}

test("GloTEC fetch: newest step, cold-start baseline gives the rate, an unchanged step is not downloaded again", async () => {
  resetGlotecForTests();
  const realFetch = globalThis.fetch;
  const log: string[] = [];
  globalThis.fetch = serve({ log });
  try {
    const first = await fetchGlotec(NOW);
    assert.ok(first);
    assert.equal(first.observedAt, "2026-11-18T01:35:00.000Z");
    assert.equal(first.source, "glotec-swpc");
    assert.ok(Math.abs(first.rateTecuPerHour! - 2) < 1e-6, `rate ${first.rateTecuPerHour}`);
    assert.equal(first.rateBaselineAt, "2026-11-18T01:05:00.000Z");
    assert.equal(log.filter((u) => u.endsWith(".geojson")).length, 2, "newest + one baseline");
    assert.equal(getGlotecStatus().healthy, true);
    assert.equal(getGlotecStatus().lastSeen, first.observedAt);

    const again = await fetchGlotec(NOW + 5 * 60_000);
    assert.equal(again, first);
    assert.equal(log.filter((u) => u.endsWith(".geojson")).length, 2, "no new download for the same step");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("GloTEC fetch: an outage returns null, keeps lastSeen, and the status ages instead of staying healthy", async () => {
  resetGlotecForTests();
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = serve();
    assert.ok(await fetchGlotec(NOW));
    globalThis.fetch = serve({ failFile: true });
    const later = OBSERVED + 3 * 3_600_000;
    // The step is unchanged so no file is requested; an index outage is what fails here.
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    assert.equal(await fetchGlotec(later), null);
    const status = getGlotecStatus();
    assert.equal(status.healthy, false);
    assert.equal(status.lastSeen, "2026-11-18T01:35:00.000Z");
    assert.equal(status.latencySeconds, 3 * 3600);
    assert.match(status.message, /503/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("GloTEC fetch: a malformed file or a file whose time tag disagrees with the index is rejected", async () => {
  resetGlotecForTests();
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: URL | string) =>
      String(input).endsWith("geojson_2d_urt.json") ? new Response(INDEX_TAIL, { status: 206 }) : new Response("{not json")) as typeof fetch;
    assert.equal(await fetchGlotec(NOW), null);
    assert.match(getGlotecStatus().message, /not valid JSON/);
    globalThis.fetch = (async (input: URL | string) =>
      String(input).endsWith("geojson_2d_urt.json") ? new Response(INDEX_TAIL, { status: 206 }) : new Response(JSON.stringify(doc("2026-11-17T00:00:00Z")))) as typeof fetch;
    assert.equal(await fetchGlotec(NOW), null);
    assert.match(getGlotecStatus().message, /failed validation/);
    globalThis.fetch = (async () => new Response("x".repeat(10), { headers: { "content-length": String(9 * 1024 * 1024) } })) as typeof fetch;
    assert.equal(await fetchGlotec(NOW), null);
    assert.match(getGlotecStatus().message, /larger than 8 MB/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
