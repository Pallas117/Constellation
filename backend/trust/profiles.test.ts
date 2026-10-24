import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import { EnvironmentHistory } from "./environment.js";
import { PROFILE_LIBRARY_VERSION, PROFILES, profileProblem, type ProcessorProfile } from "./profiles.js";
import { bannedWording, buildTrustRecord } from "./record.js";
import { SEP_OPEN_L, SEP_SHIELDED_L, upsetBand, upsetRiskField, type UpsetContext } from "./upset.js";

const quiet: UpsetContext = { saaTier: "outside", saaWhy: "", sLevel: 0, sWhy: "", gLevel: 0, gWhy: "", lShell: 1.2 };
const at = { time: "2026-01-19T18:30:00.000Z", fetchedAt: "2026-01-19T18:29:30.000Z" };

test("profiles: every profile is cited, with facility, particle, energy, units and separate effect classes (GAU-58)", () => {
  assert.match(PROFILE_LIBRARY_VERSION, /^gauss\.processor-profiles\/\d+\.\d+$/);
  assert.ok(PROFILES.length >= 2, "at least two profiles");
  assert.equal(new Set(PROFILES.map((p) => p.id)).size, PROFILES.length, "ids are unique");
  for (const p of PROFILES) {
    assert.match(p.id, /^[a-z0-9-]{1,128}$/);
    assert.ok(Number.isInteger(p.version) && p.version >= 1, `${p.id} version`);
    assert.equal(profileProblem(p), null, `${p.id} is usable`);
    for (const c of p.campaigns) {
      assert.match(c.url, /^https:\/\/(doi\.org\/10\.|ntrs\.nasa\.gov\/citations\/)/, `${p.id} cites a DOI or NASA report`);
      assert.ok(c.citation.length > 20 && c.facility.length > 5 && c.dut.length > 3, `${p.id} names source, facility and part`);
      assert.ok(c.energyMeV > 0, `${p.id} energy`);
      assert.ok(c.results.length > 0, `${p.id} has results`);
      for (const r of c.results) {
        assert.ok(["SEU", "SEFI", "SDC"].includes(r.effect), `${p.id} effect class`);
        assert.ok(r.unit === "cm²/device" || r.unit === "cm²/bit", `${p.id} unit stated`);
        assert.ok(Number.isFinite(r.value) && r.value > 0 && r.value < 1, `${p.id} ${r.effect} is a cross-section in cm²`);
        if (r.range) assert.ok(r.range.low <= r.value && r.value <= r.range.high && r.range.basis.length > 0, `${p.id} ${r.effect} range holds the value`);
        assert.ok(r.observed.length > 5 && r.condition.length > 3 && r.events.length > 0, `${p.id} ${r.effect} says what was counted, where, and on how many events`);
      }
      const keys = c.results.map((r) => `${r.effect} @ ${r.condition}`);
      assert.equal(new Set(keys).size, keys.length, `${p.id}: one figure per effect class and condition, never merged`);
    }
  }
});

test("profiles: a profile without a cited source, or without proton data, is never used (GAU-58)", () => {
  const base = PROFILES[0];
  const uncited: ProcessorProfile = { ...base, id: "uncited", campaigns: base.campaigns.map((c) => ({ ...c, url: "" })) };
  assert.match(profileProblem(uncited)!, /has no cited test source/);
  const r = upsetRiskField("uncited", { ...quiet, saaTier: "core" }, at, [uncited]);
  assert.equal(r.value, null);
  assert.equal(r.confidence, "none");
  assert.match(r.limitations[0], /Profile "uncited" has no cited test source, so it is not used/);

  const heavyIonOnly: ProcessorProfile = { ...base, id: "ions-only", campaigns: base.campaigns.map((c) => ({ ...c, particle: "heavy-ion" as const })) };
  assert.match(upsetRiskField("ions-only", quiet, at, [heavyIonOnly]).limitations[0], /no cited proton test result/);
});

test("profiles: an unknown profile id gives unknown with the known ids, not an error (GAU-58)", () => {
  const r = upsetRiskField("jetson-orin-nx-16", quiet, at);
  assert.equal(r.value, null);
  assert.match(r.limitations[0], new RegExp(`No cited radiation profile for processor "jetson-orin-nx-16" in ${PROFILE_LIBRARY_VERSION.replace(/[./]/g, "\\$&")}; known profiles: nvidia-jetson-tx2`));
  assert.match(upsetRiskField(null, quiet, at).limitations[0], /No processor profile given/);
});

test("upset band: trapped protons by SAA tier, solar protons by S-level where the L-shell lets them in (GAU-58)", () => {
  const band = (c: Partial<UpsetContext>) => {
    const r = upsetBand({ ...quiet, ...c });
    return "unknown" in r ? `unknown: ${r.unknown}` : r.band;
  };
  assert.equal(band({}), "baseline");
  assert.equal(band({ saaTier: "extended" }), "elevated");
  assert.equal(band({ saaTier: "core" }), "high");
  // Open access at and above SEP_OPEN_L.
  assert.equal(band({ sLevel: 1, lShell: SEP_OPEN_L }), "elevated");
  assert.equal(band({ sLevel: 2, lShell: 6 }), "elevated");
  assert.equal(band({ sLevel: 3, lShell: 6 }), "high");
  // Shielded below SEP_SHIELDED_L, whatever the storm.
  assert.equal(band({ sLevel: 5, gLevel: 5, lShell: SEP_SHIELDED_L - 0.01 }), "baseline");
  // In between: only S3+ counts without a geomagnetic storm; a storm opens it.
  assert.equal(band({ sLevel: 2, lShell: 3 }), "baseline");
  assert.equal(band({ sLevel: 3, lShell: 3 }), "elevated");
  assert.equal(band({ sLevel: 2, gLevel: 1, lShell: 3 }), "elevated");
  assert.equal(band({ sLevel: 4, gLevel: 3, lShell: 3 }), "high");
  // Highest driver wins.
  assert.equal(band({ saaTier: "core", sLevel: 1, lShell: 5 }), "high");
  // Unknown inputs are never read as quiet.
  assert.match(band({ saaTier: null, saaWhy: "not applied at 520 km" }), /^unknown: Trapped-proton context unknown: not applied at 520 km/);
  assert.match(band({ sLevel: null, sWhy: "Reading was older than 30 min" }), /^unknown: Solar-proton level unknown/);
  assert.match(band({ sLevel: 1, gLevel: null, gWhy: "No current reading", lShell: 3 }), /^unknown: Geomagnetic level unknown, needed to judge solar-proton access at L 3\.00/);
  assert.equal(band({ sLevel: 0, gLevel: null, lShell: 3 }), "baseline", "G is only needed when solar protons are up");

  const shielded = upsetBand({ ...quiet, sLevel: 3, lShell: 1.1 });
  assert.ok(!("unknown" in shielded) && /shields this position/.test(shielded.notes[0]));
});

