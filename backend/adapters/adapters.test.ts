import assert from "node:assert/strict";
import test from "node:test";
import { dipoleTiltRad, gseToGsm, gsmToGse, vec } from "../physics/coordinates.js";
import { freshnessTier, IngestionWorker, NOAA_FRESH_MS, NOAA_MAX_AGE_MS } from "../worker/ingest-loop.js";
import { fetchEsaReadout, parseNecRow } from "./esa-hapi.js";
import { getJaxaStatus, probeJaxaCatalog } from "./jaxa-erg.js";
import { fetchMmsCdawebSamples, getMmsCdawebStatus } from "./mms-cdaweb.js";
import { fetchMmsBurstWindows, getMmsLaspStatus } from "./mms-lasp.js";
import { fetchNoaaReadout, pickFreshestPair, resetNoaaCache, swpcTimeToIso } from "./noaa-swpc.js";

type Route = (url: string) => { status: number; body: unknown } | undefined;

async function withFetch<T>(route: Route, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = route(url);
    if (!hit) throw new Error(`unexpected fetch ${url}`);
    const text = typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body);
    return new Response(text, { status: hit.status });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("gsmToGse is the exact inverse of gseToGsm", () => {
  const ts = "2026-06-21T03:30:00Z";
  const v = vec(3.2, -4.1, 7.5);
  const back = gsmToGse(gseToGsm(v, ts), ts);
  close(back.x, v.x);
  close(back.y, v.y);
  close(back.z, v.z);
});

test("gseToGsm rotates about the shared X axis and puts the dipole on +Z", () => {
  const ts = "2026-03-01T09:15:00Z";
  const v = vec(5, -2, 3);
  const gsm = gseToGsm(v, ts);
  close(gsm.x, v.x);
  close(Math.hypot(gsm.y, gsm.z), Math.hypot(v.y, v.z));
});

test("dipole tilt follows season and UT (Hapgood 1992)", () => {
  const deg = (r: number) => (r * 180) / Math.PI;
  const juneMax = deg(dipoleTiltRad("2026-06-21T17:00:00Z"));
  // Pole (~287E) faces the Sun near 17 UT and faces away near 05 UT.
  const decMin = deg(dipoleTiltRad("2026-12-21T05:00:00Z"));
  const juneMorning = deg(dipoleTiltRad("2026-06-21T05:00:00Z"));
  assert.ok(juneMax > 30 && juneMax < 36, `June 17UT tilt ${juneMax}`);
  assert.ok(decMin < -30 && decMin > -36, `Dec 05UT tilt ${decMin}`);
  assert.ok(juneMorning > 10 && juneMorning < 18, `June 05UT tilt ${juneMorning}`);
});

// Shapes follow the live SWPC RTSW feeds (newest first, one record per L1 spacecraft).
function rtswRoute(opts: { activeWind?: boolean } = {}): Route {
  const activeWind = opts.activeWind ?? true;
  return (url) => {
    if (url.includes("rtsw_wind_1m")) {
      return {
        status: 200,
        body: [
          { time_tag: "2026-10-10T04:44:03", active: false, source: "IMAP", proton_speed: 999, proton_density: 99, proton_temperature: 74855, proton_vx_gse: null, proton_vy_gse: null, proton_vz_gse: null },
          { time_tag: "2026-10-10T04:43:00", active: activeWind, source: "SOLAR1", proton_speed: 413.4, proton_density: 7.84, proton_temperature: 123456, proton_vx_gse: -413.4, proton_vy_gse: 18, proton_vz_gse: -15.2 },
          { time_tag: "2026-10-10T04:42:00", active: true, source: "SOLAR1", proton_speed: null, proton_density: null },
        ],
      };
    }
    if (url.includes("rtsw_mag_1m")) {
      return {
        status: 200,
        body: [
          { time_tag: "2026-10-10T04:45:01", active: false, source: "IMAP", bx_gse: 50, by_gse: 50, bz_gse: 50 },
          { time_tag: "2026-10-10T04:44:00", active: true, source: "SOLAR1", bx_gse: -6.7, by_gse: -3.01, bz_gse: -3.91, bx_gsm: -6.7, by_gsm: -1, bz_gsm: -5 },
        ],
      };
    }
    if (url.includes("planetary-k-index")) {
      return { status: 200, body: [{ time_tag: "2026-10-09T21:00:00", Kp: 3 }, { time_tag: "2026-10-10T00:00:00", Kp: 2.33 }] };
    }
    if (url.includes("ovation")) return { status: 200, body: {} };
    return undefined;
  };
}

