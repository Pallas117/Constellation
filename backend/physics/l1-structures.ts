/**
 * L1 structure detection (GAU-139, study row 6).
 *
 * Finds candidates for three structures in the 1-minute L1 series (RTSW magnetometer + plasma):
 * - fast-forward interplanetary shocks: the 10-minute medians either side of a minute jump by
 *   ΔV ≥ 40 km/s, n × 1.2 and B × 1.2. The time is the sharpest one-minute rise in |B| there.
 *   The arrival at Earth uses the shock speed from mass-flux conservation across the front
 *   (Rankine–Hugoniot, Vsh = (n2·V2 − n1·V1)/(n2 − n1)), because a shock outruns the plasma
 *   behind it;
 * - sustained southward driving: Ey = V·Bs ≥ 5 mV/m (Bs = max(−Bz, 0)) for ≥ 3 h. That is the
 *   Bz < −10 nT for > 3 h condition for an intense storm (Dst < −100 nT) of Gonzalez & Tsurutani
 *   (1987, Planet. Space Sci. 35, 1101) at ~500 km/s;
 * - a compressed magnetopause: the Shue et al. (1998) standoff inside geostationary orbit
 *   (6.6 Re) for ≥ 10 min, using the nowcast's own Shue and pressure functions;
 * - ICME candidates: Bt > 8 nT for ≥ 4 h with either signature of ejecta: proton temperature
 *   under half the expected value for the speed (T/T_exp < 0.5, T_exp after Lopez & Freeman
 *   1986, as Richardson & Cane use it) or low proton beta (< 0.1, the magnetic-cloud signature of
 *   Burlaga et al. 1981). Fast, compressed ICMEs can stay hot, so the temperature alone misses
 *   them: inside the May and Oct 2024 ejecta T/T_exp was mostly 0.55–1.8 while beta was 0.00–0.10.
 *   Boundaries lag the true leading edge by hours;
 * - high-speed streams: V > 550 km/s with T/T_exp ≥ 0.8 for ≥ 6 h. A fast, hot flow that starts
 *   within 12 h after a shock is labelled sheath / fast ejecta, not a coronal-hole stream.
 *
 * Thresholds are those of the gauss_swx study pack (patterns.detect_l1_structures). These are
 * heuristics: every result carries a confidence label and is a candidate for an expert to
 * confirm (shocks against an interplanetary-shock list, storms against Richardson & Cane), never
 * a catalogue entry. Without the proton temperature, ICMEs and streams aren't assessed.
 */
import { dynamicPressureNpa, propagationDelaySeconds, shueStandoffDistanceRe } from "./mhd-nowcast.js";

/** One minute of L1 data; null where the instrument reported a fill or nothing. */
export interface L1Sample {
  time: string;
  speedKmS: number | null;
  densityCm3: number | null;
  btNt: number | null;
  bzGsmNt: number | null;
  /** Proton temperature (K); absent or null where not measured. */
  temperatureK?: number | null;
}

/**
 * How far to trust a candidate. "low": too much data missing to rely on it. "medium": the
 * thresholds are met. "high": well past them with near-complete data.
 */
export type DetectionConfidence = "high" | "medium" | "low";

export interface ShockCandidate {
  kind: "fast-forward shock candidate";
  /** The front at L1 (UTC): the sharpest one-minute rise in |B| where the jump passes. */
  time: string;
  /** Arrival at Earth: the nowcast's L1 delay model at the shock speed. */
  earthArrival: string;
  /** From mass-flux conservation; the downstream speed when that isn't usable. */
  shockSpeedKmS: number;
  deltaSpeedKmS: number;
  densityRatio: number;
  fieldRatio: number;
  confidence: DetectionConfidence;
}

export interface SouthwardInterval {
  kind: "sustained southward driving";
  start: string;
  end: string;
  hours: number;
  maxEyMvM: number;
  minBzNt: number;
  confidence: DetectionConfidence;
}

export interface MagnetopauseInterval {
  kind: "magnetopause inside geostationary orbit";
  start: string;
  end: string;
  minutes: number;
  /** Shue (1998) minimum; the model is clamped at 4 Re, so 4 means "4 Re or closer". */
  minStandoffRe: number;
  confidence: DetectionConfidence;
}

