/**
 * Typed world-state contracts (GAU-39, P-GAU-15 milestone M2).
 *
 * Records: Observation, StateSnapshot, StateDelta, WorldEvent, AdvisoryAction, Transition, Hypothesis.
 * Every record carries a deterministic id and a SHA-256 checksum over its canonical content
 * (backend/world/ids.ts), its time, and provenance back to evidence. Measured values come only from
 * Observations; anything derived carries `derivedFrom` and a `method`; anything missing or stale is
 * `unknown`, never a default (GAU-63 invariants).
 *
 * The world layer is read-only with respect to operations: it is built from the ingest pipeline's
 * canonical points and never feeds back into them (GAU-39: exploratory coupling must not alter
 * operational state). Actions are advisory only; nothing here has command authority.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "world/1.0.0";

export const Unit = z.enum(["nT", "km/s", "cm^-3", "nPa", "mV/m", "kp", "pfu", "particles/(cm^2 s sr)", "s", "ratio"]);
export const Frame = z.enum(["GSM", "GSE", "NEC", "none"]);
/** Where a value came from: measured by an instrument, derived by a method, or not known. */
export const Provenance = z.enum(["measured", "derived", "unknown"]);

const isoTime = z.string().refine((s) => Number.isFinite(Date.parse(s)) && /Z$|[+-]\d\d:\d\d$/.test(s), "ISO-8601 time with zone");
const hexId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{16}$`));
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const Uncertainty = z.object({ sigma: z.number().nonnegative(), lower: z.number(), upper: z.number() }).nullable();

export const SourceQuality = z.object({
  /** 0 live, 1 buffered, 2 synthetic, 3 stale/unknown (ingest ResilienceTier). */
  tier: z.number().int().min(0).max(3),
  stale: z.boolean(),
  lowConfidence: z.boolean(),
  interpolated: z.boolean(),
  extrapolated: z.boolean(),
});

/** A single measured quantity from one source and platform at one time. */
export const Observation = z.object({
  kind: z.literal("observation"),
  schema: z.literal(SCHEMA_VERSION),
  id: hexId("obs"),
  checksum: sha256,
  /** Stable variable name, e.g. "imf.bz", "solar_wind.speed", "kp", "dst", "protons_10mev". */
  variable: z.string().min(1),
  /** Physical system the variable describes (entity id; GAU-41 will canonicalise these). */
  system: z.string().min(1),
  value: z.number(),
  unit: Unit,
  frame: Frame,
  uncertainty: Uncertainty,
  observedAt: isoTime,
  source: z.string().min(1),
  /** Instrument platform, e.g. "DSCOVR", "GOES-18", "Kyoto WDC", "NOAA planetary". */
  platform: z.string().min(1),
  quality: SourceQuality,
  /** What this observation was extracted from (e.g. the canonical point id), for replay. */
  evidence: z.object({ canonicalTimestamp: isoTime, ingestSource: z.string() }),
});

export const StateValue = z.object({
  value: z.number().nullable(),
  unit: Unit,
  frame: Frame,
  provenance: Provenance,
  /** When the underlying measurement was made (null when unknown). */
  observedAt: isoTime.nullable(),
  /** Observation ids (measured) or state variables (derived) this value rests on. */
  derivedFrom: z.array(z.string()),
  /** "measured", or the method that derived it; "unknown" when no value. */
  method: z.string(),
  uncertainty: Uncertainty,
});

/** Best-known state of the system at one time, reconstructed from a bounded observation window. */
export const StateSnapshot = z.object({
  kind: z.literal("state"),
  schema: z.literal(SCHEMA_VERSION),
  id: hexId("st"),
  checksum: sha256,
  at: isoTime,
  /** Observations older than this (relative to `at`) were not used. */
  maxAgeMs: z.number().int().positive(),
  variables: z.record(StateValue),
  /** Every observation id that contributed, for audit and replay. */
  observationIds: z.array(hexId("obs")),
});

export const StateDelta = z.object({
  kind: z.literal("delta"),
  schema: z.literal(SCHEMA_VERSION),
  id: hexId("dl"),
  checksum: sha256,
  fromState: hexId("st"),
  toState: hexId("st"),
  changes: z.record(z.object({ from: z.number().nullable(), to: z.number().nullable(), provenance: Provenance })),
});

export const WorldEvent = z.object({
  kind: z.literal("event"),
  schema: z.literal(SCHEMA_VERSION),
  id: hexId("ev"),
  checksum: sha256,
  at: isoTime,
  /** e.g. "storm-onset" (Kp crosses 5-), "storm-end", "source-lost" (a variable became unknown). */
  type: z.string().min(1),
  /** Detection rule, so the event can be re-derived from the same states. */
  rule: z.string().min(1),
  evidence: z.array(z.string()).min(1),
});

/** A recommended operator action. Advisory only: no command authority (ICP invariant). */
export const AdvisoryAction = z.object({
  kind: z.literal("action"),
  schema: z.literal(SCHEMA_VERSION),
  id: hexId("ac"),
  checksum: sha256,
  at: isoTime,
  authority: z.literal("advisory"),
  recommendation: z.string().min(1),
  rationale: z.array(z.string()).min(1),
});

export const Transition = z.object({
  kind: z.literal("transition"),
  schema: z.literal(SCHEMA_VERSION),
  id: hexId("tr"),
  checksum: sha256,
  fromState: hexId("st"),
  toState: hexId("st"),
  delta: hexId("dl"),
  /** Events/actions associated with the transition (correlation, not proven causation). */
  associated: z.array(z.string()),
});

/** A prediction that can later be checked against observed state (e.g. a model forecast). */
export const Hypothesis = z.object({
  kind: z.literal("hypothesis"),
  schema: z.literal(SCHEMA_VERSION),
  id: hexId("hy"),
  checksum: sha256,
  issuedAt: isoTime,
  validAt: isoTime,
  variable: z.string().min(1),
  predicted: z.number(),
  tolerance: z.number().positive(),
  /** Model or method that produced it, e.g. "kp3h-mlp-v1-87236383". */
  method: z.string().min(1),
  basedOn: z.array(z.string()),
  status: z.enum(["open", "supported", "refuted", "unresolvable"]),
  /** Set when resolved: the state used and the observed value. */
  resolution: z.object({ state: hexId("st"), observed: z.number().nullable() }).nullable(),
});

export const WorldRecord = z.discriminatedUnion("kind", [
  Observation, StateSnapshot, StateDelta, WorldEvent, AdvisoryAction, Transition, Hypothesis,
]);

export type Observation = z.infer<typeof Observation>;
export type StateValue = z.infer<typeof StateValue>;
export type StateSnapshot = z.infer<typeof StateSnapshot>;
export type StateDelta = z.infer<typeof StateDelta>;
export type WorldEvent = z.infer<typeof WorldEvent>;
export type AdvisoryAction = z.infer<typeof AdvisoryAction>;
export type Transition = z.infer<typeof Transition>;
export type Hypothesis = z.infer<typeof Hypothesis>;
export type WorldRecord = z.infer<typeof WorldRecord>;
export type Unit = z.infer<typeof Unit>;
export type Frame = z.infer<typeof Frame>;
