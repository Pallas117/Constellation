import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadArchive, replayArchive } from "../replay/replay.js";
import type { CanonicalSpaceWeatherPoint, ScaleReading, SenseCheck } from "../types.js";
import { EnvironmentHistory } from "./environment.js";
import { dipoleLShell, RE_KM } from "./orbit.js";
import {
  bannedWording,
  buildTrustRecord,
  DEFAULT_POLICY,
  parseTrustRequest,
  type TrustRecord,
  type TrustRecordRequest,
} from "./record.js";

const T = Date.parse("2026-01-19T18:30:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const scale = (scaleLetter: "S" | "G" | "R", level: number | null, observedMs: number, basis = "test basis"): ScaleReading => ({
  level: level as ScaleReading["level"],
  label: level === null ? `${scaleLetter}?` : `${scaleLetter}${level}`,
  basis,
  observedAt: iso(observedMs),
});
const pass = (id: SenseCheck["id"]): SenseCheck => ({ id, status: "pass", reason: "ok", observedAt: iso(T) });

/** A point Gauss issued at `issuedMs`, quiet unless overridden. */
function point(issuedMs: number, over: { s?: number | null; g?: number | null; r?: number; protonAgeMin?: number; checks?: SenseCheck[]; kpKind?: "estimated-1m" | "planetary-3h" | undefined } = {}): CanonicalSpaceWeatherPoint {
  const protonMs = issuedMs - (over.protonAgeMin ?? 5) * 60_000;
  return {
    timestamp: iso(issuedMs),
    observedAt: iso(issuedMs - 60_000),
    alerts: {
      stormTier: "quiet",
      reason: "",
      radiation: scale("S", over.s === undefined ? 0 : over.s, protonMs, "GOES >=10 MeV protons 0.3 pfu"),
      geomagnetic: scale("G", over.g === undefined ? 0 : over.g, issuedMs - 3_600_000, "Kp 2.00"),
      radioBlackout: scale("R", over.r ?? 0, issuedMs - 60_000, "GOES 0.1-0.8nm X-rays B5"),
    },
    particles: { protons: { value: 0.3, energy: ">=10 MeV", satellite: "GOES-18", timestamp: iso(protonMs) }, electrons: null },
    indices: { kp: 2, dst: -10, dstMethod: "measured", dstDerivedFrom: [], kpKind: "kpKind" in over ? over.kpKind : "planetary-3h", kpObservedAt: iso(issuedMs - 3_600_000), dstObservedAt: iso(issuedMs - 30 * 60_000) },
    quality: { outlier: false, stale: false, interpolated: false, extrapolated: false, lowConfidence: false, tier: 0 },
    senseChecks: over.checks ?? [pass("l1-field-magnitude"), pass("goes-proton-spectrum"), pass("goes-proton-channels"), pass("goes-xray"), pass("noaa-scales")],
  } as unknown as CanonicalSpaceWeatherPoint;
}

const req = (over: Partial<TrustRecordRequest> = {}): TrustRecordRequest => ({
  time: iso(T),
  spacecraftId: "DEMO-SAT-1",
  modelId: "cloudmask-v3.2",
  output: { label: "cloud" },
  confidence: 0.9,
  ...over,
});
const build = (points: CanonicalSpaceWeatherPoint[], over: Partial<TrustRecordRequest> = {}) =>
  buildTrustRecord(req(over), new EnvironmentHistory(points, "test history"), { nowMs: T + 3_600_000 });

test("trust record: quiet, current inputs are consistent, with the reasons and the SAA caveat (GAU-57)", () => {
  const r = build([point(T - 30_000)]);
  assert.equal(r.verdict.value, "consistent");
  assert.match(r.verdict.reasons[0], /Radiation S0 and geomagnetic G0, below the policy thresholds \(S2, G3\)/);
  assert.ok(r.verdict.reasons.includes("South Atlantic Anomaly not assessed (not modelled yet)."));
  assert.deepEqual(r.verdict.policy, DEFAULT_POLICY);
});

test("trust record: a missing reading is unknown, never consistent (GAU-57)", () => {
  const none = build([]);
  assert.equal(none.verdict.value, "unknown");
  assert.match(none.verdict.reasons[0], /no reading within 2 min before the inference \(test history\)/);
  assert.ok(Object.values(none.environment).every((f) => f.value === null && f.confidence === "none"));
  // A reading more than 2 min before the inference does not describe it.
  assert.equal(build([point(T - 3 * 60_000)]).verdict.value, "unknown");
  // A placeholder point (no NOAA Kp) has G unknown: the verdict follows.
  const placeholder = build([point(T - 30_000, { g: null, kpKind: undefined })]);
  assert.equal(placeholder.verdict.value, "unknown");
  assert.match(placeholder.verdict.reasons[0], /^Geomagnetic level unknown/);
});

