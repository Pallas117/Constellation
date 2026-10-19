/**
 * Build world records from the operational pipeline (GAU-39). Pure functions: inputs are never
 * mutated and nothing is written back into the ingest pipeline.
 */
import { dynamicPressureNpa, newellCoupling } from "../physics/mhd-nowcast.js";
import type { CanonicalSpaceWeatherPoint } from "../types.js";
import {
  SCHEMA_VERSION,
  type AdvisoryAction,
  type Hypothesis,
  type Observation,
  type StateDelta,
  type StateSnapshot,
  type StateValue,
  type Transition,
  type Unit,
  type Frame,
  type WorldEvent,
} from "./contracts.js";
import { seal } from "./ids.js";

/** Kp 5- and above (SWPC G1), matching ml/kp_model.py STORM_KP. */
export const STORM_KP = 4.65;
/** Default window: the GAU-15 freshness bound. */
export const DEFAULT_MAX_AGE_MS = 15 * 60_000;
/** Per-variable windows where a quantity is published less often than the 15 min bound. */
export const VARIABLE_MAX_AGE_MS: Record<string, number> = {
  kp: 3.5 * 3_600_000, // planetary Kp is 3-hourly and can lag up to 3 h
  dst: 2 * 3_600_000, // hourly Kyoto quicklook (GAU-116)
  protons_10mev: 30 * 60_000, // GOES 5-min, expired at 30 min (GAU-112)
  electrons_2mev: 30 * 60_000,
};

const MEASURED_VARIABLES: Array<{ variable: string; unit: Unit; frame: Frame; system: string }> = [
  { variable: "imf.bx", unit: "nT", frame: "GSM", system: "SOLAR_WIND" },
  { variable: "imf.by", unit: "nT", frame: "GSM", system: "SOLAR_WIND" },
  { variable: "imf.bz", unit: "nT", frame: "GSM", system: "SOLAR_WIND" },
  { variable: "solar_wind.speed", unit: "km/s", frame: "none", system: "SOLAR_WIND" },
  { variable: "solar_wind.density", unit: "cm^-3", frame: "none", system: "SOLAR_WIND" },
  { variable: "kp", unit: "kp", frame: "none", system: "MAGNETOSPHERE" },
  { variable: "dst", unit: "nT", frame: "none", system: "RING_CURRENT" },
  { variable: "protons_10mev", unit: "pfu", frame: "none", system: "GEO_ENVIRONMENT" },
  { variable: "electrons_2mev", unit: "particles/(cm^2 s sr)", frame: "none", system: "VAN_ALLEN_BELTS" },
];
const SPEC = Object.fromEntries(MEASURED_VARIABLES.map((v) => [v.variable, v]));

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const iso = (t: string | null | undefined) => (t && Number.isFinite(Date.parse(t)) ? new Date(Date.parse(t)).toISOString() : null);

/**
 * Observations for the measured quantities in one canonical point. Derived quantities (pressure,
 * coupling, model Dst) are not observations; they appear in state with their method.
 */
