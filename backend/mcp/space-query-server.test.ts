/**
 * space-query MCP wiring: adapter readouts map to rows with units and frames; the server opens no listener.
 * Stub readouts only; nothing is fetched.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { adapterSources, dstRows, goesRows, kpRows, l1Rows, swarmRows } from "./space-query-server.js";

const T = "2026-11-26T05:59:00.000Z";

test("space-query MCP wiring: five allowlisted sources, L1/GOES/Swarm OBSERVED and Kp/Dst REPORTED", () => {
  const sources = adapterSources();
  assert.deepEqual(sources.map((s) => [s.id, s.label]), [
    ["noaa_l1_solar_wind", "OBSERVED"],
    ["noaa_kp", "REPORTED"],
    ["goes_particles", "OBSERVED"],
    ["esa_swarm", "OBSERVED"],
    ["kyoto_dst", "REPORTED"],
  ]);
  for (const s of sources) assert.ok(s.maxAgeMs > 0, `${s.id} has a freshness bound`);
});

test("space-query MCP wiring: adapter readouts map to rows with units and frames in the field names", () => {
  const v = { x: -400, y: 10, z: 5 };
  const b = { x: 1, y: 2, z: -6 };
  const series = [{ t: Date.parse(T), spacecraft: "DSCOVR", density: 5, speed: 400.2, velocityGse: v, velocityGsm: null, magneticFieldGse: b, magneticFieldGsm: { x: 1, y: 3, z: -7 }, bt: 6.5 }];
  const readout = { timestamp: T, spacecraft: "DSCOVR", density: 5, velocityGse: v, magneticFieldGse: b, kp: 3, kpReading: { value: 3.33, observedAt: T, kind: "estimated-1m" as const }, series, ovation: null };
  const [l1] = l1Rows(readout);
  assert.equal(l1.time, T);
  assert.equal(l1.values.bz_gsm_nt, -7);
  assert.equal(l1.values.bz_gse_nt, -6);
  assert.equal(l1.values.speed_kms, 400.2);
  assert.equal(l1Rows({ ...readout, series: [] })[0].values.bz_gsm_nt, null);
  assert.deepEqual(kpRows(readout), [{ time: T, values: { kp: 3.33, kind: "estimated-1m" } }]);
  assert.deepEqual(kpRows(null), []);
  const goes = goesRows({ protons: { value: 0.3, energy: ">=10 MeV", satellite: "GOES-19", timestamp: T }, electrons: null });
  assert.deepEqual(goes, [{ time: T, values: { channel: ">=10 MeV", flux_cm2_s_sr: 0.3, satellite: "GOES-19" } }]);
  const swarm = swarmRows({ timestamp: T, magneticFieldNec: { x: 20000, y: 100, z: 40000 }, position: null, fieldMagnitudeNt: 44721 });
  assert.equal(swarm[0].values.b_c_nt, 40000);
  assert.equal(swarm[0].values.altitude_km, null);
  assert.deepEqual(dstRows({ dst: -42, timestamp: T }), [{ time: T, values: { dst_nt: -42 } }]);
});

test("space-query MCP wiring: stdio only, no network listener in the server sources", () => {
  for (const f of ["space-query.ts", "space-query-server.ts"]) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    assert.ok(!/\.listen\(|createServer|node:net|node:http|WebSocket/.test(src), `${f} opens no port`);
  }
});