test("upset band: a cited profile gives a low-confidence band with its citation, effects and uncertainty (GAU-58)", () => {
  const r = upsetRiskField("nvidia-jetson-tx2", { ...quiet, saaTier: "core" }, at);
  assert.equal(r.value?.band, "high");
  assert.deepEqual(r.value?.drivers, ["inside the South Atlantic Anomaly core (trapped protons)"]);
  assert.deepEqual(r.value?.effects, ["SEFI"]);
  assert.equal(r.value?.profileVersion, 1);
  assert.equal(r.value?.profileLibrary, PROFILE_LIBRARY_VERSION);
  assert.match(r.value!.uncertainty, /^Ordinal band, not a computed rate/);
  assert.match(r.value!.uncertainty, /one proton energy \(200 MeV\)/);
  assert.equal(r.confidence, "low");
  assert.equal(r.sourceUrl, "https://ntrs.nasa.gov/citations/20190031856");
  assert.match(r.source, /Massachusetts General Hospital.*200 MeV protons/);
  assert.equal(r.observedAt, at.time);
  assert.equal(r.fetchedAt, at.fetchedAt);
  assert.ok(r.limitations.some((l) => /quiet space weather/.test(l)));
  const xavier = upsetRiskField("nvidia-jetson-xavier-nx", quiet, at);
  assert.deepEqual(xavier.value?.effects, ["SEU", "SEFI"]);
  assert.equal(xavier.value?.band, "baseline");
});

test("upset band in the trust record: ISS-like pass through the SAA core, no banned wording for any profile (GAU-58)", () => {
  const T = Date.parse("2026-01-19T18:30:00Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const pointAt = (s: number, g: number) =>
    ({
      timestamp: iso(T - 30_000),
      observedAt: iso(T - 90_000),
      alerts: {
        stormTier: "quiet",
        reason: "",
        radiation: { level: s, label: `S${s}`, basis: "GOES >=10 MeV protons", observedAt: iso(T - 330_000) },
        geomagnetic: { level: g, label: `G${g}`, basis: "Kp", observedAt: iso(T - 3_600_000) },
        radioBlackout: { level: 0, label: "R0", basis: "X-rays", observedAt: iso(T - 60_000) },
      },
      particles: { protons: { value: 0.3, energy: ">=10 MeV", satellite: "GOES-18", timestamp: iso(T - 330_000) }, electrons: null },
      indices: { kp: 2, dst: -10, dstMethod: "measured", dstDerivedFrom: [], kpKind: "planetary-3h", kpObservedAt: iso(T - 3_600_000), dstObservedAt: iso(T - 1_800_000) },
      quality: { outlier: false, stale: false, interpolated: false, extrapolated: false, lowConfidence: false, tier: 0 },
      senseChecks: [],
    }) as unknown as CanonicalSpaceWeatherPoint;
  const record = (profileId: string, ephemeris: { latDeg: number; lonDeg: number; altKm: number }, s = 0, g = 0) =>
    buildTrustRecord(
      { time: iso(T), spacecraftId: "sc-1", modelId: "m-1", processorProfileId: profileId, ephemeris },
      new EnvironmentHistory([pointAt(s, g)], "test history"),
      { nowMs: T + 3_600_000 },
    );
  const inSaa = record("nvidia-jetson-tx2", { latDeg: -30, lonDeg: -45, altKm: 420 });
  assert.equal(inSaa.orbit.saa.value, true);
  assert.equal(inSaa.upsetRisk.value?.band, "high");
  assert.equal(inSaa.upsetRisk.fetchedAt, iso(T - 30_000));
  const above = record("nvidia-jetson-tx2", { latDeg: -30, lonDeg: -45, altKm: 520 });
  assert.equal(above.upsetRisk.value, null, "no SAA tier at 520 km, so no band");
  assert.match(above.upsetRisk.limitations[0], /^Trapped-proton context unknown: The B thresholds were set at about 320–390 km/);
  for (const p of PROFILES) {
    for (const [e, s, g] of [
      [{ latDeg: -30, lonDeg: -45, altKm: 420 }, 0, 0],
      [{ latDeg: 51, lonDeg: 100, altKm: 420 }, 3, 2],
      [{ latDeg: 0, lonDeg: 100, altKm: 420 }, 2, 0],
    ] as const) {
      const r = record(p.id, e, s, g);
      assert.notEqual(r.upsetRisk.value, null, `${p.id} gives a band`);
      assert.deepEqual(bannedWording(r), [], `${p.id}: no banned wording`);
    }
  }
});