export function observationsFromCanonical(point: CanonicalSpaceWeatherPoint): Observation[] {
  const canonicalTimestamp = iso(point.timestamp);
  if (!canonicalTimestamp) return [];
  const l1At = iso(point.observedAt) ?? canonicalTimestamp;
  const quality = {
    tier: point.quality?.tier ?? 3,
    stale: point.quality?.stale ?? true,
    lowConfidence: point.quality?.lowConfidence ?? true,
    interpolated: point.quality?.interpolated ?? false,
    extrapolated: point.quality?.extrapolated ?? false,
  };
  const evidence = { canonicalTimestamp, ingestSource: String(point.source) };
  const env = (e?: { sigma: number; lower: number; upper: number }) =>
    e && [e.sigma, e.lower, e.upper].every(isNum) && e.sigma >= 0 ? { sigma: e.sigma, lower: e.lower, upper: e.upper } : null;

  const raw: Array<{ variable: string; value: unknown; observedAt: string | null; source: string; platform: string; uncertainty: Observation["uncertainty"] }> = [
    { variable: "imf.bx", value: point.magneticField?.x, observedAt: l1At, source: "noaa-swpc", platform: point.spacecraft ?? "L1", uncertainty: null },
    { variable: "imf.by", value: point.magneticField?.y, observedAt: l1At, source: "noaa-swpc", platform: point.spacecraft ?? "L1", uncertainty: null },
    { variable: "imf.bz", value: point.magneticField?.z, observedAt: l1At, source: "noaa-swpc", platform: point.spacecraft ?? "L1", uncertainty: env(point.uncertainty?.bz) },
    { variable: "solar_wind.speed", value: point.solarWind?.speed, observedAt: l1At, source: "noaa-swpc", platform: point.spacecraft ?? "L1", uncertainty: env(point.uncertainty?.speed) },
    { variable: "solar_wind.density", value: point.solarWind?.density, observedAt: l1At, source: "noaa-swpc", platform: point.spacecraft ?? "L1", uncertainty: env(point.uncertainty?.density) },
    { variable: "kp", value: point.indices?.kp, observedAt: iso(point.indices?.kpObservedAt) ?? l1At, source: "noaa-swpc", platform: point.indices?.kpKind === "planetary-3h" ? "NOAA planetary Kp" : "NOAA estimated Kp", uncertainty: null },
  ];
  // Dst is an observation only when measured (Kyoto, GAU-116); a modelled Dst is derived state.
  if (point.indices?.dstMethod === "measured") {
    raw.push({ variable: "dst", value: point.indices.dst, observedAt: l1At, source: "kyoto-dst", platform: "Kyoto WDC", uncertainty: null });
  }
  for (const [variable, reading] of [["protons_10mev", point.particles?.protons], ["electrons_2mev", point.particles?.electrons]] as const) {
    if (reading) raw.push({ variable, value: reading.value, observedAt: iso(reading.timestamp), source: "goes-swpc", platform: reading.satellite ?? "GOES", uncertainty: null });
  }

  const out: Observation[] = [];
  for (const r of raw) {
    if (!isNum(r.value) || !r.observedAt) continue; // missing is absent, never a default
    const spec = SPEC[r.variable];
    out.push(seal({
      kind: "observation" as const, schema: SCHEMA_VERSION, variable: r.variable, system: spec.system,
      value: r.value, unit: spec.unit, frame: spec.frame, uncertainty: r.uncertainty, observedAt: r.observedAt,
      source: r.source, platform: r.platform, quality, evidence,
    }) as Observation);
  }
  return out;
}

const unknown = (unit: Unit, frame: Frame = "none"): StateValue => ({
  value: null, unit, frame, provenance: "unknown", observedAt: null, derivedFrom: [], method: "unknown", uncertainty: null,
});

/**
 * State at `at` from a bounded observation sequence: for each measured variable, the newest
 * non-stale observation within its age window and not after `at`. Missing → unknown. Derived
 * variables are computed only from known inputs and record what they were derived from.
 */
