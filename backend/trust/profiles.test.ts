import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import { EnvironmentHistory } from "./environment.js";
import { findProfile, PROFILE_LIBRARY_VERSION, PROFILES, profileProblem, type ProcessorProfile } from "./profiles.js";
import { bannedWording, buildTrustRecord } from "./record.js";
import { SEP_OPEN_L, SEP_SHIELDED_L, upsetBand, upsetRiskField, type UpsetContext, type UpsetInput } from "./upset.js";

const level = (n: number | null, ageSeconds = 330): UpsetInput => ({ level: n, why: "test reading", observedAt: "2026-01-19T18:24:30.000Z", ageSeconds });
const quiet: UpsetContext = { saaTier: "outside", saaWhy: "", s: level(0), g: level(0, 5_400), lShell: 1.2 };
const FETCHED = "2026-01-19T18:29:30.000Z";

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
        if (r.fluence !== null) assert.ok(r.fluence > 1e6, `${p.id} ${r.effect} fluence in p/cm²`);
        assert.ok(r.observed.length > 5 && r.condition.length > 3 && r.events.length > 0, `${p.id} ${r.effect} says what was counted, where, and on how many events`);
      }
      const keys = c.results.map((r) => `${r.effect} @ ${r.condition}`);
      assert.equal(new Set(keys).size, keys.length, `${p.id}: one figure per effect class and condition, never merged`);
    }
  }
});

/** P(X ≤ n) for a Poisson mean λ. */
const poissonCdf = (n: number, lambda: number) => {
  let term = Math.exp(-lambda);
  let sum = term;
  for (let k = 1; k <= n; k++) {
    term *= lambda / k;
    sum += term;
  }
  return sum;
};
/** Exact (Garwood) 95% interval on a Poisson count n, by bisection. */
function garwood(n: number): [number, number] {
  const solve = (f: (l: number) => number) => {
    let lo = 0;
    let hi = 4 * n + 20;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) > 0) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };
  const lower = n === 0 ? 0 : solve((l) => 1 - poissonCdf(n - 1, l) - 0.025); // P(X ≥ n) rises with λ
  const upper = solve((l) => 0.025 - poissonCdf(n, l)); // P(X ≤ n) falls with λ
  return [lower, upper];
}

test("profiles: Gauss's own checks of the Orin NX tables hold (GAU-58)", () => {
  assert.deepEqual(garwood(3).map((x) => +x.toFixed(3)), [0.619, 8.767], "textbook interval for 3 events");
  const orin = findProfile("nvidia-jetson-orin-nx")!.campaigns[0].results;
  const counts = orin.map((r) => r.value * r.fluence!);
  // σ is printed to 3 significant figures, so allow about 0.2% of the count.
  for (const n of counts) assert.ok(Math.abs(n - Math.round(n)) <= 0.002 * n + 0.03, `σ × fluence ${n.toFixed(3)} is a whole event count`);
  assert.deepEqual(counts.map(Math.round), [22, 38, 11, 9, 13, 3, 64, 7, 12, 13]);
  for (const r of orin) assert.ok(r.events.includes(`= ${Math.round(r.value * r.fluence!)} events`), `${r.condition} ${r.effect} states its count`);
  // The SoC rows and the CPU/GPU rows are the same events split two ways.
  const sum = (effect: string, soc: boolean) => counts.filter((_, i) => orin[i].effect === effect && orin[i].condition.startsWith("SoC") === soc).reduce((a, b) => a + Math.round(b), 0);
  assert.equal(sum("SEU", true), 71);
  assert.equal(sum("SEU", false), 71);
  assert.equal(sum("SEFI", true), 25);
  assert.equal(sum("SEFI", false), 25);
  for (const r of orin) {
    const n = Math.round(r.value * r.fluence!);
    const exception = r.effect === "SEFI" && r.condition.startsWith("CPU");
    const [lo, hi] = garwood(exception ? 14 : n).map((x) => x / r.fluence!);
    assert.ok(Math.abs(r.range!.low / lo - 1) < 0.01 && Math.abs(r.range!.high / hi - 1) < 0.01, `${r.condition} ${r.effect}: printed bounds are the 95% interval for ${exception ? 14 : n} events`);
    assert.match(r.range!.basis, exception ? /interval for 14/ : /exact 95% Poisson interval/);
  }
  const [lo12, hi12] = garwood(12).map((x) => x / 1.99e10);
  assert.equal(lo12.toPrecision(3), "3.12e-10");
  assert.equal(hi12.toPrecision(3), "1.05e-9");
});

