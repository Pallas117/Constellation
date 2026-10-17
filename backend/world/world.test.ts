import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import {
  adviseOnStormOnset,
  detectEvents,
  hypothesisFromForecast,
  observationsFromCanonical,
  reconstructState,
  resolveHypothesis,
  transition,
} from "./build.js";
import { verifyRecord } from "./ids.js";

const T0 = Date.parse("2026-10-16T00:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

function point(min: number, over: { kp?: number; bz?: number; stale?: boolean; dstMethod?: string; goes?: boolean } = {}): CanonicalSpaceWeatherPoint {
  return {
    timestamp: at(min),
    observedAt: at(min - 1),
    spacecraft: "DSCOVR",
    source: "fusion",
    rho: 5,
    velocity: { x: -450, y: 0, z: 0, magnitude: 450 },
    magneticField: { x: 2, y: 3, z: over.bz ?? -4, bt: 5.4 },
    electricField: { x: 0, y: 1.8, z: 0, ey: 1.8 },
    solarWind: { speed: 450, density: 5, dynamicPressure: 1.7 },
    indices: { kp: over.kp ?? 3, dst: -20, dstMethod: over.dstMethod ?? "model: O'Brien & McPherron (2000) ring-current", dstDerivedFrom: ["solarWind.speed"], kpKind: "estimated-1m", kpObservedAt: at(min - 1) },
    coupling: { newell: 4000, epsilon: 1e11 },
    propagation: { l1DelaySeconds: 3300, etaEarthArrival: at(min + 55) },
    alerts: { stormTier: "quiet", reason: "" },
    quality: { outlier: false, stale: over.stale ?? false, interpolated: false, extrapolated: false, lowConfidence: false, tier: over.stale ? 3 : 0 },
    particles: over.goes === false ? undefined : {
      protons: { value: 0.25, energy: ">=10 MeV", satellite: "GOES-18", timestamp: at(min - 5) },
      electrons: null,
    },
    uncertainty: {
      speed: { lower: 440, upper: 460, sigma: 5 },
      density: { lower: 4.5, upper: 5.5, sigma: 0.25 },
      bz: { lower: -4.5, upper: -3.5, sigma: 0.3 },
    },
  } as unknown as CanonicalSpaceWeatherPoint;
}

test("GAU-39: observations carry only measured values, with unit, frame, platform and evidence", () => {
  const obs = observationsFromCanonical(point(0));
  const vars = obs.map((o) => o.variable).sort();
  assert.deepEqual(vars, ["imf.bx", "imf.by", "imf.bz", "kp", "protons_10mev", "solar_wind.density", "solar_wind.speed"]);
  assert.ok(!vars.includes("dst"), "a modelled Dst is not an observation");
  assert.ok(!vars.includes("electrons_2mev"), "a missing channel is absent, not zero");
  const bz = obs.find((o) => o.variable === "imf.bz")!;
  assert.equal(bz.frame, "GSM");
  assert.equal(bz.unit, "nT");
  assert.equal(bz.platform, "DSCOVR");
  assert.deepEqual(bz.uncertainty, { sigma: 0.3, lower: -4.5, upper: -3.5 });
  assert.equal(bz.observedAt, at(-1), "time of measurement, not of ingest");
  const measuredDst = observationsFromCanonical(point(0, { dstMethod: "measured" })).find((o) => o.variable === "dst");
  assert.equal(measuredDst?.platform, "Kyoto WDC");
});

test("GAU-39: ids and checksums are deterministic, and tampering is detected", () => {
  const a = observationsFromCanonical(point(0));
  const b = observationsFromCanonical(point(0));
  assert.deepEqual(a.map((o) => o.id), b.map((o) => o.id), "same input, same ids");
  assert.notEqual(observationsFromCanonical(point(0, { bz: -5 })).find((o) => o.variable === "imf.bz")!.id,
    a.find((o) => o.variable === "imf.bz")!.id);
  for (const o of a) assert.deepEqual(verifyRecord(o), []);
  const tampered = { ...a[0], value: a[0].value + 1 };
  assert.deepEqual(verifyRecord(tampered), ["checksum does not match content", "id does not match content"]);
  assert.ok(verifyRecord({ ...a[0], unit: "furlongs" }).some((p) => p.startsWith("unit")), "schema validation");
});

test("GAU-39: state is reconstructed from a bounded window; stale and future observations are not used", () => {
  const obs = [...observationsFromCanonical(point(0)), ...observationsFromCanonical(point(10, { bz: -6 }))];
  const s = reconstructState(obs, at(10));
  assert.equal(s.variables["imf.bz"].value, -6, "newest wins");
  assert.equal(s.variables["imf.bz"].provenance, "measured");
  assert.deepEqual(s.variables["imf.bz"].derivedFrom.length, 1);
  assert.equal(reconstructState(obs, at(5)).variables["imf.bz"].value, -4, "an observation after `at` is not used");
  const late = reconstructState(obs, at(40));
  assert.equal(late.variables["imf.bz"].provenance, "unknown", "older than 15 min: unknown, not carried");
  assert.equal(late.variables["imf.bz"].value, null);
  assert.equal(late.variables.kp.provenance, "measured", "Kp keeps its 3.5 h window");
  const stale = reconstructState(observationsFromCanonical(point(0, { stale: true })), at(1));
  assert.ok(Object.values(stale.variables).every((v) => v.provenance === "unknown"), "stale observations are not measurements");
});

test("GAU-39: derived values carry method and inputs; unknown inputs give unknown, never a default", () => {
  const s = reconstructState(observationsFromCanonical(point(0)), at(0));
  const p = s.variables["solar_wind.dynamic_pressure"];
  assert.equal(p.provenance, "derived");
  assert.deepEqual(p.derivedFrom, ["solar_wind.density", "solar_wind.speed"]);
  assert.match(p.method, /1\.6726e-6/);
  assert.ok(Math.abs(p.value! - 1.6726e-6 * 5 * 450 * 450) < 1e-9);
  assert.equal(s.variables["electric_field.ey"].value, -450 * -4 * 1e-3);
  assert.equal(s.variables["coupling.newell"].provenance, "derived");
  const empty = reconstructState([], at(0));
  for (const name of ["solar_wind.dynamic_pressure", "coupling.newell", "electric_field.ey", "dst"]) {
    assert.equal(empty.variables[name].provenance, "unknown", name);
    assert.equal(empty.variables[name].value, null, name);
  }
});

test("GAU-39: reconstruction is order-independent and does not mutate its inputs", () => {
  const obs = [...observationsFromCanonical(point(0)), ...observationsFromCanonical(point(5))];
  const snapshot = JSON.stringify(obs);
  const a = reconstructState(obs, at(5));
  const b = reconstructState([...obs].reverse(), at(5));
  assert.equal(a.id, b.id);
  assert.equal(JSON.stringify(obs), snapshot, "inputs unchanged (operational data is read-only)");
});

test("GAU-39: replay of a storm gives identical records, an onset event, an advisory and a transition", () => {
  const run = () => {
    const kps = [3, 3.3, 4.3, 5.3, 6, 5.7];
    const obs = kps.flatMap((kp, i) => observationsFromCanonical(point(i * 5, { kp })));
    const states = kps.map((_, i) => reconstructState(obs, at(i * 5)));
    const events = states.slice(1).flatMap((s, i) => detectEvents(states[i], s));
    const transitions = states.slice(1).map((s, i) => transition(states[i], s, detectEvents(states[i], s)));
    return { states, events, transitions };
  };
  const r1 = run();
  const r2 = run();
  assert.deepEqual(r1.states.map((s) => s.id), r2.states.map((s) => s.id), "replay is deterministic");
  assert.deepEqual(r1.events.map((e) => e.type), ["storm-onset"]);
  const onset = r1.events[0];
  assert.equal(onset.at, at(15));
  const action = adviseOnStormOnset(onset)!;
  assert.equal(action.authority, "advisory");
  assert.deepEqual(action.rationale, [onset.id]);
  const { delta, transition: tr } = r1.transitions[2];
  assert.equal(delta.changes.kp.to, 5.3);
  assert.deepEqual(tr.associated, [onset.id]);
  for (const rec of [...r1.states, ...r1.events, action, delta, tr]) assert.deepEqual(verifyRecord(rec), [], rec.kind);
});

test("GAU-39: a lost source becomes a source-lost event, not silently carried", () => {
  const live = reconstructState(observationsFromCanonical(point(0, { goes: false })), at(0));
  const later = reconstructState(observationsFromCanonical(point(0, { goes: false })), at(20));
  const types = detectEvents(live, later).map((e) => `${e.type}:${e.rule.split(" ")[0]}`);
  assert.ok(types.includes("source-lost:imf.bz"));
  assert.ok(!types.some((t) => t.endsWith(":kp")), "Kp is still within its window");
});

test("GAU-39: a forecast is a hypothesis resolved against observed state", () => {
  const obsLater = observationsFromCanonical(point(180, { kp: 5.3 }));
  const state = reconstructState(obsLater, at(180));
  const h = hypothesisFromForecast({ issuedAt: at(0), horizonHours: 3, variable: "kp", predicted: 5, tolerance: 0.67, method: "kp3h-mlp-v1-87236383", basedOn: ["st_0123456789abcdef"] });
  assert.equal(h.status, "open");
  assert.equal(resolveHypothesis(h, reconstructState(obsLater, at(60))).status, "open", "not yet due");
  const resolved = resolveHypothesis(h, state);
  assert.equal(resolved.status, "supported");
  assert.equal(resolved.resolution?.observed, 5.3);
  assert.notEqual(resolved.id, h.id, "resolution is a new sealed record");
  assert.deepEqual(verifyRecord(resolved), []);
  assert.equal(resolveHypothesis({ ...h, predicted: 2 } as typeof h, state).status, "refuted");
  assert.equal(resolveHypothesis(h, reconstructState([], at(180))).status, "unresolvable", "no measurement, no verdict");
});

test("GAU-39: live world state uses only the needed window of the feed, newest first", async () => {
  const { worldStateFromFeed } = await import("./build.js");
  // 6 h of 5 s points (4320); only the last 3.5 h at one per minute should be read.
  const feed = Array.from({ length: 4320 }, (_, i) => point(-360 + i / 12, { kp: i > 4000 ? 5.3 : 3 }));
  const { state, observations } = worldStateFromFeed(feed, at(0));
  assert.equal(state.variables.kp.value, 5.3, "the newest measurement");
  assert.ok(observations.length <= 211 * 7, `bounded: ${observations.length} observations`);
  assert.equal(state.variables["imf.bz"].provenance, "measured");
});