test("trust record: a stale input is unknown, even when its level was quiet (GAU-57)", () => {
  const stale = build([point(T - 30_000, { protonAgeMin: 40 })]);
  assert.equal(stale.environment.radiation.value, null);
  assert.match(stale.environment.radiation.limitations[0], /older than 30 min at the inference time/);
  assert.equal(stale.environment.particleFlux.value, null);
  assert.equal(stale.verdict.value, "unknown");
});

test("trust record: conflicting inputs are unknown: NOAA disagrees, or the proton spectrum is impossible (GAU-57)", () => {
  const noaa = { id: "noaa-scales", status: "flag", reason: "NOAA S2, Gauss S0 (GOES >=10 MeV protons 0.3 pfu)", observedAt: iso(T) } as SenseCheck;
  const disagree = build([point(T - 30_000, { checks: [noaa] })]);
  assert.equal(disagree.environment.radiation.value, null);
  assert.match(disagree.environment.radiation.limitations[0], /^Conflicting inputs: NOAA S2, Gauss S0/);
  assert.equal(disagree.environment.geomagnetic.value?.label, "G0", "a disagreement on S says nothing about G");
  assert.equal(disagree.verdict.value, "unknown");

  const spectrum = { id: "goes-proton-spectrum", status: "flag", reason: ">=50 MeV 12 pfu exceeds >=10 MeV 3.0 pfu", observedAt: iso(T) } as SenseCheck;
  const impossible = build([point(T - 30_000, { checks: [spectrum] })]);
  assert.equal(impossible.environment.radiation.value, null);
  assert.equal(impossible.environment.particleFlux.value, null);
  assert.equal(impossible.verdict.value, "unknown");
});

test("trust record: storm levels or a flagged input degrade the context, at the policy's thresholds (GAU-57)", () => {
  const s2 = build([point(T - 30_000, { s: 2 })]);
  assert.equal(s2.verdict.value, "degraded-context");
  assert.match(s2.verdict.reasons[0], /Radiation storm S2 at geostationary orbit/);
  assert.equal(build([point(T - 30_000, { g: 3 })]).verdict.value, "degraded-context");
  assert.equal(build([point(T - 30_000, { s: 1, g: 2 })]).verdict.value, "consistent", "S1 and G2 are below the default thresholds");

  const fill = { id: "goes-proton-channels", status: "flag", reason: "newest >=10 MeV sample is a fill value", observedAt: iso(T) } as SenseCheck;
  const flaggedRec = build([point(T - 30_000, { checks: [fill] })]);
  assert.equal(flaggedRec.verdict.value, "degraded-context");
  assert.equal(flaggedRec.environment.radiation.confidence, "medium");
  assert.ok(flaggedRec.environment.radiation.limitations.some((l) => /Input check flagged/.test(l)));
});