test("profiles: a profile without a cited source, or without proton data, is never used (GAU-58)", () => {
  const base = PROFILES[0];
  const uncited: ProcessorProfile = { ...base, id: "uncited", campaigns: base.campaigns.map((c) => ({ ...c, url: "" })) };
  assert.match(profileProblem(uncited)!, /has no cited test source/);
  const r = upsetRiskField("uncited", { ...quiet, saaTier: "core" }, FETCHED, [uncited]);
  assert.equal(r.value, null);
  assert.equal(r.confidence, "none");
  assert.match(r.limitations[0], /Profile "uncited" has no cited test source, so it is not used/);

  const heavyIonOnly: ProcessorProfile = { ...base, id: "ions-only", campaigns: base.campaigns.map((c) => ({ ...c, particle: "heavy-ion" as const })) };
  assert.match(upsetRiskField("ions-only", quiet, FETCHED, [heavyIonOnly]).limitations[0], /no cited proton test result/);
});

test("profiles: an unknown profile id gives unknown with the known ids, not an error (GAU-58)", () => {
  const r = upsetRiskField("jetson-orin-nx-16", quiet, FETCHED);
  assert.equal(r.value, null);
  assert.match(r.limitations[0], new RegExp(`No cited radiation profile for processor "jetson-orin-nx-16" in ${PROFILE_LIBRARY_VERSION.replace(/[./]/g, "\\$&")}; known profiles: nvidia-jetson-tx2`));
  assert.match(upsetRiskField(null, quiet, FETCHED).limitations[0], /No processor profile given/);
});

test("upset band: trapped protons by SAA tier, solar protons by S-level where the L-shell lets them in (GAU-58)", () => {
  assert.equal(SEP_OPEN_L, 3);
  assert.equal(SEP_SHIELDED_L, 1.55);
  const band = (c: Partial<UpsetContext>) => {
    const r = upsetBand({ ...quiet, ...c });
    return "unknown" in r ? `unknown: ${r.unknown}` : r.band;
  };
  const middle = 2.3; // between SEP_SHIELDED_L and SEP_OPEN_L
  assert.equal(band({}), "baseline");
  assert.equal(band({ saaTier: "extended" }), "elevated");
  assert.equal(band({ saaTier: "core" }), "high");
  // Open at and above SEP_OPEN_L.
  assert.equal(band({ s: level(1), lShell: SEP_OPEN_L }), "elevated");
  assert.equal(band({ s: level(2), lShell: 6 }), "elevated");
  assert.equal(band({ s: level(3), lShell: 6 }), "high");
  // Shielded below SEP_SHIELDED_L, whatever the storm.
  assert.equal(band({ s: level(5), g: level(5), lShell: SEP_SHIELDED_L - 0.01 }), "baseline");
  // In between: only S3+ counts without a geomagnetic storm; a storm opens it.
  assert.equal(band({ s: level(2), lShell: middle }), "baseline");
  assert.equal(band({ s: level(3), lShell: middle }), "elevated");
  assert.equal(band({ s: level(2), g: level(1), lShell: middle }), "elevated");
  assert.equal(band({ s: level(4), g: level(3), lShell: middle }), "high");
  // Highest driver wins.
  assert.equal(band({ saaTier: "core", s: level(1), lShell: 5 }), "high");
  // Unknown inputs are never read as quiet.
  assert.match(band({ saaTier: null, saaWhy: "not applied at 520 km" }), /^unknown: Trapped-proton context unknown: not applied at 520 km/);
  assert.match(band({ s: { ...level(null), why: "Reading was older than 30 min" } }), /^unknown: Solar-proton level unknown: Reading was older than 30 min/);
  assert.match(band({ s: level(1), g: level(null), lShell: middle }), /^unknown: Geomagnetic level unknown, needed to judge solar-proton access at centred-dipole L 2\.30/);
  assert.equal(band({ s: level(0), g: level(null), lShell: middle }), "baseline", "G is only needed when solar protons are up");

  const shielded = upsetBand({ ...quiet, s: level(3), lShell: 1.1 });
  assert.ok(!("unknown" in shielded) && /taken to shield this position/.test(shielded.notes[0]));
});