export function reconstructState(observations: readonly Observation[], at: string, maxAgeMs = DEFAULT_MAX_AGE_MS): StateSnapshot {
  const atMs = Date.parse(at);
  const atIso = new Date(atMs).toISOString();
  const best = new Map<string, Observation>();
  for (const o of observations) {
    if (o.quality.stale || o.quality.tier === 3) continue;
    const t = Date.parse(o.observedAt);
    const window = VARIABLE_MAX_AGE_MS[o.variable] ?? maxAgeMs;
    if (t > atMs || atMs - t > window) continue;
    const prev = best.get(o.variable);
    // Newest wins; ties broken by id so the result is order-independent.
    if (!prev || t > Date.parse(prev.observedAt) || (t === Date.parse(prev.observedAt) && o.id < prev.id)) best.set(o.variable, o);
  }

  const variables: Record<string, StateValue> = {};
  for (const spec of MEASURED_VARIABLES) {
    const o = best.get(spec.variable);
    variables[spec.variable] = o
      ? { value: o.value, unit: o.unit, frame: o.frame, provenance: "measured", observedAt: o.observedAt, derivedFrom: [o.id], method: "measured", uncertainty: o.uncertainty }
      : unknown(spec.unit, spec.frame);
  }

  const v = (name: string) => variables[name];
  const known = (...names: string[]) => names.every((n) => v(n).provenance !== "unknown");
  const oldest = (...names: string[]) => names.map((n) => v(n).observedAt!).sort()[0];
  const derive = (unit: Unit, value: number, inputs: string[], method: string): StateValue => ({
    value, unit, frame: "none", provenance: "derived", observedAt: oldest(...inputs), derivedFrom: inputs, method, uncertainty: null,
  });

  variables["solar_wind.dynamic_pressure"] = known("solar_wind.density", "solar_wind.speed")
    ? derive("nPa", dynamicPressureNpa(v("solar_wind.density").value!, v("solar_wind.speed").value!), ["solar_wind.density", "solar_wind.speed"], "1.6726e-6·n·v² (proton mass, nPa)")
    : unknown("nPa");
  if (known("solar_wind.speed", "imf.bx", "imf.by", "imf.bz")) {
    const [bx, by, bz] = ["imf.bx", "imf.by", "imf.bz"].map((n) => v(n).value!);
    variables["coupling.newell"] = derive("ratio", newellCoupling(v("solar_wind.speed").value!, Math.hypot(bx, by, bz), by, bz),
      ["solar_wind.speed", "imf.bx", "imf.by", "imf.bz"], "Newell et al. 2007: v^4/3 Bt^2/3 sin^8/3(θ/2)");
  } else {
    variables["coupling.newell"] = unknown("ratio");
  }
  variables["electric_field.ey"] = known("solar_wind.speed", "imf.bz")
    ? derive("mV/m", -v("solar_wind.speed").value! * v("imf.bz").value! * 1e-3, ["solar_wind.speed", "imf.bz"], "Ey = -v·Bz (GSM), mV/m")
    : unknown("mV/m");

  const observationIds = [...best.values()].map((o) => o.id).sort();
  return seal({ kind: "state" as const, schema: SCHEMA_VERSION, at: atIso, maxAgeMs, variables, observationIds }) as StateSnapshot;
}

export function diffStates(a: StateSnapshot, b: StateSnapshot): StateDelta {
  const changes: StateDelta["changes"] = {};
  for (const name of [...new Set([...Object.keys(a.variables), ...Object.keys(b.variables)])].sort()) {
    const x = a.variables[name];
    const y = b.variables[name];
    if (x?.value !== y?.value || x?.provenance !== y?.provenance) {
      changes[name] = { from: x?.value ?? null, to: y?.value ?? null, provenance: y?.provenance ?? "unknown" };
    }
  }
  return seal({ kind: "delta" as const, schema: SCHEMA_VERSION, fromState: a.id, toState: b.id, changes }) as StateDelta;
}

/** Events between two consecutive states, by explicit rules (re-derivable from the same states). */
export function detectEvents(a: StateSnapshot, b: StateSnapshot): WorldEvent[] {
  const events: WorldEvent[] = [];
  const ka = a.variables.kp;
  const kb = b.variables.kp;
  if (ka?.provenance === "measured" && kb?.provenance === "measured") {
    if (ka.value! < STORM_KP && kb.value! >= STORM_KP) {
      events.push(seal({ kind: "event" as const, schema: SCHEMA_VERSION, at: b.at, type: "storm-onset", rule: `kp crosses ${STORM_KP} (G1) upward between consecutive measured states`, evidence: [a.id, b.id, ...kb.derivedFrom] }) as WorldEvent);
    } else if (ka.value! >= STORM_KP && kb.value! < STORM_KP) {
      events.push(seal({ kind: "event" as const, schema: SCHEMA_VERSION, at: b.at, type: "storm-end", rule: `kp falls below ${STORM_KP} between consecutive measured states`, evidence: [a.id, b.id, ...kb.derivedFrom] }) as WorldEvent);
    }
  }
  for (const name of Object.keys(a.variables).sort()) {
    if (a.variables[name].provenance === "measured" && b.variables[name]?.provenance === "unknown") {
      events.push(seal({ kind: "event" as const, schema: SCHEMA_VERSION, at: b.at, type: "source-lost", rule: `${name} went from measured to unknown (no fresh observation)`, evidence: [a.id, b.id] }) as WorldEvent);
    }
  }
  return events;
}

