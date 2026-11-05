/**
 * GAU-63 sales gate: for each adapter, an API failure, an empty or malformed payload and stale data
 * must read as unknown, with the source, the real last-seen time, a growing age, and no URL in the
 * message. Never a default, a fallback or "healthy".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fetchEsaReadout, getEsaStatus } from "./esa-hapi.js";
import { fetchGoesParticles, getGoesStatus } from "./goes-particles.js";
import { getJaxaStatus, probeJaxaCatalog } from "./jaxa-erg.js";
import { fetchKyotoDst, getKyotoDstStatus } from "./kyoto-dst.js";
import { fetchMmsCdawebSamples, getMmsCdawebStatus } from "./mms-cdaweb.js";
import { fetchMmsBurstWindows, getMmsLaspStatus } from "./mms-lasp.js";
import { fetchNoaaReadout, getNoaaStatus, latestKp, latestKp1m } from "./noaa-swpc.js";
import { parseNoaaAlerts } from "./swpc-products.js";

type Reply = { status: number; body: unknown } | undefined;

async function withRoutes<T>(route: (url: URL) => Reply, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const hit = route(url);
    if (!hit) throw new Error("connection refused");
    return new Response(typeof hit.body === "string" ? hit.body : JSON.stringify(hit.body), { status: hit.status });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const NOW = Date.parse("2026-10-20T06:00:00Z");
const tag = (ms: number) => new Date(ms).toISOString().slice(0, 19);
const noURL = (message: string | undefined) => assert.ok(!/https?:\/\//.test(message ?? ""), `no URL in "${message}"`);

/** RTSW wind and mag rows `ageMin` old, plus the two Kp products. */
function rtsw(ageMin: number) {
  const t = tag(NOW - ageMin * 60_000);
  return (url: URL): Reply => {
    const file = url.pathname.split("/").pop();
    if (file === "rtsw_wind_1m.json") return { status: 200, body: [{ time_tag: t, active: true, source: "ACE", proton_density: 5, proton_speed: 420 }] };
    if (file === "rtsw_mag_1m.json") {
      return { status: 200, body: [{ time_tag: t, active: true, source: "ACE", bt: 5, bx_gse: 3, by_gse: 0, bz_gse: -4, bx_gsm: 3, by_gsm: 0.5, bz_gsm: -3.97 }] };
    }
    if (file === "planetary_k_index_1m.json") return { status: 200, body: [{ time_tag: tag(NOW - 60_000), estimated_kp: 2.33 }] };
    if (file === "noaa-planetary-k-index.json") return { status: 200, body: [{ time_tag: tag(NOW - 3 * 3_600_000), Kp: 2 }] };
    return { status: 404, body: "" };
  };
}

test("NOAA: an HTTP failure is unknown, keeps the last real time, and names the product, not the URL (GAU-63)", async () => {
  await withRoutes(rtsw(2), () => fetchNoaaReadout(NOW));
  const seen = getNoaaStatus().lastSeen;
  assert.equal(getNoaaStatus().healthy, true);
  const later = NOW + 30 * 60_000;
  assert.equal(await withRoutes(() => ({ status: 503, body: "busy" }), () => fetchNoaaReadout(later)), null);
  const status = getNoaaStatus();
  assert.equal(status.healthy, false);
  assert.equal(status.lastSeen, seen, "the last real measurement time, not now");
  assert.equal(status.latencySeconds, 32 * 60, "the age keeps growing");
  assert.match(status.message ?? "", /NOAA SWPC rtsw_(wind|mag)_1m\.json returned HTTP 503/);
  noURL(status.message);
});

test("NOAA: an empty payload is unknown, never a default reading (GAU-63)", async () => {
  const readout = await withRoutes((url) => (url.pathname.includes("rtsw") ? { status: 200, body: [] } : rtsw(2)(url)), () => fetchNoaaReadout(NOW));
  assert.equal(readout, null);
  assert.equal(getNoaaStatus().healthy, false);
  assert.match(getNoaaStatus().message ?? "", /no complete, plausible wind\+mag record/);
});

