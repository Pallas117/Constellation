/**
 * Scores the L1 structure detectors on the GAU-154 holdout set with the rules pre-registered on
 * GAU-154 (2026-10-21), before any holdout data was scored:
 * - a shock is expected where the catalogue has a minute-precise sudden commencement (dV > 0);
 *   it's a hit when a shock candidate's arrival at Earth is within 30 min of it;
 * - an ICME is a hit when a candidate starts within 2 h of the catalogued ICME start;
 * - a false alarm is a shock more than 30 min from every catalogued disturbance in the window, an
 *   ICME candidate overlapping no catalogued [start − 2 h, end], or any candidate on a quiet day.
 * Field-only discontinuities (GAU-153) are listed, not scored.
 */
import { fileURLToPath } from "node:url";
import { detectL1Structures, expectedTemperatureK, protonBeta, type L1Sample, type L1Structures } from "../physics/l1-structures.js";
import { archiveL1Samples } from "./archive.js";
import { HOLDOUT_EVENTS, type CatalogueIcme, type HoldoutEvent } from "./holdout.js";
import { loadArchive } from "./replay.js";

export const SHOCK_TOLERANCE_MIN = 30;
export const ICME_START_TOLERANCE_MIN = 120;

export interface HoldoutScore {
  id: string;
  kind: "storm" | "quiet";
  /** null when no shock is expected. */
  shock: { hit: boolean; arrivalErrorMin: number | null } | null;
  /** null on a quiet day. */
  icme: { hit: boolean; startErrorMin: number | null } | null;
  /** L1 times of shock candidates that match nothing catalogued. */
  falseShocks: string[];
  /** Starts of ICME candidates that overlap nothing catalogued. */
  falseIcmes: string[];
  fieldOnly: string[];
  /**
   * Inside the catalogued ICME (as far as the window reaches): medians of the detector's
   * inputs, and the share of minutes meeting each threshold. Explains misses; not a score.
   */
  insideIcme: {
    minutes: number;
    medianTemperatureRatio: number | null;
    medianProtonBeta: number | null;
    medianBtNt: number | null;
    shareLowTemperature: number | null;
    shareLowBeta: number | null;
    shareStrongField: number | null;
  } | null;
}

const minutes = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 60_000;
const nearest = (errors: number[]) => (errors.length ? errors.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a)) : null);
const round1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);
const share = (xs: number[], pass: (x: number) => boolean) => (xs.length ? round2(xs.filter(pass).length / xs.length) : null);

/** The detector's ICME inputs inside the catalogued interval, minute by minute. */
export function insideIcme(samples: L1Sample[], target: CatalogueIcme): HoldoutScore["insideIcme"] {
  const inside = samples.filter((s) => s.time >= target.icmeStart && s.time <= target.icmeEnd);
  if (inside.length === 0) return null;
  const ok = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
  const ratios = inside.filter((s) => ok(s.temperatureK) && ok(s.speedKmS)).map((s) => s.temperatureK! / expectedTemperatureK(s.speedKmS!));
  const betas = inside.filter((s) => ok(s.densityCm3) && ok(s.temperatureK) && ok(s.btNt)).map((s) => protonBeta(s.densityCm3!, s.temperatureK!, s.btNt!));
  const fields = inside.map((s) => s.btNt).filter(ok);
  return {
    minutes: inside.length,
    medianTemperatureRatio: round2(median(ratios)),
    medianProtonBeta: round2(median(betas)),
    medianBtNt: round2(median(fields)),
    shareLowTemperature: share(ratios, (x) => x < 0.5),
    shareLowBeta: share(betas, (x) => x < 0.1),
    shareStrongField: share(fields, (x) => x > 8),
  };
}

export function scoreHoldout(event: HoldoutEvent, r: L1Structures, samples: L1Sample[] = []): HoldoutScore {
  const catalogued: CatalogueIcme[] = event.target ? [event.target, ...event.others] : event.others;
  const matchesShock = (arrival: string) => catalogued.some((c) => Math.abs(minutes(arrival, c.disturbance)) <= SHOCK_TOLERANCE_MIN);
  const overlapsIcme = (start: string, end: string) =>
    catalogued.some((c) => Date.parse(start) <= Date.parse(c.icmeEnd) && Date.parse(end) >= Date.parse(c.icmeStart) - ICME_START_TOLERANCE_MIN * 60_000);

  let shock: HoldoutScore["shock"] = null;
  if (event.target?.shock) {
    const error = nearest(r.shocks.map((s) => minutes(s.earthArrival, event.target!.disturbance)));
    shock = { hit: error !== null && Math.abs(error) <= SHOCK_TOLERANCE_MIN, arrivalErrorMin: round1(error) };
  }
  let icme: HoldoutScore["icme"] = null;
  if (event.target) {
    const error = nearest(r.icmeCandidates.map((c) => minutes(c.start, event.target!.icmeStart)));
    icme = { hit: error !== null && Math.abs(error) <= ICME_START_TOLERANCE_MIN, startErrorMin: round1(error) };
  }
  return {
    id: event.id,
    kind: event.target ? "storm" : "quiet",
    shock,
    icme,
    falseShocks: r.shocks.filter((s) => !matchesShock(s.earthArrival)).map((s) => s.time),
    falseIcmes: r.icmeCandidates.filter((c) => !overlapsIcme(c.start, c.end)).map((c) => c.start),
    fieldOnly: r.fieldOnlyDiscontinuities.map((f) => f.time),
    insideIcme: event.target ? insideIcme(samples, event.target) : null,
  };
}

export interface HoldoutTotals {
  shocks: { expected: number; hit: number; missed: number; falseAlarms: number };
  icmes: { expected: number; hit: number; missed: number; falseAlarms: number };
  quietDays: number;
  quietDayFalseAlarms: number;
}

export function holdoutTotals(scores: HoldoutScore[]): HoldoutTotals {
  const shocks = scores.filter((s) => s.shock);
  const icmes = scores.filter((s) => s.icme);
  const quiet = scores.filter((s) => s.kind === "quiet");
  const hits = (xs: (HoldoutScore["shock"] | HoldoutScore["icme"])[]) => xs.filter((x) => x?.hit).length;
  return {
    shocks: {
      expected: shocks.length,
      hit: hits(shocks.map((s) => s.shock)),
      missed: shocks.length - hits(shocks.map((s) => s.shock)),
      falseAlarms: scores.reduce((n, s) => n + s.falseShocks.length, 0),
    },
    icmes: {
      expected: icmes.length,
      hit: hits(icmes.map((s) => s.icme)),
      missed: icmes.length - hits(icmes.map((s) => s.icme)),
      falseAlarms: scores.reduce((n, s) => n + s.falseIcmes.length, 0),
    },
    quietDays: quiet.length,
    quietDayFalseAlarms: quiet.reduce((n, s) => n + s.falseShocks.length + s.falseIcmes.length, 0),
  };
}

/** Every holdout window through the detectors, scored; reads the cached archives (offline). */
export function holdoutScorecard(): { scores: HoldoutScore[]; totals: HoldoutTotals } {
  const scores = HOLDOUT_EVENTS.map((event) => {
    const samples = archiveL1Samples(loadArchive(fileURLToPath(new URL(`events/${event.id}.json.gz`, import.meta.url))));
    return scoreHoldout(event, detectL1Structures(samples), samples);
  });
  return { scores, totals: holdoutTotals(scores) };
}