export interface IcmeInterval {
  kind: "ICME candidate";
  start: string;
  end: string;
  hours: number;
  /** Which ejecta signatures the interval's medians show. */
  signatures: ("low T/T_exp" | "low proton beta")[];
  medianTemperatureRatio: number;
  medianProtonBeta: number;
  minBzNt: number;
  maxBtNt: number;
  confidence: DetectionConfidence;
}

export interface FastFlowInterval {
  /** A stream from a coronal hole, or fast hot flow right behind a shock (CME sheath / ejecta). */
  kind: "high-speed stream" | "post-shock fast flow (sheath / fast ejecta, not a coronal-hole stream)";
  start: string;
  end: string;
  hours: number;
  maxSpeedKmS: number;
  confidence: DetectionConfidence;
}

export interface L1Structures {
  shocks: ShockCandidate[];
  sustainedSouthward: SouthwardInterval[];
  magnetopauseInsideGeo: MagnetopauseInterval[];
  icmeCandidates: IcmeInterval[];
  fastFlows: FastFlowInterval[];
  /** Share of minutes with data, per input. */
  coverage: { speed: number; density: number; bt: number; bz: number; temperature: number };
  notes: string[];
}

export const SHOCK_THRESHOLDS = { windowMin: 10, deltaSpeedKmS: 40, densityRatio: 1.2, fieldRatio: 1.2 } as const;
export const SOUTHWARD_THRESHOLDS = { eyMvM: 5, minHours: 3 } as const;
export const GEO_RADIUS_RE = 6.6;
export const ICME_THRESHOLDS = { temperatureRatio: 0.5, protonBeta: 0.1, btNt: 8, minHours: 4 } as const;
export const STREAM_THRESHOLDS = { speedKmS: 550, temperatureRatio: 0.8, minHours: 6, afterShockHours: 12 } as const;

const K_B = 1.380649e-23; // J/K
const MU0 = 4e-7 * Math.PI; // H/m

/**
 * Expected proton temperature (K) of normal solar wind at speed V (km/s), Lopez & Freeman (1986):
 * (0.031·V − 5.1)²·10³ below 500 km/s, (0.51·V − 142)·10³ above.
 */
export function expectedTemperatureK(speedKmS: number): number {
  return speedKmS < 500 ? (0.031 * speedKmS - 5.1) ** 2 * 1e3 : (0.51 * speedKmS - 142) * 1e3;
}

/** Proton beta: thermal over magnetic pressure. Magnetic clouds typically sit under ~0.1–0.3. */
export function protonBeta(densityCm3: number, temperatureK: number, btNt: number): number {
  return (densityCm3 * 1e6 * K_B * temperatureK) / ((btNt * 1e-9) ** 2 / (2 * MU0));
}

const MINUTE_MS = 60_000;
const SMOOTH_MIN = 15; // rolling median before thresholding: bridges gaps and one-minute excursions
const MAX_GAP_MIN = 30; // a run survives missing data up to this long
const MERGE_MIN = 30; // runs closer than this are one interval

const finite = (x: number) => Number.isFinite(x);
const round = (x: number, places: number) => Number(x.toFixed(places));

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Finite values of a[from, to) and the share of the window they cover. */
function windowValues(a: Float64Array, from: number, to: number): { values: number[]; coverage: number } {
  const values: number[] = [];
  for (let i = Math.max(0, from); i < Math.min(a.length, to); i++) if (finite(a[i])) values.push(a[i]);
  return { values, coverage: values.length / Math.max(1, to - from) };
}

/** Rolling median over ±k/2 minutes, ignoring missing minutes. */
function smooth(a: Float64Array, minutes = SMOOTH_MIN): Float64Array {
  const half = minutes >> 1;
  const out = new Float64Array(a.length).fill(NaN);
  for (let j = 0; j < a.length; j++) out[j] = median(windowValues(a, j - half, j + half + 1).values);
  return out;
}

/** Share of a[from..to] (inclusive) that has data. */
function share(a: Float64Array, from: number, to: number): number {
  return windowValues(a, from, to + 1).coverage;
}

function confidenceFromCoverage(coverage: number, strong: boolean): DetectionConfidence {
  if (coverage < 0.6) return "low";
  return strong && coverage >= 0.9 ? "high" : "medium";
}

