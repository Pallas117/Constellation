import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import protobuf from "protobufjs";
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import { decodeCanonicalPoint, encodeCanonicalPoint, POINT_SCHEMA, PROTO_PATH } from "./proto.js";

/** Every key required and non-null, all the way down: a field added to the type must be added here. */
type Full<T> = T extends readonly (infer U)[]
  ? Full<U>[]
  : T extends object
    ? { [K in keyof T]-?: Full<NonNullable<T[K]>> }
    : T;

const scale = (label: string, basis: string) => ({ level: 2 as const, label, basis, observedAt: "2026-10-31T03:59:00Z" });

/** A point with every field of CanonicalSpaceWeatherPoint set (GAU-210: the old .proto dropped six of them). */
const full: Full<CanonicalSpaceWeatherPoint> = {
  timestamp: "2026-10-31T04:00:05Z",
  observedAt: "2026-10-31T03:59:00Z",
  spacecraft: "DSCOVR",
  arriving: {
    observedAt: "2026-10-31T03:05:00Z",
    arrivedAt: "2026-10-31T03:58:00Z",
    travelSeconds: 3180.5,
    spacecraft: "DSCOVR",
    samples: 5,
    bz: -7.25,
    by: 3.5,
    density: 6.8,
    speed: 512.4,
    dynamicPressure: 2.98,
  },
  densityCheck: { spacecraft: "DSCOVR", density: 30.2, reference: "ACE", referenceDensity: 6.1, ratio: 4.95, minutes: 42 },
  source: "noaa-swpc",
  rho: 6.8,
  velocity: { x: -511.9, y: 12.25, z: -3.5, magnitude: 512.4 },
  magneticField: { x: 2.5, y: 3.5, z: -7.25, bt: 8.43 },
  electricField: { x: 0.1, y: 3.71, z: -1.25, ey: 3.71 },
  solarWind: { speed: 512.4, density: 6.8, dynamicPressure: 2.98 },
  indices: {
    kp: 4.33,
    dst: -41.5,
    dstMethod: "burton-1975",
    dstDerivedFrom: ["solarWind.speed", "magneticField.z", "solarWind.dynamicPressure"],
    kpKind: "estimated-1m",
    kpObservedAt: "2026-10-31T03:59:00Z",
    dstObservedAt: "2026-10-31T03:00:00Z",
  },
  derived: [{ field: "velocity", method: "gse-from-speed-angles", derivedFrom: ["speed", "lon", "lat"] }],
  coupling: { newell: 6123456.789, epsilon: 1.25e11 },
  propagation: { l1DelaySeconds: 3180.5, etaEarthArrival: "2026-10-31T04:52:05Z" },
  alerts: {
    stormTier: "warning",
    reason: "Sustained southward IMF with elevated coupling",
    radiation: scale("S2", "GOES >=10 MeV protons 152 pfu"),
    geomagnetic: scale("G2", "planetary Kp 6"),
    radioBlackout: scale("R2", "GOES 0.1-0.8 nm 5.1e-5 W m^-2"),
  },
  xray: { value: 5.1e-5, band: "0.1-0.8nm", flareClass: "M5.1", satellite: "GOES-19", timestamp: "2026-10-31T03:59:00Z" },
  senseChecks: [
    { id: "l1-field-magnitude", status: "pass", reason: "Bt covers |B| within 2%", observedAt: "2026-10-31T03:59:00Z", checked: 60, flagged: 0 },
  ],
  noaaAlerts: [{ productId: "K06W", issuedAt: "2026-10-31T02:10:00Z", headline: "WARNING: Geomagnetic K-index of 6 expected" }],
  quality: { outlier: true, stale: false, interpolated: true, extrapolated: false, lowConfidence: true, tier: 1 },
  particles: {
    protons: { value: 152.5, energy: ">=10 MeV", satellite: "GOES-19", timestamp: "2026-10-31T03:55:00Z" },
    electrons: { value: 1250.75, energy: ">=2 MeV", satellite: "GOES-19", timestamp: "2026-10-31T03:55:00Z" },
  },
  uncertainty: {
    speed: { lower: 498.1, upper: 526.7, sigma: 7.15 },
    density: { lower: 5.9, upper: 7.7, sigma: 0.45 },
    bz: { lower: -8.1, upper: -6.4, sigma: 0.43 },
  },
};

test("every field of the canonical point survives the protobuf feed, at full precision", async () => {
  const decoded = await decodeCanonicalPoint(await encodeCanonicalPoint(full));
  const { schema, ...rest } = decoded;
  assert.equal(schema, POINT_SCHEMA);
  assert.deepEqual(rest, full);
  assert.equal((decoded.coupling as { newell: number }).newell, 6123456.789);
});

test("unknown decodes as absent, never as 0, false or an empty list", async () => {
  const point: CanonicalSpaceWeatherPoint = {
    ...full,
    observedAt: null,
    arriving: null,
    xray: null,
    noaaAlerts: null,
    derived: undefined,
    senseChecks: undefined,
    indices: { ...full.indices, kp: Number.NaN },
    alerts: { ...full.alerts, radiation: { level: null, label: "S?", basis: "no current GOES protons", observedAt: null } },
    particles: { protons: null, electrons: null },
  };
  const decoded = await decodeCanonicalPoint(await encodeCanonicalPoint(point));
  for (const field of ["observedAt", "arriving", "xray", "noaaAlerts", "derived", "senseChecks"]) {
    assert.equal(field in decoded, false, `${field} should be absent`);
  }
  assert.equal("kp" in (decoded.indices as object), false);
  const alerts = decoded.alerts as { radiation: Record<string, unknown> };
  assert.deepEqual(alerts.radiation, { label: "S?", basis: "no current GOES protons" });
  assert.deepEqual(decoded.particles, {});
});

test("known-empty lists stay apart from unknown ones", async () => {
  const decoded = await decodeCanonicalPoint(await encodeCanonicalPoint({ ...full, noaaAlerts: [], derived: [], senseChecks: [] }));
  assert.deepEqual(decoded.noaaAlerts, []);
  assert.deepEqual(decoded.derived, []);
  assert.deepEqual(decoded.senseChecks, []);
});

test("a value of the wrong type is refused, not sent as a default", async () => {
  const bad = { ...full, rho: "6.8" } as unknown as CanonicalSpaceWeatherPoint;
  await assert.rejects(encodeCanonicalPoint(bad), /does not fit sw\.point\/2\.0\.0/);
});

test("telemetry_descriptor.json is the current .proto", async () => {
  const descriptor = path.join(path.dirname(PROTO_PATH), "telemetry_descriptor.json");
  const root = await protobuf.load(PROTO_PATH);
  assert.deepEqual(JSON.parse(readFileSync(descriptor, "utf8")), root.toJSON());
});