test("NOAA: a newest L1 sample 30 min old is reported, but not as healthy (GAU-63)", async () => {
  const readout = await withRoutes(rtsw(30), () => fetchNoaaReadout(NOW));
  assert.ok(readout, "the worker still sees it and marks the point stale");
  const status = getNoaaStatus();
  assert.equal(status.healthy, false);
  assert.equal(status.latencySeconds, 30 * 60);
  assert.match(status.message ?? "", /newest complete L1 sample \(ACE\) is 30 min old/);
});

test("NOAA: Kp fill values are skipped, never read as a quiet Kp 0 (GAU-63)", () => {
  const completed = latestKp([
    { time_tag: "2026-10-20T00:00:00", Kp: 4.33 },
    { time_tag: "2026-10-20T03:00:00", Kp: -1 },
  ]);
  assert.equal(completed?.value, 4.33, "the newest valid interval, not the fill");
  assert.equal(latestKp1m([{ time_tag: "2026-10-20T05:59:00", estimated_kp: -1 }]), null);
  assert.equal(latestKp([{ time_tag: "2026-10-20T03:00:00", Kp: 12 }]), null, "out of range is a fault, not Kp 9");
});

const swarmInfo = (stop: string) => ({ status: 200, body: { stopDate: stop } });

test("ESA: an HTTP failure is unknown, with no URL in the message (GAU-63)", async () => {
  assert.equal(await withRoutes(() => ({ status: 503, body: "busy" }), () => fetchEsaReadout(NOW)), null);
  const status = getEsaStatus();
  assert.equal(status.healthy, false);
  assert.match(status.message ?? "", /ESA HAPI info returned HTTP 503/);
  noURL(status.message);
});

test("ESA: a Swarm sample 30 h old is returned but not healthy (GAU-63)", async () => {
  const stop = new Date(NOW - 30 * 3_600_000).toISOString();
  const readout = await withRoutes(
    (url) =>
      url.pathname.endsWith("/info")
        ? swarmInfo(stop)
        : { status: 200, body: { data: [[stop, 51.2, -3.1, 6821000, [18085, 2155, 37300]]] } },
    () => fetchEsaReadout(NOW),
  );
  assert.ok(readout);
  const status = getEsaStatus();
  assert.equal(status.healthy, false);
  assert.match(status.message ?? "", /newest Swarm A FAST sample is 30 h old \(limit 24 h\)/);
});

function mms(stopDate: string, failing = false) {
  return (url: URL): Reply => {
    if (!url.hostname.includes("cdaweb")) return undefined;
    if (url.pathname.endsWith("/info")) return { status: 200, body: { stopDate } };
    if (failing) return { status: 503, body: "unavailable" };
    const id = url.searchParams.get("id") ?? "";
    const t = new Date(Date.parse(stopDate) - 1_000).toISOString();
    return id.includes("FGM")
      ? { status: 200, body: { data: [[t, [5, -3, 10, 12]]] } }
      : { status: 200, body: { data: [[new Date(Date.parse(stopDate) - 30_000).toISOString(), [-47300, 10300, -43900]], [stopDate, [-47400, 10280, -43920]]] } };
  };
}

test("MMS: survey data older than 90 days is returned but not healthy (GAU-63)", async () => {
  const samples = await withRoutes(mms("2026-06-01T00:00:00Z"), () => fetchMmsCdawebSamples(NOW));
  assert.equal(samples.length, 4);
  assert.ok(samples.every((s) => /interpolated/.test(s.positionMethod ?? "")), "the position method is recorded");
  const status = getMmsCdawebStatus();
  assert.equal(status.healthy, false);
  assert.match(status.message ?? "", /older than 90 d, not current/);
});