test("NOAA: RTSW active spacecraft, native GSE, UTC time, no temperature-as-velocity (GAU-48, GAU-51, GAU-56)", async () => {
  const readout = await withFetch(rtswRoute(), fetchNoaaReadout);
  assert.ok(readout);
  assert.equal(readout.spacecraft, "SOLAR1", "inactive IMAP record is not used");
  assert.deepEqual({ ...readout.velocityGse }, { x: -413.4, y: 18, z: -15.2 });
  assert.deepEqual({ ...readout.magneticFieldGse }, { x: -6.7, y: -3.01, z: -3.91 }, "GSE components, not GSM");
  assert.equal(readout.density, 7.84);
  assert.equal(readout.kp, 2.33, "object-form Kp rows are read");
  assert.equal(readout.timestamp, "2026-10-10T04:43:00.000Z", "older of wind/mag, read as UTC");
  assert.equal("dst" in readout, false, "Dst must not be synthesised from Kp");
});

test("NOAA: without an active wind record the newest complete one is used", async () => {
  const readout = await withFetch(rtswRoute({ activeWind: false }), fetchNoaaReadout);
  assert.ok(readout);
  assert.equal(readout.spacecraft, "IMAP");
  assert.deepEqual({ ...readout.velocityGse }, { x: -999, y: 0, z: 0 }, "bulk speed along -X when no GSE vector");
});

test("NOAA: a 304 reuses the cached body so fast polling costs no payload", async () => {
  resetNoaaCache();
  const route = rtswRoute();
  const seen: Array<string | null> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const ifNoneMatch = new Headers(init?.headers).get("if-none-match");
    if (url.includes("rtsw_wind_1m")) seen.push(ifNoneMatch);
    if (ifNoneMatch === `"v1"`) return new Response(null, { status: 304 });
    const hit = route(url)!;
    return new Response(JSON.stringify(hit.body), { status: 200, headers: { etag: `"v1"` } });
  }) as typeof fetch;
  try {
    const first = await fetchNoaaReadout();
    const second = await fetchNoaaReadout();
    assert.ok(first && second);
    assert.deepEqual(seen, [null, `"v1"`], "second poll is conditional");
    assert.equal(second.timestamp, first.timestamp);
    assert.equal(second.density, first.density);
  } finally {
    globalThis.fetch = realFetch;
    resetNoaaCache();
  }
});

test("NOAA: freshest policy picks one spacecraft newest in both wind and mag", () => {
  const wind = [
    { time_tag: "2026-10-15T03:19:00", active: true, source: "SOLAR1", proton_speed: 500, proton_density: 5 },
    { time_tag: "2026-10-15T03:22:00", active: false, source: "ACE", proton_speed: 510, proton_density: 6 },
    { time_tag: "2026-10-15T03:23:00", active: false, source: "IMAP", proton_speed: 520, proton_density: 7 },
  ];
  const mag = [
    { time_tag: "2026-10-15T03:19:00", active: true, source: "SOLAR1", bx_gse: 1, by_gse: 2, bz_gse: 3 },
    { time_tag: "2026-10-15T03:22:00", active: false, source: "ACE", bx_gse: 4, by_gse: 5, bz_gse: 6 },
    { time_tag: "2026-10-15T03:20:00", active: false, source: "IMAP", bx_gse: 7, by_gse: 8, bz_gse: 9 },
  ];
  const pair = pickFreshestPair(wind, mag);
  assert.ok(pair);
  // IMAP wind is newest, but its mag lags; ACE is newest in both.
  assert.equal(pair.wind.rec.source, "ACE");
  assert.equal(pair.mag.rec.source, "ACE");
  assert.equal(pair.wind.time, "2026-10-15T03:22:00.000Z");
  assert.equal(pickFreshestPair(wind, []), null, "no pair without mag");
});

test("NOAA: default policy stays on the SWPC active spacecraft", async () => {
  resetNoaaCache();
  const prev = process.env.NOAA_RTSW_SOURCE;
  delete process.env.NOAA_RTSW_SOURCE;
  try {
    const readout = await withFetch(rtswRoute(), fetchNoaaReadout);
    assert.equal(readout?.spacecraft, "SOLAR1");
    process.env.NOAA_RTSW_SOURCE = "freshest";
    const fresh = await withFetch(rtswRoute(), fetchNoaaReadout);
    assert.equal(fresh?.spacecraft, "IMAP", "freshest takes the newer IMAP pair");
  } finally {
    if (prev === undefined) delete process.env.NOAA_RTSW_SOURCE;
    else process.env.NOAA_RTSW_SOURCE = prev;
  }
});

