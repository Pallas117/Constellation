import assert from "node:assert/strict";
import test from "node:test";
import { dipoleTiltRad, gseToGsm, gsmToGse, vec } from "../physics/coordinates.js";
import { IngestionWorker } from "../worker/ingest-loop.js";
import { fetchEsaReadout, parseNecRow } from "./esa-hapi.js";
import { getJaxaStatus, probeJaxaCatalog } from "./jaxa-erg.js";
import { fetchMmsCdawebSamples, getMmsCdawebStatus } from "./mms-cdaweb.js";
import { fetchNoaaReadout } from "./noaa-swpc.js";

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

test("NOAA: velocity comes from bulk speed, not the temperature column; mag is rotated from GSM (GAU-48, GAU-51, GAU-56)", async () => {
  const ts = "2026-10-10 12:00:00.000";
  const readout = await withFetch((url) => {
    if (url.includes("plasma-1-day")) {
      return { status: 200, body: [["time_tag", "density", "speed", "temperature"], [ts, "4.2", "512.3", "123456"]] };
    }
    if (url.includes("mag-1-day")) {
      return {
        status: 200,
        body: [["time_tag", "bx_gsm", "by_gsm", "bz_gsm", "lon_gsm", "lat_gsm", "bt"], [ts, "1.0", "-2.0", "-6.0", "0", "0", "6.4"]],
      };
    }
    if (url.includes("planetary-k-index")) return { status: 200, body: [["time_tag", "Kp"], [ts, "4.33"]] };
    if (url.includes("ovation")) return { status: 200, body: {} };
    return undefined;
  }, fetchNoaaReadout);

  assert.ok(readout);
  assert.deepEqual(
    { x: readout.velocityGse.x, y: readout.velocityGse.y, z: readout.velocityGse.z },
    { x: -512.3, y: 0, z: 0 },
  );
  const expected = gsmToGse(vec(1, -2, -6), ts);
  close(readout.magneticFieldGse.z, expected.z);
  close(readout.magneticFieldGse.x, 1); // X is common to GSM and GSE
  assert.equal("dst" in readout, false, "Dst must not be synthesised from Kp");
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

test("ESA: a real nested HAPI response yields an NEC readout, not GSE (GAU-50, GAU-51)", async () => {
  const readout = await withFetch(
    (url) =>
      url.includes("vires.services")
        ? { status: 200, body: { data: [["2026-10-10T12:00:00Z", [21000, -1500, 42000]]] } }
        : undefined,
    fetchEsaReadout,
  );
  assert.ok(readout);
  assert.equal(readout.magneticFieldNec.z, 42000);
  assert.equal("magneticFieldGse" in readout, false);
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

function mmsRoute(failing: Set<string>, empty = false): Route {
  return (url) => {
    if (!url.includes("cdaweb.gsfc.nasa.gov")) return undefined;
    const id = new URL(url).searchParams.get("id") ?? "";
    const sc = id.slice(0, 4).toLowerCase();
    if (failing.has(sc)) return { status: 503, body: "unavailable" };
    if (empty) return { status: 200, body: { data: [] } };
    const value = id.includes("FGM") ? [5, -3, 10] : [60000, 10000, 5000];
    return { status: 200, body: { data: [["2026-10-10T12:00:00Z", value]] } };
  };
}

test("MMS: one spacecraft HTTP error keeps the other three (GAU-53)", async () => {
  const samples = await withFetch(mmsRoute(new Set(["mms2"])), fetchMmsCdawebSamples);
  assert.deepEqual(
    samples.map((s) => s.id),
    ["mms1", "mms3", "mms4"],
  );
  const status = getMmsCdawebStatus();
  assert.equal(status.healthy, true);
  assert.match(status.message ?? "", /3\/4.*1 failed/);
});

test("MMS: zero samples does not advance lastSeen to now (GAU-54)", async () => {
  const before = getMmsCdawebStatus().lastSeen;
  const samples = await withFetch(mmsRoute(new Set(), true), fetchMmsCdawebSamples);
  assert.equal(samples.length, 0);
  const status = getMmsCdawebStatus();
  assert.equal(status.lastSeen, before);
  assert.equal(status.healthy, false);
});

test("MMS: fill-valued components are rejected rather than zeroed", async () => {
  const samples = await withFetch(
    (url) =>
      url.includes("cdaweb.gsfc.nasa.gov")
        ? { status: 200, body: { data: [["2026-10-10T12:00:00Z", [-1e31, -1e31, -1e31]]] } }
        : undefined,
    fetchMmsCdawebSamples,
  );
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