/**
 * Runs of true states that last at least minMinutes. Missing minutes (null) are bridged up to
 * MAX_GAP_MIN, and runs separated by MERGE_MIN or less are merged. Returns [start, end] indices.
 */
function runs(states: (boolean | null)[], minMinutes: number): [number, number][] {
  const found: [number, number][] = [];
  let start = -1;
  let lastTrue = -1;
  let gap = 0;
  states.forEach((state, j) => {
    if (state === true) {
      if (start < 0) start = j;
      lastTrue = j;
      gap = 0;
    } else if (start >= 0 && (state === false || ++gap > MAX_GAP_MIN)) {
      found.push([start, lastTrue]);
      start = -1;
      gap = 0;
    }
  });
  if (start >= 0) found.push([start, lastTrue]);
  const merged: [number, number][] = [];
  for (const run of found) {
    const last = merged[merged.length - 1];
    if (last && run[0] - last[1] <= MERGE_MIN) last[1] = run[1];
    else merged.push([...run]);
  }
  return merged.filter(([s, e]) => e - s + 1 >= minMinutes);
}

/** Candidates for shocks, sustained southward driving and a compressed magnetopause. */
export function detectL1Structures(samples: L1Sample[]): L1Structures {
  const notes = [
    "Heuristic candidates: confirm shocks against an interplanetary-shock list and storm structures against the Richardson & Cane ICME list before treating them as events.",
    "ICMEs and high-speed streams are not assessed: no proton temperature (T/T_exp).",
  ];
  const timed = samples
    .map((s) => ({ ...s, ms: Date.parse(s.time) }))
    .filter((s) => finite(s.ms))
    .sort((a, b) => a.ms - b.ms);
  if (timed.length === 0) {
    return {
      shocks: [],
      sustainedSouthward: [],
      magnetopauseInsideGeo: [],
      icmeCandidates: [],
      fastFlows: [],
      coverage: { speed: 0, density: 0, bt: 0, bz: 0, temperature: 0 },
      notes: [...notes, "No data."],
    };
  }

  // On a regular 1-minute grid, NaN where missing; nothing is interpolated.
  const t0 = Math.round(timed[0].ms / MINUTE_MS) * MINUTE_MS;
  const n = Math.round((timed[timed.length - 1].ms - t0) / MINUTE_MS) + 1;
  const grid = () => new Float64Array(n).fill(NaN);
  const v = grid();
  const den = grid();
  const bt = grid();
  const bz = grid();
  const temp = grid();
  for (const s of timed) {
    const i = Math.round((s.ms - t0) / MINUTE_MS);
    if (s.speedKmS !== null && finite(s.speedKmS)) v[i] = s.speedKmS;
    if (s.densityCm3 !== null && finite(s.densityCm3)) den[i] = s.densityCm3;
    if (s.btNt !== null && finite(s.btNt)) bt[i] = s.btNt;
    if (s.bzGsmNt !== null && finite(s.bzGsmNt)) bz[i] = s.bzGsmNt;
    if (s.temperatureK != null && finite(s.temperatureK) && s.temperatureK > 0) temp[i] = s.temperatureK;
  }
  const iso = (i: number) => new Date(t0 + i * MINUTE_MS).toISOString();

  // Shocks: medians of the 10 minutes before and after each minute.
  const w = SHOCK_THRESHOLDS.windowMin;
  const jumpAt = (i: number) => {
    const windows = [v, v, den, den, bt, bt].map((a, k) => windowValues(a, k % 2 ? i : i - w, k % 2 ? i + w : i));
    const [v1, v2, n1, n2, b1, b2] = windows.map((x) => median(x.values));
    if (![v1, v2, n1, n2, b1, b2].every(finite) || n1 <= 0 || b1 <= 0) return null;
    const jump = { i, v1, v2, n1, n2, dV: v2 - v1, nr: n2 / n1, br: b2 / b1, coverage: Math.min(...windows.map((x) => x.coverage)) };
    const passes =
      jump.dV >= SHOCK_THRESHOLDS.deltaSpeedKmS && jump.nr >= SHOCK_THRESHOLDS.densityRatio && jump.br >= SHOCK_THRESHOLDS.fieldRatio;
    return passes ? jump : null;
  };
  const shocks: ShockCandidate[] = [];
  for (let i = w; i < n - w; i++) {
    const first = jumpAt(i);
    if (!first) continue;
    // The thresholds pass as soon as half the downstream window is past the front. The front
    // itself is the sharpest one-minute rise in |B| within the next window: the magnetometer
    // resolves it best. Its window medians describe the shock.
    let front = -1;
    let rise = 0;
    for (let k = i; k < Math.min(i + w, n - w); k++) {
      const d = bt[k] - bt[k - 1];
      if (finite(d) && d > rise) [front, rise] = [k, d];
    }
    const best = (front >= 0 && jumpAt(front)) || first;
    const massFlux = (best.n2 * best.v2 - best.n1 * best.v1) / (best.n2 - best.n1);
    const shockSpeed = finite(massFlux) && massFlux >= best.v2 ? massFlux : best.v2;
    shocks.push({
      kind: "fast-forward shock candidate",
      time: iso(best.i),
      earthArrival: new Date(t0 + best.i * MINUTE_MS + propagationDelaySeconds(shockSpeed) * 1000).toISOString(),
      shockSpeedKmS: round(shockSpeed, 0),
      deltaSpeedKmS: round(best.dV, 1),
      densityRatio: round(best.nr, 2),
      fieldRatio: round(best.br, 2),
      confidence: confidenceFromCoverage(
        best.coverage,
        best.dV >= 2 * SHOCK_THRESHOLDS.deltaSpeedKmS && best.nr >= 1.5 && best.br >= 1.5,
      ),
    });
    i = best.i + 6 * w - 1; // one shock per hour: the jump stays above threshold for several minutes
  }

  // Sustained southward driving: Ey from smoothed V and Bz. A plasma gap carries the last speed
  // forward (Bz alone still shows the driving); confidence falls with the share of real data.
  const vs = smooth(v);
  const bzs = smooth(bz);
  const vHeld = Float64Array.from(vs);
  for (let j = 1; j < n; j++) if (!finite(vHeld[j])) vHeld[j] = vHeld[j - 1];
  const ey = vHeld.map((vj, j) => (finite(vj) && finite(bzs[j]) ? (vj * Math.max(-bzs[j], 0)) / 1000 : NaN));
  const sustainedSouthward: SouthwardInterval[] = runs(
    Array.from(ey, (e) => (finite(e) ? e > SOUTHWARD_THRESHOLDS.eyMvM : null)),
    SOUTHWARD_THRESHOLDS.minHours * 60,
  ).map(([s, e]) => {
    const coverage = Math.min(share(v, s, e), share(bz, s, e));
    const maxEy = Math.max(...Array.from(ey.subarray(s, e + 1)).filter(finite));
    return {
      kind: "sustained southward driving",
      start: iso(s),
      end: iso(e),
      hours: round(((e - s + 1) * MINUTE_MS) / 3_600_000, 1),
      maxEyMvM: round(maxEy, 1),
      minBzNt: round(Math.min(...Array.from(bz.subarray(s, e + 1)).filter(finite)), 1),
      confidence: confidenceFromCoverage(coverage, maxEy >= 2 * SOUTHWARD_THRESHOLDS.eyMvM),
    };
  });

  // Magnetopause: Shue (1998) from smoothed n, V and Bz.
  const ns = smooth(den);
  const r0 = Float64Array.from({ length: n }, (_, j) =>
    [ns[j], vs[j], bzs[j]].every(finite) ? shueStandoffDistanceRe(dynamicPressureNpa(ns[j], vs[j]), bzs[j]) : NaN,
  );
  const magnetopauseInsideGeo: MagnetopauseInterval[] = runs(
    Array.from(r0, (r) => (finite(r) ? r < GEO_RADIUS_RE : null)),
    10,
  ).map(([s, e]) => {
    const coverage = Math.min(share(v, s, e), share(den, s, e), share(bz, s, e));
    const minR = Math.min(...Array.from(r0.subarray(s, e + 1)).filter(finite));
    return {
      kind: "magnetopause inside geostationary orbit",
      start: iso(s),
      end: iso(e),
      minutes: e - s + 1,
      minStandoffRe: round(minR, 2),
      confidence: confidenceFromCoverage(coverage, minR <= GEO_RADIUS_RE - 1),
    };
  });

  // ICMEs and streams: T/T_exp from the measured temperature and speed, smoothed like the rest.
  const ratio = Float64Array.from({ length: n }, (_, j) =>
    finite(temp[j]) && finite(v[j]) && v[j] > 0 ? temp[j] / expectedTemperatureK(v[j]) : NaN,
  );
  const beta = Float64Array.from({ length: n }, (_, j) =>
    [den[j], temp[j], bt[j]].every(finite) && bt[j] > 0 ? protonBeta(den[j], temp[j], bt[j]) : NaN,
  );
  const rs = smooth(ratio);
  const betas = smooth(beta);
  const bts = smooth(bt);
  const valuesIn = (a: Float64Array, s: number, e: number) => Array.from(a.subarray(s, e + 1)).filter(finite);
  const ejecta = (j: number) => {
    const signs = [rs[j], betas[j]].filter(finite);
    if (signs.length === 0 || !finite(bts[j])) return null;
    const lowRatio = finite(rs[j]) && rs[j] < ICME_THRESHOLDS.temperatureRatio;
    const lowBeta = finite(betas[j]) && betas[j] < ICME_THRESHOLDS.protonBeta;
    return (lowRatio || lowBeta) && bts[j] > ICME_THRESHOLDS.btNt;
  };
  const icmeCandidates: IcmeInterval[] = runs(Array.from({ length: n }, (_, j) => ejecta(j)), ICME_THRESHOLDS.minHours * 60).map(
    ([s, e]) => {
      const coverage = Math.min(share(temp, s, e), share(den, s, e), share(bt, s, e));
      const medianRatio = median(valuesIn(ratio, s, e));
      const medianBeta = median(valuesIn(beta, s, e));
      const signatures: IcmeInterval["signatures"] = [];
      if (medianRatio < ICME_THRESHOLDS.temperatureRatio) signatures.push("low T/T_exp");
      if (medianBeta < ICME_THRESHOLDS.protonBeta) signatures.push("low proton beta");
      return {
        kind: "ICME candidate",
        start: iso(s),
        end: iso(e),
        hours: round(((e - s + 1) * MINUTE_MS) / 3_600_000, 1),
        signatures,
        medianTemperatureRatio: round(medianRatio, 2),
        medianProtonBeta: round(medianBeta, 3),
        minBzNt: round(Math.min(...valuesIn(bz, s, e)), 1),
        maxBtNt: round(Math.max(...valuesIn(bt, s, e)), 1),
        confidence: confidenceFromCoverage(coverage, signatures.length === 2),
      };
    },
  );
  const shockTimes = shocks.map((sh) => Date.parse(sh.time));
  const fastFlows: FastFlowInterval[] = runs(
    Array.from(rs, (r, j) => (finite(r) && finite(vs[j]) ? vs[j] > STREAM_THRESHOLDS.speedKmS && r >= STREAM_THRESHOLDS.temperatureRatio : null)),
    STREAM_THRESHOLDS.minHours * 60,
  ).map(([s, e]) => {
    const coverage = Math.min(share(v, s, e), share(temp, s, e));
    const startMs = t0 + s * MINUTE_MS;
    const afterShock = shockTimes.some((t) => startMs >= t && startMs - t <= STREAM_THRESHOLDS.afterShockHours * 3_600_000);
    const medianSpeed = median(valuesIn(v, s, e));
    return {
      kind: afterShock ? "post-shock fast flow (sheath / fast ejecta, not a coronal-hole stream)" : "high-speed stream",
      start: iso(s),
      end: iso(e),
      hours: round(((e - s + 1) * MINUTE_MS) / 3_600_000, 1),
      maxSpeedKmS: round(Math.max(...valuesIn(v, s, e)), 0),
      confidence: confidenceFromCoverage(coverage, medianSpeed >= STREAM_THRESHOLDS.speedKmS + 100),
    };
  });

  const covered = (a: Float64Array) => round(share(a, 0, n - 1), 3);
  const temperatureCoverage = covered(temp);
  return {
    shocks,
    sustainedSouthward,
    magnetopauseInsideGeo,
    icmeCandidates,
    fastFlows,
    coverage: { speed: covered(v), density: covered(den), bt: covered(bt), bz: covered(bz), temperature: temperatureCoverage },
    notes:
      temperatureCoverage > 0
        ? [notes[0], "ICME boundaries from T/T_exp lag the true leading edge by hours; the shock or sheath comes first."]
        : notes,
  };
}