test("ESA: parses nested and flat HAPI B_NEC rows and rejects malformed ones (GAU-50)", () => {
  assert.deepEqual(parseNecRow(["2026-10-10T12:00:00Z", [21000.5, -1500, 42000]]), {
    timestamp: "2026-10-10T12:00:00Z",
    n: 21000.5,
    e: -1500,
    c: 42000,
  });
  assert.deepEqual(parseNecRow(["2026-10-10T12:00:00Z", 1, 2, 3]), { timestamp: "2026-10-10T12:00:00Z", n: 1, e: 2, c: 3 });
  assert.equal(parseNecRow(["2026-10-10T12:00:00Z", [1, 2]]), null);
  assert.equal(parseNecRow(["2026-10-10T12:00:00Z", [1, null, 3]]), null);
  assert.equal(parseNecRow(["not-a-time", [1, 2, 3]]), null);
  assert.equal(parseNecRow([123, [1, 2, 3]]), null);
});

test("ESA: queries within dataset coverage, survives bare NaN, takes last complete row (GAU-50, GAU-51)", async () => {
  let dataUrl = "";
  const readout = await withFetch((url) => {
    if (url.includes("vires.services/hapi/info")) {
      return { status: 200, body: '{"HAPI": "3.0", "stopDate": "2026-10-09T21:41:19Z", "x": NaN}' };
    }
    if (url.includes("vires.services/hapi/data")) {
      dataUrl = url;
      return {
        status: 200,
        // Live layout for parameters=Latitude,Longitude,Radius,B_NEC (GAU-85).
        body: '{"data":[["2026-10-09T21:33:18.000Z", 51.2, -3.1, 6821000.0, [18085.1, 2155.0, 37300.4]], ["2026-10-09T21:33:19.000Z", 51.26, -3.08, 6821001.5, [18085.1283, 2154.9995, 37300.3859]], ["2026-10-09T21:41:18.000Z", 84.1, 85.7, 6781642.4, [NaN, NaN, NaN]]]}',
      };
    }
    return undefined;
  }, fetchEsaReadout);
  assert.ok(readout);
  assert.equal(readout.timestamp, "2026-10-09T21:33:19.000Z");
  assert.equal(readout.magneticFieldNec.z, 37300.3859);
  assert.equal("magneticFieldGse" in readout, false);
  assert.deepEqual(readout.position, { latitudeDeg: 51.26, longitudeDeg: -3.08, radiusKm: 6821.0015, altitudeKm: 6821.0015 - 6371.2 });
  assert.ok(readout.fieldMagnitudeNt > 40_000, "LEO |B| is the main field, ~10^4 nT, not the ~5 nT IMF");
  const q = new URL(dataUrl).searchParams;
  assert.equal(q.get("parameters"), "Latitude,Longitude,Radius,B_NEC");
  assert.equal(q.get("dataset"), "SW_FAST_MAGA_LR_1B");
  assert.equal(q.get("stop"), "2026-10-09T21:41:19Z", "never asks beyond stopDate (HAPI 1405)");
});

test("ingest: Swarm main-field values never leak into the IMF blend", () => {
  const worker = new IngestionWorker() as unknown as {
    noaa: unknown;
    esa: unknown;
    blendInputs: (ts: string) => { magneticFieldGse: { z: number }; density: number; dst?: number };
  };
  worker.noaa = {
    timestamp: "2026-10-10T12:00:00Z",
    density: 6,
    velocityGse: vec(-450, 0, 0),
    magneticFieldGse: vec(1, 2, -5),
    kp: 3,
    ovation: null,
  };
  worker.esa = { timestamp: "2026-10-10T12:00:00Z", magneticFieldNec: vec(21000, -1500, 42000) };
  const input = worker.blendInputs("2026-10-10T12:00:00Z");
  assert.equal(input.magneticFieldGse.z, -5);
  assert.equal(input.density, 6);
  assert.equal(input.dst, undefined);
});