export function transition(a: StateSnapshot, b: StateSnapshot, events: readonly WorldEvent[] = []): { delta: StateDelta; transition: Transition } {
  const delta = diffStates(a, b);
  const t = seal({ kind: "transition" as const, schema: SCHEMA_VERSION, fromState: a.id, toState: b.id, delta: delta.id, associated: events.map((e) => e.id).sort() }) as Transition;
  return { delta, transition: t };
}

/** A forecast becomes a checkable hypothesis about a future state. */
export function hypothesisFromForecast(input: {
  issuedAt: string; horizonHours: number; variable: string; predicted: number; tolerance: number; method: string; basedOn: string[];
}): Hypothesis {
  const issued = Date.parse(input.issuedAt);
  return seal({
    kind: "hypothesis" as const, schema: SCHEMA_VERSION, issuedAt: new Date(issued).toISOString(),
    validAt: new Date(issued + input.horizonHours * 3_600_000).toISOString(), variable: input.variable,
    predicted: input.predicted, tolerance: input.tolerance, method: input.method, basedOn: [...input.basedOn].sort(),
    status: "open" as const, resolution: null,
  }) as Hypothesis;
}

/** Check a hypothesis against a state at (or after) its valid time. Unknown observed → unresolvable. */
export function resolveHypothesis(h: Hypothesis, state: StateSnapshot): Hypothesis {
  if (Date.parse(state.at) < Date.parse(h.validAt)) return h;
  const v = state.variables[h.variable];
  const observed = v && v.provenance === "measured" ? v.value : null;
  const status = observed === null ? "unresolvable" : Math.abs(observed - h.predicted) <= h.tolerance ? "supported" : "refuted";
  return seal({ ...h, status, resolution: { state: state.id, observed } }) as Hypothesis;
}

/** Advisory recommendation for a storm onset. No command authority: operators decide. */
export function adviseOnStormOnset(event: WorldEvent): AdvisoryAction | null {
  if (event.type !== "storm-onset") return null;
  return seal({
    kind: "action" as const, schema: SCHEMA_VERSION, at: event.at, authority: "advisory" as const,
    recommendation: "G1+ conditions: review deferrable uplinks and high-risk operations for the next 3 h.",
    rationale: [event.id],
  }) as AdvisoryAction;
}

/**
 * Current world state from the live canonical feed: only the points inside the longest variable
 * window, one per minute (the newest fresh observation per variable is all a state needs).
 */
export function worldStateFromFeed(feed: readonly CanonicalSpaceWeatherPoint[], nowIso: string): { state: StateSnapshot; observations: Observation[] } {
  const now = Date.parse(nowIso);
  const horizon = Math.max(DEFAULT_MAX_AGE_MS, ...Object.values(VARIABLE_MAX_AGE_MS));
  const seenMinutes = new Set<number>();
  const byId = new Map<string, Observation>();
  for (let i = feed.length - 1; i >= 0; i -= 1) {
    const t = Date.parse(feed[i].timestamp);
    if (!Number.isFinite(t) || t > now) continue;
    if (now - t > horizon) break;
    const minute = Math.floor(t / 60_000);
    if (seenMinutes.has(minute)) continue;
    seenMinutes.add(minute);
    for (const o of observationsFromCanonical(feed[i])) byId.set(o.id, o);
  }
  const observations = [...byId.values()];
  return { state: reconstructState(observations, nowIso), observations };
}
