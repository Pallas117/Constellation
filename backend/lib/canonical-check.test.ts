import assert from "node:assert/strict";
import test from "node:test";
import { canonicalPointProblems } from "./canonical-check.js";
import { PLAUSIBLE } from "../../shared/policy/limits.js";
import { PLAUSIBLE as RTSW_PLAUSIBLE } from "../adapters/rtsw-series.js";
import type { CanonicalSpaceWeatherPoint } from "../types.js";

/** The fields the check reads, as a measured quiet-time point would carry them. */
export function goodPoint(over: Record<string, unknown> = {}): CanonicalSpaceWeatherPoint {
  return {
    timestamp: "2026-11-17T10:00:05.000Z",
    observedAt: "2026-11-17T09:59:00.000Z",
    velocity: { x: -420, y: 5, z: -3, magnitude: 420.04 },
    magneticField: { x: 2, y: -3, z: -4, bt: 5.4 },
    solarWind: { speed: 420, density: 4.2, dynamicPressure: 1.2 },
    indices: { kp: 2.33, dst: -12, dstMethod: "measured" },
    quality: {},
    ...over,
  } as unknown as CanonicalSpaceWeatherPoint;
}

test("GAU-244: a measured quiet-time point is a usable observation", () => {
  assert.deepEqual(canonicalPointProblems(goodPoint()), []);
  assert.deepEqual(canonicalPointProblems(goodPoint({ indices: { kp: null, dst: -12, dstMethod: "model" } })), [], "unknown Kp is allowed");
});

test("GAU-244: the legacy buffer's impossible speeds and NOAA fill values are refused", () => {
  const legacy = canonicalPointProblems(goodPoint({ solarWind: { speed: 64_483, density: 4, dynamicPressure: 1 } }));
  assert.equal(legacy.length, 1);
  assert.match(legacy[0], /speed 64483/);
  for (const fill of [-999.9, -9999, -1e5]) {
    assert.ok(canonicalPointProblems(goodPoint({ solarWind: { speed: 420, density: fill, dynamicPressure: 1 } })).some((p) => /density/.test(p)), `density fill ${fill}`);
  }
  assert.ok(canonicalPointProblems(goodPoint({ solarWind: { speed: 150, density: 4, dynamicPressure: 1 } })).length, "below the slowest solar wind");
  assert.ok(canonicalPointProblems(goodPoint({ magneticField: { x: 0, y: 0, z: 0, bt: 9999 } })).some((p) => /\|B\|/.test(p)));
  assert.ok(canonicalPointProblems(goodPoint({ indices: { kp: 12, dst: -12, dstMethod: "measured" } })).some((p) => /Kp/.test(p)));
  assert.ok(canonicalPointProblems(goodPoint({ indices: { kp: 3, dst: -99999, dstMethod: "measured" } })).some((p) => /Dst/.test(p)));
});

test("GAU-244: no measurement time, a measurement from the future, or non-finite vectors are refused", () => {
  assert.ok(canonicalPointProblems(goodPoint({ observedAt: undefined })).some((p) => /observedAt missing/.test(p)));
  assert.ok(canonicalPointProblems(goodPoint({ observedAt: "not a time" })).some((p) => /observedAt missing/.test(p)));
  assert.ok(canonicalPointProblems(goodPoint({ observedAt: "2026-11-17T10:10:00.000Z" })).some((p) => /later than/.test(p)));
  assert.deepEqual(canonicalPointProblems(goodPoint({ observedAt: "2026-11-17T10:01:00.000Z" })), [], "a minute of clock skew is tolerated");
  assert.ok(canonicalPointProblems(goodPoint({ velocity: { x: Number.NaN, y: 0, z: 0, magnitude: 400 } })).some((p) => /velocity/.test(p)));
  assert.ok(canonicalPointProblems(goodPoint({ timestamp: "" })).some((p) => /timestamp/.test(p)));
  assert.ok(canonicalPointProblems({} as CanonicalSpaceWeatherPoint).length >= 5, "an empty record never passes");
});

test("GAU-244: one limits table: the RTSW adapter uses the shared bounds", () => {
  assert.equal(RTSW_PLAUSIBLE, PLAUSIBLE);
});