test("trust record: every field carries source, product URL, observed and fetched times, age, confidence and limitations (GAU-57)", () => {
  const r = build([point(T - 30_000)], { ephemeris: { latDeg: 10, lonDeg: 20, altKm: 525 } });
  const fields = [...Object.entries(r.environment), ...Object.entries(r.orbit), ["upsetRisk", r.upsetRisk] as const];
  for (const [name, f] of fields) {
    for (const key of ["value", "source", "sourceUrl", "observedAt", "fetchedAt", "ageSeconds", "confidence", "method", "limitations"]) {
      assert.ok(key in f, `${name}.${key}`);
    }
    assert.ok(f.source.length > 0, `${name} names its source`);
    if (f.value === null) assert.ok(f.limitations.length > 0, `${name} says why it is unknown`);
  }
  for (const name of ["radiation", "geomagnetic", "radioBlackout", "particleFlux", "kp", "dst"] as const) {
    const f = r.environment[name];
    assert.match(f.sourceUrl ?? "", /^https:\/\/services\.swpc\.noaa\.gov\//, `${name} links its product`);
    assert.equal(f.fetchedAt, iso(T - 30_000), `${name} was held at the reading's issue time`);
    assert.ok(f.ageSeconds !== null && f.ageSeconds >= 0);
  }
  assert.equal(r.environment.radiation.ageSeconds, 330, "proton sample 5 min before issue, 30 s before the inference");
  assert.ok(r.limitations.length >= 4, "record-level limitations are always present");
});

test("trust record: no wording about harm to hardware or odds of error, in any record (GAU-57)", () => {
  const samples: TrustRecord[] = [
    build([]),
    build([point(T - 30_000)]),
    build([point(T - 30_000, { s: 4, g: 4, r: 3 })], { processorProfileId: "jetson-orin-nx-16", tle: ["1 25544U", "2 25544"] }),
  ];
  for (const r of samples) assert.deepEqual(bannedWording(r), []);
  assert.deepEqual(bannedWording({ ...samples[1], limitations: ["Expected dose is low"] }), ["dose"], "the check itself works");
  const customerSaid = build([point(T - 30_000)], { output: { label: "damaged panel" } });
  assert.equal((customerSaid.inference.output as { label: string }).label, "damaged panel", "the customer's own output is echoed, not scanned");
});

test("trust record: L-shell from the supplied ephemeris; SAA and upset risk say why they are unknown (GAU-57)", () => {
  // On the dipole equator L is just r / RE: the point 90° from the IGRF-14 2025 pole (80.8° N, 72.8° W).
  const equator = { latDeg: 80.8 - 90, lonDeg: -72.8, altKm: 500 };
  assert.ok(Math.abs(dipoleLShell(equator) - (RE_KM + 500) / RE_KM) < 1e-9);
  const r = build([point(T - 30_000)], { ephemeris: equator, processorProfileId: "jetson-orin-nx-16" });
  assert.equal(r.orbit.lShell.value, Math.round(((RE_KM + 500) / RE_KM) * 1000) / 1000);
  assert.equal(r.orbit.lShell.confidence, "medium");
  assert.equal(r.orbit.saa.value, null);
  assert.match(r.orbit.saa.limitations[0], /GAU-141/);
  assert.match(r.upsetRisk.limitations[0], /No cited radiation profile for processor "jetson-orin-nx-16"/);
  const badTle = build([point(T - 30_000)], { tle: ["1 x", "2 x"] });
  assert.match(badTle.orbit.lShell.limitations[0], /^TLE not usable: line 1 must be 69 characters/);
  const strict = buildTrustRecord(req(), new EnvironmentHistory([point(T - 30_000)], "h"), { nowMs: T, policy: { ...DEFAULT_POLICY, requireOrbitContext: true } });
  assert.equal(strict.verdict.value, "unknown", "a policy that requires orbit context gets unknown until it exists");
});

test("trust record: requests are validated, nothing defaulted; the future is unknown (GAU-57)", () => {
  assert.deepEqual(parseTrustRequest({ time: "yesterday", spacecraftId: "", modelId: "m", confidence: 2 }), {
    errors: ["time must be an ISO 8601 timestamp", "spacecraftId must be 1–128 characters", "confidence must be a number from 0 to 1"],
  });
  assert.match(String((parseTrustRequest({ ...req(), output: "x".repeat(5000) }) as { errors: string[] }).errors), /at most 4096 bytes/);
  assert.match(String((parseTrustRequest({ ...req(), ephemeris: { latDeg: 0, lonDeg: 0, altKm: 20 } }) as { errors: string[] }).errors), /altitude/);
  const ok = parseTrustRequest({ ...req(), time: "2026-01-19T18:30:00+08:00" });
  assert.ok("request" in ok);
  assert.equal(ok.request.time, "2026-01-19T10:30:00.000Z");
  const future = buildTrustRecord(req({ time: iso(T + 2 * 3_600_000) }), new EnvironmentHistory([point(T)], "h"), { nowMs: T });
  assert.equal(future.verdict.value, "unknown");
  assert.equal(future.verdict.reasons[0], "Inference time is in the future");
});

test("trust record: same inputs, same record and hash (GAU-57)", () => {
  const a = build([point(T - 30_000)]);
  const b = build([point(T - 30_000)]);
  assert.equal(a.hash, b.hash);
  assert.equal(a.recordId, b.recordId);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(build([point(T - 30_000, { s: 2 })]).hash, a.hash);
});

test("trust record: p95 well under 500 ms over a full day of 5 s history (GAU-57)", () => {
  const history = new EnvironmentHistory(Array.from({ length: 17_280 }, (_, i) => point(T - i * 5_000)), "day");
  const times: number[] = [];
  for (let i = 0; i < 500; i += 1) {
    const t0 = performance.now();
    buildTrustRecord(req({ time: iso(T - i * 97_000) }), history, { nowMs: T + 60_000 });
    times.push(performance.now() - t0);
  }
  times.sort((x, y) => x - y);
  const p95 = times[Math.floor(times.length * 0.95)];
  assert.ok(p95 < 500, `p95 ${p95.toFixed(2)} ms`);
});

test("trust record: through the replayed 19 Jan 2026 storm, S1 is consistent and S2 under G0 is degraded (GAU-57)", async () => {
  const points: CanonicalSpaceWeatherPoint[] = [];
  const archive = loadArchive(fileURLToPath(new URL("../replay/events/jan-2026.json.gz", import.meta.url)));
  await replayArchive(archive, { end: "2026-01-19T05:00:00Z", points });
  const history = new EnvironmentHistory(points, "replay jan-2026");
  const at = (time: string) => buildTrustRecord(req({ time }), history, { nowMs: Date.parse("2026-01-20T00:00:00Z") });
  const quiet = at("2026-01-19T02:10:30Z");
  assert.equal(quiet.environment.radiation.value?.label, "S1");
  assert.equal(quiet.verdict.value, "consistent");
  const radiationStorm = at("2026-01-19T04:50:30Z");
  assert.equal(radiationStorm.environment.radiation.value?.label, "S2");
  assert.equal(radiationStorm.environment.geomagnetic.value?.label, "G0");
  assert.equal(radiationStorm.verdict.value, "degraded-context");
  assert.equal(radiationStorm.environmentSource, "replay jan-2026");
});