test("MMS: all four spacecraft failing is unknown, with nothing returned (GAU-63)", async () => {
  const samples = await withRoutes(mms("2026-10-01T00:00:00Z", true), () => fetchMmsCdawebSamples(NOW));
  assert.deepEqual(samples, []);
  const status = getMmsCdawebStatus();
  assert.equal(status.healthy, false);
  assert.match(status.message ?? "", /0\/4.*4 failed/);
  noURL(status.message);
});

test("LASP: an HTTP failure is unknown and the age keeps growing (GAU-63)", async () => {
  await withRoutes(
    () => ({ status: 200, body: { files: [{ file_name: "mms1_fgm_brst_l2_20261019120000_v5.0.0.cdf", timetag: "2026-10-19T12:00:00" }] } }),
    () => fetchMmsBurstWindows(NOW),
  );
  assert.equal(getMmsLaspStatus().latencySeconds, 18 * 3600);
  assert.deepEqual(await withRoutes(() => ({ status: 500, body: "" }), () => fetchMmsBurstWindows(NOW + 3_600_000)), []);
  const status = getMmsLaspStatus();
  assert.equal(status.healthy, false);
  assert.equal(status.lastSeen, "2026-10-19T12:00:00.000Z");
  assert.equal(status.latencySeconds, 19 * 3600);
});

test("JAXA: a failure or an unexpected page is never a healthy feed (GAU-63)", async () => {
  assert.equal(await withRoutes(() => ({ status: 503, body: "" }), probeJaxaCatalog), false);
  assert.equal(getJaxaStatus().healthy, false);
  noURL(getJaxaStatus().message);
  assert.equal(await withRoutes(() => ({ status: 200, body: "<html>maintenance</html>" }), probeJaxaCatalog), false);
  assert.match(getJaxaStatus().message ?? "", /unexpected/);
  assert.equal(getJaxaStatus().healthy, false);
});

test("GOES: after a failure the reported age keeps growing from the last real sample (GAU-63)", async () => {
  const sample = (energy: string, flux: number) => ({ time_tag: "2026-10-20T05:55:00Z", satellite: 18, flux, energy });
  await withRoutes(
    (url) =>
      url.pathname.includes("protons") ? { status: 200, body: [sample(">=10 MeV", 0.3)] }
      : url.pathname.includes("electrons") ? { status: 200, body: [sample(">=2 MeV", 150)] }
      : { status: 404, body: "" },
    () => fetchGoesParticles(NOW),
  );
  assert.equal(getGoesStatus().latencySeconds, 300);
  assert.equal(await withRoutes(() => ({ status: 502, body: "" }), () => fetchGoesParticles(NOW + 3_600_000)), null);
  const status = getGoesStatus();
  assert.equal(status.healthy, false);
  assert.equal(status.latencySeconds, 300 + 3600);
  noURL(status.message);
});

test("Kyoto Dst: after a failure the reported age keeps growing from the last real hour (GAU-63)", async () => {
  await withRoutes(() => ({ status: 200, body: [{ time_tag: "2026-10-20T05:00:00", dst: -18 }] }), () => fetchKyotoDst(NOW));
  const seen = getKyotoDstStatus().latencySeconds;
  assert.equal(await withRoutes(() => ({ status: 500, body: "" }), () => fetchKyotoDst(NOW + 2 * 3_600_000)), null);
  const status = getKyotoDstStatus();
  assert.equal(status.healthy, false);
  assert.equal(status.latencySeconds, (seen ?? 0) + 2 * 3600);
  noURL(status.message);
});

test("NOAA alerts: a payload that isn't the alerts format is unknown (null), not 'no alerts' (GAU-63)", () => {
  assert.equal(parseNoaaAlerts({ not: "a list" }, NOW), null);
  assert.equal(parseNoaaAlerts([{ unexpected: "shape" }], NOW), null);
  assert.deepEqual(parseNoaaAlerts([], NOW), [], "an empty list really is no alerts");
});
