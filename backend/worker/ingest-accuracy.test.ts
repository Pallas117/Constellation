import assert from "node:assert/strict";
import test from "node:test";
import { fetchNoaaReadout } from "../adapters/noaa-swpc.js";
import type { L1Sample } from "../adapters/rtsw-series.js";
import { vec } from "../physics/coordinates.js";
import { withFreshness } from "../lib/freshness.js";
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import { IngestionWorker, NOAA_MAX_AGE_MS } from "./ingest-loop.js";

type Route = (url: string) => unknown;

async function withFetch<T>(route: Route, fn: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = route(url);
    if (body === undefined) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const tag = (ms: number) => new Date(ms).toISOString().slice(0, 19);

test("Kp now: the higher of this interval's running estimate and the last completed interval", async () => {
  const { currentKp } = await import("../adapters/noaa-swpc.js");
  const now = Date.parse("2026-10-12T09:40:00Z");
  const est = (value: number) => ({ value, observedAt: "2026-10-12T09:39:00.000Z", kind: "estimated-1m" as const });
  const done = (value: number, start = "2026-10-12T06:00:00.000Z") => ({ value, observedAt: start, kind: "planetary-3h" as const });
  // Seen live: the running estimate restarts near 0 after a 3.33 interval.
  assert.equal(currentKp(est(0.33), done(3.33), now)?.value, 3.33);
  // A rise shows before the interval completes.
  assert.equal(currentKp(est(5.67), done(3.33), now)?.kind, "estimated-1m");
  // A completed value from over 6 h ago no longer applies; either alone is used.
  assert.equal(currentKp(est(0.33), done(6, "2026-10-12T00:00:00.000Z"), now)?.value, 0.33);
  assert.equal(currentKp(null, done(3.33), now)?.value, 3.33);
  assert.equal(currentKp(est(1), null, now)?.value, 1);
});

test("NOAA: Kp reading combines the 1-minute running estimate with the 3-hourly product", async () => {
  const t = Date.parse("2026-10-12T06:20:00Z");
  const readout = await withFetch((url) => {
    if (url.includes("rtsw_wind_1m")) return [{ time_tag: tag(t), source: "SOLAR1", active: true, proton_speed: 480, proton_density: 3, proton_vx_gse: -480, proton_vy_gse: 0, proton_vz_gse: 0 }];
    if (url.includes("rtsw_mag_1m")) return [{ time_tag: tag(t), source: "SOLAR1", active: true, bx_gse: 1, by_gse: 2, bz_gse: -3, bx_gsm: 1, by_gsm: 1.5, bz_gsm: -3.2 }];
    if (url.includes("planetary_k_index_1m")) return [{ time_tag: "2026-10-12T06:18:00", estimated_kp: 1.67 }, { time_tag: "2026-10-12T06:19:00", estimated_kp: 2.0 }];
    if (url.includes("noaa-planetary-k-index")) return [{ time_tag: "2026-10-12T03:00:00", Kp: 2.33 }];
    if (url.includes("ovation")) return {};
    return undefined;
  }, fetchNoaaReadout);
  assert.ok(readout);
  assert.equal(readout.kp, 2.33, "03-06 UT completed at 2.33; the 06-09 running estimate is still 2.0");
  assert.deepEqual(readout.kpReading, { value: 2.33, observedAt: "2026-10-12T03:00:00.000Z", kind: "planetary-3h" });
  assert.deepEqual({ ...readout.magneticFieldGsm! }, { x: 1, y: 1.5, z: -3.2 }, "published GSM kept");
  assert.equal(readout.series?.length, 1);
});

type Tickable = {
  noaa: unknown;
  l1Series: L1Sample[];
  lastFetch: Map<string, number>;
  tick: () => Promise<{ canonicalPoint: CanonicalSpaceWeatherPoint }>;
};

function quietWorker(): Tickable {
  const worker = new IngestionWorker() as unknown as Tickable;
  const now = Date.now();
  for (const key of ["noaa", "esa", "jaxa", "mms", "lasp", "swpc-products", "ml-forecast"]) worker.lastFetch.set(key, now);
  return worker;
}

const readout = (ageMs: number, bz: number, density = 6) => ({
  timestamp: new Date(Date.now() - ageMs).toISOString(),
  spacecraft: "SOLAR1",
  density,
  velocityGse: vec(-450, 0, 0),
  velocityGsm: vec(-450, 0, 0),
  magneticFieldGse: vec(1, 2, bz),
  magneticFieldGsm: vec(1, 2, bz),
  kp: 3,
  ovation: null,
});

test("ingest: points carry the measurement time and the measured values, unblended", async () => {
  const worker = quietWorker();
  await withFetch(() => undefined, async () => {
    worker.noaa = readout(120_000, -4);
    const a = (await worker.tick()).canonicalPoint;
    assert.equal(a.observedAt, (worker.noaa as { timestamp: string }).timestamp);
    assert.notEqual(a.timestamp, a.observedAt, "issued now, measured 2 min ago");
    const etaMs = Date.parse(a.propagation.etaEarthArrival) - Date.parse(a.observedAt!);
    assert.ok(Math.abs(etaMs - (1_500_000 / 450) * 1000) < 1, "ETA counted from the measurement");

    worker.noaa = readout(60_000, 5, 9);
    const b = (await worker.tick()).canonicalPoint;
    assert.equal(b.magneticField.z, 5, "a northward turning shows at once, not 35% per tick");
    assert.equal(b.solarWind.density, 9);
  });
});

test("ingest: an expired readout carries the last measured field, never a zero field", async () => {
  const worker = quietWorker();
  await withFetch(() => undefined, async () => {
    worker.noaa = readout(60_000, -7);
    await worker.tick();
    worker.noaa = readout(NOAA_MAX_AGE_MS + 60_000, -7);
    const c = (await worker.tick()).canonicalPoint;
    assert.equal(c.quality.stale, true);
    assert.equal(c.magneticField.z, -7);
    assert.equal(withFreshness(c).quality.stale, true, "/latest judges freshness by observedAt");
  });
});

test("ingest: solar wind in transit keeps arriving at Earth after the L1 feed is lost", async () => {
  const worker = quietWorker();
  const now = Date.now();
  // L1 stopped 20 min ago; it had been reporting southward IMF at 500 km/s (50 min travel).
  const series: L1Sample[] = [];
  for (let m = 180; m >= 20; m -= 1) {
    series.push({
      t: now - m * 60_000,
      spacecraft: "SOLAR1",
      density: 4,
      speed: 500,
      velocityGse: vec(-500, 0, 0),
      velocityGsm: vec(-500, 0, 0),
      magneticFieldGse: vec(0, 0, -8),
      magneticFieldGsm: vec(0, -1, -8),
    });
  }
  worker.l1Series = series;
  await withFetch(() => undefined, async () => {
    const p = (await worker.tick()).canonicalPoint;
    assert.equal(p.quality.stale, true, "no current L1 readout");
    assert.ok(p.arriving, "but the wind measured 50 min ago is reaching Earth now");
    assert.equal(p.arriving.bz, -8);
    assert.ok(Math.abs(Date.parse(p.arriving.observedAt) - (now - 50 * 60_000)) <= 60_000);
  });
});

test("ingest: every point carries its sense-checks; an inconsistent newest field sample lowers confidence (GAU-136)", async () => {
  const worker = quietWorker();
  const now = Date.now();
  const sample = (m: number, bt: number): L1Sample => ({
    t: now - m * 60_000,
    spacecraft: "SOLAR1",
    density: 6,
    speed: 450,
    velocityGse: vec(-450, 0, 0),
    velocityGsm: vec(-450, 0, 0),
    magneticFieldGse: vec(3, 4, 0),
    magneticFieldGsm: vec(3, 0, 4),
    bt,
  });
  await withFetch(() => undefined, async () => {
    worker.noaa = readout(60_000, 0);
    worker.l1Series = [sample(3, 5.2), sample(2, 5.1), sample(1, 5.0)];
    const ok = (await worker.tick()).canonicalPoint;
    assert.deepEqual(
      ok.senseChecks?.map((c) => [c.id, c.status]),
      [
        ["l1-field-magnitude", "pass"],
        ["goes-proton-spectrum", "unknown"],
        ["goes-proton-channels", "unknown"],
        ["goes-xray", "unknown"],
        ["noaa-scales", "unknown"],
      ],
      "GOES and NOAA weren't fetched: unknown, never pass",
    );
    assert.equal(ok.alerts.radioBlackout?.label, "R?");
    assert.equal(ok.noaaAlerts, null, "alerts not read: unknown, not an empty list");
    assert.equal(ok.quality.lowConfidence, false);

    worker.l1Series = [sample(3, 5.2), sample(2, 5.1), sample(1, 2.0)];
    const bad = (await worker.tick()).canonicalPoint;
    const field = bad.senseChecks?.[0];
    assert.equal(field?.status, "flag");
    assert.equal(field?.flagged, 1);
    assert.match(field?.reason ?? "", /Bt 2\.00 nT is below \|B\| 5\.00 nT/);
    assert.equal(bad.quality.lowConfidence, true);
  });
});