// Shapes follow the live CDAWeb HAPI: FGM survey @0 (B, 4 components incl. |B|) and
// MEC ephemeris at 30 s cadence.
function mmsRoute(opts: { failing?: Set<string>; empty?: boolean; fill?: boolean } = {}): Route {
  return (url) => {
    if (!url.includes("cdaweb.gsfc.nasa.gov")) return undefined;
    const u = new URL(url);
    const id = u.searchParams.get("id") ?? "";
    const sc = id.slice(0, 4).toLowerCase();
    if (u.pathname.endsWith("/info")) return { status: 200, body: { stopDate: "2026-08-16T23:59:59Z" } };
    if (opts.failing?.has(sc)) return { status: 503, body: "unavailable" };
    if (opts.empty) return { status: 200, body: { data: [] } };
    if (id.includes("FGM")) {
      const b = opts.fill ? [-1e31, -1e31, -1e31, -1e31] : [5, -3, 10, 12];
      return { status: 200, body: { data: [["2026-08-16T23:59:58.959Z", b]] } };
    }
    return {
      status: 200,
      body: { data: [["2026-08-16T23:59:30.000Z", [-47300, 10300, -43900]], ["2026-08-17T00:00:00.000Z", [-47400, 10280, -43920]]] },
    };
  };
}

test("MMS: one spacecraft HTTP error keeps the other three (GAU-53)", async () => {
  const samples = await withFetch(mmsRoute({ failing: new Set(["mms2"]) }), fetchMmsCdawebSamples);
  assert.deepEqual(
    samples.map((s) => s.id),
    ["mms1", "mms3", "mms4"],
  );
  const status = getMmsCdawebStatus();
  assert.equal(status.healthy, true);
  assert.match(status.message ?? "", /3\/4.*archival.*1 failed/);
});

test("MMS: native GSM B, MEC position interpolated to the B sample time", async () => {
  const [s] = await withFetch(mmsRoute(), fetchMmsCdawebSamples);
  assert.deepEqual({ ...s.magneticFieldNt }, { x: 5, y: -3, z: 10 }, "|B| component is dropped");
  const f = 28.959 / 30;
  close(s.positionGsmRe.x * 6371.2, -47300 + (-100) * f, 1e-6);
});

test("MMS: zero samples does not advance lastSeen to now (GAU-54)", async () => {
  const before = getMmsCdawebStatus().lastSeen;
  const samples = await withFetch(mmsRoute({ empty: true }), fetchMmsCdawebSamples);
  assert.equal(samples.length, 0);
  const status = getMmsCdawebStatus();
  assert.equal(status.lastSeen, before);
  assert.equal(status.healthy, false);
});

test("MMS: fill-valued components are rejected rather than zeroed", async () => {
  const samples = await withFetch(mmsRoute({ fill: true }), fetchMmsCdawebSamples);
  assert.equal(samples.length, 0);
});

test("JAXA: catalog reachability is not reported as a healthy data feed (GAU-55)", async () => {
  const reachable = await withFetch(
    (url) => (url.includes("darts.isas.jaxa.jp") ? { status: 200, body: "<html>ERG Arase</html>" } : undefined),
    probeJaxaCatalog,
  );
  assert.equal(reachable, true);
  const status = getJaxaStatus();
  assert.equal(status.healthy, false);
  assert.equal(status.lastSeen, null);
  assert.match(status.message ?? "", /probe only/);
});

test("NOAA: zone-less SWPC time_tags are read as UTC, invalid ones rejected", () => {
  assert.equal(swpcTimeToIso("2026-10-10 12:00:00.000"), "2026-10-10T12:00:00.000Z");
  assert.equal(swpcTimeToIso("2026-10-10T12:00:00Z"), "2026-10-10T12:00:00.000Z");
  assert.equal(swpcTimeToIso(""), null);
  assert.equal(swpcTimeToIso("garbage"), null);
  assert.equal(swpcTimeToIso(null), null);
});

test("freshness tier follows measurement age, not fetch cadence (GAU-44)", () => {
  const now = Date.parse("2026-10-10T12:00:00Z");
  const at = (ageMs: number) => new Date(now - ageMs).toISOString();
  assert.equal(freshnessTier(at(30_000), now), 0);
  assert.equal(freshnessTier(at(NOAA_FRESH_MS), now), 0);
  assert.equal(freshnessTier(at(NOAA_FRESH_MS + 1), now), 1);
  assert.equal(freshnessTier(at(NOAA_MAX_AGE_MS), now), 1);
  assert.equal(freshnessTier(at(NOAA_MAX_AGE_MS + 1), now), 3);
  assert.equal(freshnessTier(null, now), 3);
  assert.equal(freshnessTier("not a time", now), 3);
});