test("upset band: a cited profile gives a low-confidence band with its citation, effects, uncertainty and input age (GAU-58)", () => {
  const r = upsetRiskField("nvidia-jetson-tx2", { ...quiet, saaTier: "core" }, FETCHED);
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
  assert.equal(r.fetchedAt, FETCHED);
  assert.equal(r.ageSeconds, 330, "the S reading's age: G was not needed");
  assert.ok(r.limitations.some((l) => /Baseline means no modelled driver raised the rate/.test(l)));
  assert.ok(r.limitations.some((l) => /Gauss heuristics/.test(l)));
  // The middle zone needs G, so the band is as old as the G reading.
  assert.equal(upsetRiskField("nvidia-jetson-tx2", { ...quiet, s: level(2), lShell: 2.5 }, FETCHED).ageSeconds, 5_400);

  const xavier = upsetRiskField("nvidia-jetson-xavier-nx", quiet, FETCHED);
  assert.deepEqual(xavier.value?.effects, ["SEU", "SEFI"]);
  assert.equal(xavier.value?.band, "baseline");
  assert.match(xavier.value!.uncertainty, /SoC under a collimated beam/);
});

test("upset band in the trust record: SAA core, an ISS-type pass south of Australia, no banned wording for any profile (GAU-58)", () => {
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
  assert.equal(inSaa.upsetRisk.ageSeconds, 330);
  // 51.6° S 150° E: centred-dipole L 3.76 where the IGRF-14 field-line L is 4.99 (review, 2026-10-25).
  // S1 with no storm must not read baseline there.
  const southOfAustralia = record("nvidia-jetson-orin-nx", { latDeg: -51.6, lonDeg: 150, altKm: 420 }, 1, 0);
  assert.equal(southOfAustralia.orbit.saa.value, false);
  assert.ok(southOfAustralia.orbit.lShell.value! > SEP_OPEN_L && southOfAustralia.orbit.lShell.value! < 4);
  assert.equal(southOfAustralia.upsetRisk.value?.band, "elevated");
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

test("banned wording: the wider list catches fitness, absorbed-radiation and compliance words, not the record's own disclaimers (GAU-58)", () => {
  const T = Date.parse("2026-01-19T18:30:00Z");
  const base = buildTrustRecord({ time: new Date(T).toISOString(), spacecraftId: "sc-1", modelId: "m-1" }, new EnvironmentHistory([], "empty"), { nowMs: T });
  assert.deepEqual(bannedWording(base), [], "RECORD_LIMITATIONS (\"No regulatory or compliance claim is made.\") is allowed");
  for (const phrase of ["suitable for LEO", "rad-hard part", "12 krad", "0.5 Gy", "1 rad(Si)", "certification pending", "will survive", "damaging"]) {
    assert.equal(bannedWording({ ...base, limitations: [phrase] }).length, 1, phrase);
  }
  for (const phrase of ["radiation storm S2", "Gauss nowcast", "SoC under a collimated beam"]) {
    assert.deepEqual(bannedWording({ ...base, limitations: [phrase] }), [], phrase);
  }
});
