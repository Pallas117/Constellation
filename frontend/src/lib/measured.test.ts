import assert from "node:assert/strict";
import test from "node:test";
import { parseGenericRadiationCSV } from "./api/csv-parsers.ts";
import { transformApiResponse } from "./dataProcessing.ts";
import { measuredDrivers } from "./measured.ts";

const live = {
  indices: { kp: 3.3, dst: -10 },
  magneticField: { x: 1, y: 2, z: -4, bt: 5 },
  solarWind: { speed: 480, density: 5, dynamicPressure: 2 },
  quality: { outlier: false, stale: false, interpolated: false, extrapolated: false, lowConfidence: false, tier: 0 },
} as unknown as Parameters<typeof measuredDrivers>[0];

test("measured drivers come only from current, complete measurements (GAU-114)", () => {
  assert.deepEqual(measuredDrivers(live), { kp: 3.3, bz: -4, speed: 480 });
  assert.equal(measuredDrivers(null), null);
  assert.equal(measuredDrivers({ ...live!, quality: { ...live!.quality, stale: true } }), null, "stale is unknown");
  assert.equal(measuredDrivers({ ...live!, quality: { ...live!.quality, tier: 3 } }), null, "tier 3 is unknown");
  assert.equal(
    measuredDrivers({ ...live!, indices: { ...live!.indices, kp: undefined as unknown as number } }),
    null,
    "a missing Kp is not 0 or 2",
  );
});

test("a feed response that omits its tier is not shown as live (GAU-114)", () => {
  const d = transformApiResponse({
    timestamp: "2026-10-12T00:00:00Z",
    solarWind: { speed: 400, density: 5, pressure: 2 },
    imf: { bz: -2, bt: 4 },
    particles: { protonFlux: 1, electronFlux: 100 },
    indices: { kp: 2, dst: -5 },
    flags: { stale: false, source: "live", lastUpdate: "2026-10-12T00:00:00Z" },
  } as unknown as Parameters<typeof transformApiResponse>[0]);
  assert.equal(d.tier, 3);
});

test("CSV rows with unparseable times are skipped, and compact times are UTC (GAU-114)", () => {
  const csv = ["not-a-time,120,500", "20240604232653,140,500", ",130,500"].join("\n");
  const rows = parseGenericRadiationCSV(csv, { source: "unknown" });
  assert.equal(rows.length, 1, "bad and missing timestamps are not stamped 'now'");
  assert.equal(rows[0].timestamp, "2024-06-04T23:26:53.000Z");
  assert.equal(rows[0].particleFlux, 140);
});