test("ingest tick: no jitter between fetches, and an over-age readout is dropped (GAU-44)", async () => {
  const worker = new IngestionWorker() as unknown as {
    noaa: { timestamp: string } | null;
    lastFetch: Map<string, number>;
    tick: () => Promise<{ canonicalPoint: { source: string; solarWind: { speed: number }; quality: { tier: number; stale: boolean } } }>;
  };
  const fresh = {
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    density: 6,
    velocityGse: vec(-450, 0, 0),
    magneticFieldGse: vec(1, 2, -5),
    kp: 3,
    ovation: null,
  };
  // Pretend every source was just fetched so the tick makes no network calls.
  const now = Date.now();
  for (const key of ["noaa", "esa", "jaxa", "mms", "lasp", "kyoto-dst", "ml-forecast"]) worker.lastFetch.set(key, now);

  await withFetch(() => undefined, async () => {
    worker.noaa = fresh;
    const a = (await worker.tick()).canonicalPoint;
    const b = (await worker.tick()).canonicalPoint;
    assert.equal(a.quality.tier, 0);
    assert.equal(b.quality.tier, 0);
    assert.notEqual(a.source, "synthetic-nowcast");
    assert.equal(b.solarWind.speed, a.solarWind.speed, "no random variation between ticks");

    worker.noaa = { ...fresh, timestamp: new Date(Date.now() - NOAA_MAX_AGE_MS - 60_000).toISOString() };
    const c = (await worker.tick()).canonicalPoint;
    assert.equal(c.quality.tier, 3);
    assert.equal(c.quality.stale, true);
    assert.equal(worker.noaa, null);
  });
});

test("latest feed: points older than 15 min are served flagged stale (GAU-15)", async () => {
  const { withFreshness, LATEST_MAX_AGE_MS } = await import("../lib/freshness.js");
  const now = Date.parse("2026-10-10T12:00:00Z");
  const point = {
    timestamp: new Date(now - 60_000).toISOString(),
    quality: { outlier: false, stale: false, interpolated: false, extrapolated: false, lowConfidence: false, tier: 0 },
  } as unknown as Parameters<typeof withFreshness>[0];
  assert.equal(withFreshness(point, now), point);
  const old = withFreshness({ ...point, timestamp: new Date(now - LATEST_MAX_AGE_MS - 1).toISOString() }, now);
  assert.equal(old.quality.stale, true);
  assert.equal(old.quality.tier, 3);
  assert.equal(point.quality.stale, false, "input not mutated");
});

test("LASP: valid file_info query, timetag parsed, freshness from the newest file (GAU-89)", async () => {
  const now = Date.parse("2026-10-12T06:00:00Z");
  let query: URLSearchParams | null = null;
  const windows = await withFetch(
    (url) => {
      query = new URL(url).searchParams;
      return {
        status: 200,
        body: {
          files: [
            { file_name: "mms1_fgm_brst_l2_20261011120000_v5.0.0.cdf", timetag: "2026-10-11T12:00:00" },
            { file_name: "mms1_fgm_brst_l2_20261011180000_v5.0.0.cdf", timetag: "2026-10-11T18:00:00" },
            { file_name: "bad", timetag: "not a time" },
          ],
        },
      };
    },
    () => fetchMmsBurstWindows(now),
  );
  const q = query as unknown as URLSearchParams;
  assert.equal(q.get("data_level"), "l2", "the API rejects `level` with HTTP 400");
  assert.equal(q.has("level"), false);
  assert.ok(q.get("end_date")! > q.get("start_date")!, "end_date is exclusive");
  assert.equal(q.get("end_date"), "2026-10-13");
  assert.deepEqual(windows.map((w) => w.start), ["2026-10-11T12:00:00.000Z", "2026-10-11T18:00:00.000Z"]);
  assert.ok(windows.every((w) => w.end === null), "no invented end times");
  const status = getMmsLaspStatus();
  assert.equal(status.lastSeen, "2026-10-11T18:00:00.000Z", "lastSeen is the newest file, not now");
  assert.equal(status.latencySeconds, 12 * 3600);
  assert.equal(status.healthy, true);

  await withFetch(() => ({ status: 200, body: { files: [] } }), () => fetchMmsBurstWindows(now));
  assert.equal(getMmsLaspStatus().healthy, false);
  assert.equal(getMmsLaspStatus().lastSeen, "2026-10-11T18:00:00.000Z", "an empty answer keeps the last real lastSeen");
});
