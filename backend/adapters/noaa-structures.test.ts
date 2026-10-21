import assert from "node:assert/strict";
import test from "node:test";
import { fetchNoaaReadout, getL1Structures } from "./noaa-swpc.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const tag = (ms: number) => new Date(ms).toISOString().slice(0, 19);
const MINUTES = 480;
const JUMP = 240; // a fast-forward shock four hours before the newest minute

/** Eight hours of RTSW minutes from the active spacecraft, newest first, with a shock at JUMP. */
function rtsw(url: URL): { status: number; body: unknown } {
  const file = url.pathname.split("/").pop();
  const rows = Array.from({ length: MINUTES }, (_, k) => MINUTES - 1 - k).map((i) => ({ i, t: tag(NOW - (MINUTES - 1 - i) * 60_000) }));
  if (file === "rtsw_wind_1m.json") {
    return {
      status: 200,
      body: rows.map(({ i, t }) => ({
        time_tag: t,
        active: true,
        source: "SOLAR1",
        proton_speed: i < JUMP ? 400 : 500,
        proton_density: i < JUMP ? 5 : 10,
        proton_temperature: i < JUMP ? 80_000 : 200_000,
      })),
    };
  }
  if (file === "rtsw_mag_1m.json") {
    return {
      status: 200,
      body: rows.map(({ i, t }) => ({ time_tag: t, active: true, source: "SOLAR1", bt: i < JUMP ? 5 : 12, bx_gse: 3, by_gse: 0, bz_gse: -2, bx_gsm: 3, by_gsm: 0.3, bz_gsm: -2 })),
    };
  }
  if (file === "planetary_k_index_1m.json") return { status: 200, body: [{ time_tag: tag(NOW - 60_000), estimated_kp: 2.33 }] };
  if (file === "noaa-planetary-k-index.json") return { status: 200, body: [{ time_tag: tag(NOW - 3 * 3_600_000), Kp: 2 }] };
  return { status: 404, body: "" };
}

test("SWPC adapter: structure candidates cover all the L1 hours it reads, not just the point's 3 h (GAU-154)", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const { status, body } = rtsw(new URL(input instanceof Request ? input.url : String(input)));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  try {
    const readout = await fetchNoaaReadout(NOW);
    assert.ok(readout);
    assert.ok((readout.series ?? []).every((s) => s.t > NOW - 3 * 3_600_000), "the point keeps 3 h");
    assert.equal(readout.series?.at(-1)?.temperature, 200_000, "temperature is carried");

    const live = getL1Structures();
    assert.ok(live);
    assert.equal(live.spacecraft, "SOLAR1");
    assert.equal(live.from, new Date(NOW - (MINUTES - 1) * 60_000).toISOString());
    assert.equal(live.to, new Date(NOW).toISOString());
    // The shock is 4 h back, outside the 3 h point series, and still found.
    assert.equal(live.structures.shocks.length, 1);
    assert.equal(live.structures.shocks[0].time, new Date(NOW - (MINUTES - 1 - JUMP) * 60_000).toISOString());
    assert.equal(live.structures.coverage.temperature, 1);
  } finally {
    globalThis.fetch = real;
  }
});
