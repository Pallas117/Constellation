/**
 * PR-01 Inference Trust Record (GAU-57): for one onboard-AI inference, what the space environment
 * was when it ran, where every value came from and how old it was, and a verdict.
 *
 * The verdict is `unknown` whenever a required input is missing, stale or conflicting; it is
 * never `consistent` by default. Every field carries its source, the product URL, when it was
 * observed, when Gauss held it, its age at the inference time, a confidence, how it was obtained
 * and its limitations. The record describes the environment, never the spacecraft: it carries no
 * wording about harm to hardware or the odds of a wrong output (`bannedWording`).
 */
import { createHash } from "node:crypto";
import type { CanonicalSpaceWeatherPoint, ScaleReading, SenseCheck } from "../types.js";
import { MAX_READING_LAG_MS, type EnvironmentHistory } from "./environment.js";
import { IGRF_LABEL } from "../physics/igrf.js";
import { SAA_CORE_NT, SAA_EXTENDED_NT, saaContext, type SaaTier } from "./saa.js";
import { dipoleLShell, distanceKm, EPHEMERIS_TLE_CONFLICT_KM, ephemerisProblem, propagateTle, tleProblem, type Ephemeris } from "./orbit.js";
import { upsetRiskField, type UpsetRiskValue } from "./upset.js";

export const TRUST_RECORD_SCHEMA = "gauss.trust-record/0.1";

/** The NOAA SWPC products behind each field (the same ones the ingest adapters read). */
const SOURCE_URL = {
  protons: "https://services.swpc.noaa.gov/json/goes/primary/integral-protons-6-hour.json",
  xrays: "https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json",
  kp3h: "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json",
  kp1m: "https://services.swpc.noaa.gov/json/planetary_k_index_1m.json",
  dst: "https://services.swpc.noaa.gov/products/kyoto-dst.json",
} as const;

/** Beyond these ages at the inference time a reading is stale, so its field is unknown. */
export const MAX_AGE_MS = {
  particles: 30 * 60_000,
  xrays: 15 * 60_000,
  kp: 6 * 3_600_000,
  dst: 2 * 3_600_000,
} as const;

const GEO_LIMITATION = "Measured by GOES at geostationary orbit, not at this spacecraft's position.";

export type Confidence = "high" | "medium" | "low" | "none";
export type Verdict = "consistent" | "degraded-context" | "unknown";

export interface Field<T> {
  /** Null when unknown; `limitations` then says why. */
  value: T | null;
  source: string;
  sourceUrl: string | null;
  /** When it was measured (UTC). */
  observedAt: string | null;
  /** When Gauss held it: the issue time of the reading it came from. */
  fetchedAt: string | null;
  /** Age at the inference time, seconds. */
  ageSeconds: number | null;
  confidence: Confidence;
  /** "measured", or how it was derived. */
  method: string;
  limitations: string[];
}

export interface TrustRecordRequest {
  /** Inference time (ISO 8601, UTC). */
  time: string;
  spacecraftId: string;
  modelId: string;
  processorProfileId?: string | null;
  /** The inference output as the customer logged it; echoed, never interpreted. */
  output?: unknown;
  /** The model's own confidence, 0–1. */
  confidence?: number | null;
  /** Spacecraft position at the inference time. */
  ephemeris?: Ephemeris | null;
  /** Two-line element set, propagated with SGP4 when no ephemeris is given (and cross-checked when both are). */
  tle?: [string, string] | null;
  /** Set by the log ingest adapter (GAU-66), never taken from an API body. */
  ingest?: IngestProvenance | null;
}

/** Where an ingested inference came from: the exact file, row and mapping (GAU-66). */
export interface IngestProvenance {
  fileSha256: string;
  /** 1-based data row (the header is row 0 for CSV). */
  row: number;
  mappingId: string;
  mappingVersion: string;
}

/** Thresholds a pilot agrees with the customer; the record states the policy it used. */
export interface TrustPolicy {
  id: string;
  /** NOAA S-level at or above which the context is degraded. */
  degradedAtRadiation: number;
  /** NOAA G-level at or above which the context is degraded. */
  degradedAtGeomagnetic: number;
  /** When true, unknown orbit context makes the verdict unknown. */
  requireOrbitContext: boolean;
}

export const DEFAULT_POLICY: TrustPolicy = {
  id: "gauss-default-0.1",
  degradedAtRadiation: 2,
  degradedAtGeomagnetic: 3,
  requireOrbitContext: false,
};

export interface TrustRecord {
  schema: typeof TRUST_RECORD_SCHEMA;
  recordId: string;
  generatedAt: string;
  inference: {
    time: string;
    spacecraftId: string;
    modelId: string;
    processorProfileId: string | null;
    output: unknown;
    confidence: number | null;
    /** Present when the inference came from an ingested customer log. */
    ingest: IngestProvenance | null;
  };
  /** Which history the environment was read from, e.g. "live feed" or "replay jan-2026". */
  environmentSource: string;
  environment: {
    radiation: Field<{ level: number; label: string }>;
    geomagnetic: Field<{ level: number; label: string }>;
    radioBlackout: Field<{ level: number; label: string }>;
    /** Nearest-available particle-flux proxy: GOES ≥10 MeV integral protons. */
    particleFlux: Field<{ value: number; unit: "pfu"; channel: string; satellite: string | null }>;
    kp: Field<{ value: number; kind: string }>;
    dst: Field<{ value: number }>;
  };
  orbit: {
    /** Where the spacecraft was: the supplied ephemeris, or SGP4 from the TLE. */
    position: Field<Ephemeris>;
    saa: Field<boolean>;
    /** IGRF-14 total field intensity at the position, nT (what the SAA flag is judged on). */
    fieldStrength: Field<number>;
    lShell: Field<number>;
  };
  /** Modelled upset-risk band relative to the quiet orbit average; needs a cited processor profile (PR-02, upset.ts). */
  upsetRisk: Field<UpsetRiskValue>;
  checks: Array<{ id: SenseCheck["id"]; status: SenseCheck["status"]; reason: string }>;
  verdict: { value: Verdict; reasons: string[]; policy: TrustPolicy };
  limitations: string[];
  /** SHA-256 of the record without this field (canonical JSON); chains into evidence packs. */
  hash: string;
}

// ---------------------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------------------

export const MAX_OUTPUT_BYTES = 4096;

const id = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 128;

/** The request as typed, or every problem with it (nothing is guessed or defaulted). */
export function parseTrustRequest(body: unknown): { request: TrustRecordRequest } | { errors: string[] } {
  const errors: string[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { errors: ["body must be a JSON object"] };
  const b = body as Record<string, unknown>;
  if (typeof b.time !== "string" || !Number.isFinite(Date.parse(b.time))) errors.push("time must be an ISO 8601 timestamp");
  if (!id(b.spacecraftId)) errors.push("spacecraftId must be 1–128 characters");
  if (!id(b.modelId)) errors.push("modelId must be 1–128 characters");
  if (b.processorProfileId != null && !id(b.processorProfileId)) errors.push("processorProfileId must be 1–128 characters");
  if (b.confidence != null && (typeof b.confidence !== "number" || !(b.confidence >= 0 && b.confidence <= 1))) {
    errors.push("confidence must be a number from 0 to 1");
  }
  if (b.output !== undefined) {
    let size = Number.POSITIVE_INFINITY;
    try {
      size = Buffer.byteLength(JSON.stringify(b.output) ?? "", "utf8");
    } catch {
      // not serialisable
    }
    if (size > MAX_OUTPUT_BYTES) errors.push(`output must be JSON of at most ${MAX_OUTPUT_BYTES} bytes`);
  }
  if (b.ephemeris != null) {
    const problem = ephemerisProblem(b.ephemeris);
    if (problem) errors.push(`ephemeris: ${problem}`);
  }
  if (b.tle != null) {
    const problem = tleProblem(b.tle);
    if (problem) errors.push(`tle: ${problem}`);
  }
  if (errors.length) return { errors };
  return {
    request: {
      time: new Date(Date.parse(b.time as string)).toISOString(),
      spacecraftId: (b.spacecraftId as string).trim(),
      modelId: (b.modelId as string).trim(),
      processorProfileId: (b.processorProfileId as string | undefined)?.trim() ?? null,
      output: b.output ?? null,
      confidence: (b.confidence as number | undefined) ?? null,
      ephemeris: (b.ephemeris as Ephemeris | undefined) ?? null,
      tle: (b.tle as [string, string] | undefined) ?? null,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------

function unknownField<T>(source: string, why: string, extra: Partial<Field<T>> = {}): Field<T> {
  return {
    value: null,
    source,
    sourceUrl: null,
    observedAt: null,
    fetchedAt: null,
    ageSeconds: null,
    confidence: "none",
    method: "unknown",
    ...extra,
    limitations: [why, ...(extra.limitations ?? [])],
  };
}

const ageSeconds = (atMs: number, iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? Math.round((atMs - t) / 1000) : null;
};

/** NOAA's own scale disagreed with Gauss's on this scale (the noaa-scales sense-check). */
function noaaDisagrees(checks: SenseCheck[], scale: "R" | "S" | "G"): string | null {
  const c = checks.find((x) => x.id === "noaa-scales" && x.status === "flag");
  return c && new RegExp(`NOAA ${scale}\\d`).test(c.reason) ? c.reason : null;
}

const flagged = (checks: SenseCheck[], idName: SenseCheck["id"]) => checks.find((c) => c.id === idName && c.status === "flag") ?? null;

function scaleField(
  reading: ScaleReading | undefined,
  atMs: number,
  fetchedAt: string,
  o: { source: string; sourceUrl: string; maxAgeMs: number; conflict: string | null; caution: SenseCheck | null; limitations: string[] },
): Field<{ level: number; label: string }> {
  const base = { source: o.source, sourceUrl: o.sourceUrl, fetchedAt };
  if (!reading || reading.level === null) {
    return unknownField(o.source, reading?.basis ? `No current reading: ${reading.basis}` : "No current reading", base);
  }
  const age = ageSeconds(atMs, reading.observedAt);
  if (age === null || age * 1000 > o.maxAgeMs) {
    return unknownField(o.source, `Reading was older than ${Math.round(o.maxAgeMs / 60_000)} min at the inference time`, { ...base, observedAt: reading.observedAt });
  }
  if (o.conflict) return unknownField(o.source, `Conflicting inputs: ${o.conflict}`, { ...base, observedAt: reading.observedAt });
  return {
    value: { level: reading.level, label: reading.label },
    ...base,
    observedAt: reading.observedAt,
    ageSeconds: age,
    confidence: o.caution ? "medium" : "high",
    method: `measured: ${reading.basis}`,
    limitations: [...o.limitations, ...(o.caution ? [`Input check flagged: ${o.caution.reason}`] : [])],
  };
}

function environmentFields(p: CanonicalSpaceWeatherPoint, atMs: number, fetchedAt: string): TrustRecord["environment"] {
  const checks = p.senseChecks ?? [];
  const spectrum = flagged(checks, "goes-proton-spectrum");
  const radiation = scaleField(p.alerts.radiation, atMs, fetchedAt, {
    source: "NOAA S-scale from GOES ≥10 MeV integral protons",
    sourceUrl: SOURCE_URL.protons,
    maxAgeMs: MAX_AGE_MS.particles,
    conflict: spectrum ? spectrum.reason : noaaDisagrees(checks, "S"),
    caution: flagged(checks, "goes-proton-channels"),
    limitations: [GEO_LIMITATION],
  });
  const kpUrl = p.indices.kpKind === "estimated-1m" ? SOURCE_URL.kp1m : SOURCE_URL.kp3h;
  const geomagnetic = scaleField(p.alerts.geomagnetic, atMs, fetchedAt, {
    source: "NOAA G-scale from planetary Kp",
    sourceUrl: kpUrl,
    maxAgeMs: MAX_AGE_MS.kp,
    conflict: noaaDisagrees(checks, "G"),
    caution: null,
    limitations: p.indices.kpKind === "planetary-3h" ? ["Last completed 3-hour Kp: can lag a rising storm by up to 3 h."] : ["Running Kp estimate for the current 3-hour interval."],
  });
  const radioBlackout = scaleField(p.alerts.radioBlackout, atMs, fetchedAt, {
    source: "NOAA R-scale from GOES 0.1–0.8 nm X-rays",
    sourceUrl: SOURCE_URL.xrays,
    maxAgeMs: MAX_AGE_MS.xrays,
    conflict: noaaDisagrees(checks, "R"),
    caution: flagged(checks, "goes-xray"),
    limitations: ["Affects dayside HF radio and GNSS links, not onboard electronics directly."],
  });

  const protons = p.particles?.protons ?? null;
  const protonAge = ageSeconds(atMs, protons?.timestamp);
  const particleFlux: TrustRecord["environment"]["particleFlux"] =
    protons && protonAge !== null && protonAge * 1000 <= MAX_AGE_MS.particles && !spectrum
      ? {
          value: { value: protons.value, unit: "pfu", channel: protons.energy, satellite: protons.satellite },
          source: `${protons.satellite ?? "GOES"} integral protons`,
          sourceUrl: SOURCE_URL.protons,
          observedAt: protons.timestamp,
          fetchedAt,
          ageSeconds: protonAge,
          confidence: flagged(checks, "goes-proton-channels") ? "medium" : "high",
          method: "measured",
          limitations: [GEO_LIMITATION, "Integral flux above 10 MeV; not a spectrum at this spacecraft."],
        }
      : unknownField("GOES integral protons", spectrum ? `Conflicting inputs: ${spectrum.reason}` : "No current GOES proton reading", { sourceUrl: SOURCE_URL.protons, fetchedAt });

  const kpAge = ageSeconds(atMs, p.indices.kpObservedAt);
  const kp: TrustRecord["environment"]["kp"] =
    p.indices.kpKind && kpAge !== null && kpAge * 1000 <= MAX_AGE_MS.kp
      ? {
          value: { value: p.indices.kp, kind: p.indices.kpKind },
          source: "NOAA planetary Kp",
          sourceUrl: kpUrl,
          observedAt: p.indices.kpObservedAt ?? null,
          fetchedAt,
          ageSeconds: kpAge,
          confidence: p.indices.kpKind === "planetary-3h" ? "high" : "medium",
          method: "measured",
          limitations: geomagnetic.limitations.filter((l) => l.startsWith("Last completed") || l.startsWith("Running")),
        }
      : unknownField("NOAA planetary Kp", "No current Kp reading", { sourceUrl: kpUrl, fetchedAt });

  const measuredDst = p.indices.dstMethod === "measured";
  const dstAge = ageSeconds(atMs, p.indices.dstObservedAt);
  const dst: TrustRecord["environment"]["dst"] =
    measuredDst && dstAge !== null && dstAge * 1000 <= MAX_AGE_MS.dst
      ? {
          value: { value: p.indices.dst },
          source: "Kyoto Dst (WDC for Geomagnetism, Kyoto) via NOAA SWPC",
          sourceUrl: SOURCE_URL.dst,
          observedAt: p.indices.dstObservedAt ?? null,
          fetchedAt,
          ageSeconds: dstAge,
          confidence: "high",
          method: "measured",
          limitations: ["Hourly index; quick-look values are revised later."],
        }
      : !measuredDst && !p.quality.stale && Number.isFinite(p.indices.dst)
        ? {
            value: { value: p.indices.dst },
            source: "Gauss nowcast model",
            sourceUrl: null,
            observedAt: p.observedAt ?? null,
            fetchedAt,
            ageSeconds: ageSeconds(atMs, p.observedAt),
            confidence: "low",
            method: `${p.indices.dstMethod}, from ${p.indices.dstDerivedFrom.join(", ") || "L1 solar wind"}`,
            limitations: ["Modelled, not measured; it under-reads intense storms (−276 vs −406 nT measured, May 2024 replay)."],
          }
        : unknownField("Dst", "No current measured or modelled Dst", { fetchedAt });

  return { radiation, geomagnetic, radioBlackout, particleFlux, kp, dst };
}

/** The orbit fields, plus the SAA tier the upset-risk band reads (null when not assessed). */
function orbitFields(req: TrustRecordRequest): { orbit: TrustRecord["orbit"]; saaTier: SaaTier | null } {
  const atMs = Date.parse(req.time);
  const noPosition = (why: string) => ({
    orbit: {
      position: unknownField<Ephemeris>("Spacecraft position", why),
      saa: unknownField<boolean>("South Atlantic Anomaly", why),
      fieldStrength: unknownField<number>(IGRF_LABEL, why),
      lShell: unknownField<number>("L-shell", why),
    },
    saaTier: null,
  });
  const fromTle = req.tle ? propagateTle(req.tle, atMs) : null;
  const tleOk = fromTle && !("error" in fromTle) ? fromTle : null;
  const tleNote = tleOk
    ? `SGP4 (satellite.js) from the TLE, epoch ${tleOk.epoch.slice(0, 16)}Z, ${Math.abs(tleOk.ageDays).toFixed(1)} days ${tleOk.ageDays >= 0 ? "before" : "after"} the inference`
    : null;

  let position: Field<Ephemeris>;
  if (req.ephemeris && !ephemerisProblem(req.ephemeris)) {
    const apart = tleOk ? distanceKm(req.ephemeris, tleOk.ephemeris) : null;
    if (apart !== null && apart > EPHEMERIS_TLE_CONFLICT_KM) {
      const why = `Conflicting inputs: the ephemeris and the TLE place the spacecraft ${Math.round(apart)} km apart (limit ${EPHEMERIS_TLE_CONFLICT_KM} km)`;
      return noPosition(why);
    }
    position = {
      value: req.ephemeris,
      source: "Supplied ephemeris",
      sourceUrl: null,
      observedAt: req.time,
      fetchedAt: null,
      ageSeconds: 0,
      confidence: "high",
      method: apart !== null ? `as supplied; agrees with the TLE to ${apart.toFixed(1)} km` : "as supplied",
      limitations: ["Read as geocentric latitude and longitude, altitude above a 6371.2 km sphere."],
    };
  } else if (tleOk) {
    position = {
      value: {
        latDeg: Math.round(tleOk.ephemeris.latDeg * 1e4) / 1e4,
        lonDeg: Math.round(tleOk.ephemeris.lonDeg * 1e4) / 1e4,
        altKm: Math.round(tleOk.ephemeris.altKm * 1e3) / 1e3,
      },
      source: "Propagated from the supplied TLE",
      sourceUrl: null,
      observedAt: tleOk.epoch,
      fetchedAt: null,
      ageSeconds: Math.round(tleOk.ageDays * 86_400),
      confidence: Math.abs(tleOk.ageDays) <= 2 ? "high" : "medium",
      method: tleNote!,
      limitations: ["SGP4 error grows with time from the TLE epoch, fastest in low orbits where drag changes."],
    };
  } else {
    const why = fromTle && "error" in fromTle ? `TLE not usable: ${fromTle.error}` : "No ephemeris or TLE given.";
    return noPosition(why);
  }

  const ctx = saaContext(atMs, position.value!);
  const nt = (v: number) => `${Math.round(v).toLocaleString("en-GB")} nT`;
  const saaSource = "South Atlantic Anomaly from IGRF-14 |B| (AMS-01 thresholds, Fiandrini et al. 2002/2003)";
  const fieldStrength: Field<number> =
    ctx.fieldNt === null
      ? unknownField(IGRF_LABEL, ctx.reason ?? "Field not computed")
      : {
          value: Math.round(ctx.fieldNt),
          source: IGRF_LABEL,
          sourceUrl: "https://www.ngdc.noaa.gov/IAGA/vmod/coeffs/igrf14coeffs.txt",
          observedAt: req.time,
          fetchedAt: null,
          ageSeconds: 0,
          confidence: "high",
          method: "spherical-harmonic synthesis to degree 13 at the position and date",
          limitations: ["Earth's internal (main) field only: no external or storm-time field."],
        };
  const saa: Field<boolean> =
    ctx.tier === null
      ? unknownField(saaSource, ctx.reason ?? "Not assessed")
      : {
          value: ctx.tier !== "outside",
          source: saaSource,
          sourceUrl: "https://doi.org/10.1029/2003JA009844",
          observedAt: req.time,
          fetchedAt: null,
          ageSeconds: 0,
          confidence: "medium",
          method:
            ctx.tier === "core"
              ? `core: |B| ${nt(ctx.fieldNt!)} ≤ ${nt(SAA_CORE_NT)}`
              : ctx.tier === "extended"
                ? `extended: |B| ${nt(ctx.fieldNt!)} between ${nt(SAA_CORE_NT)} and ${nt(SAA_EXTENDED_NT)}`
                : `outside: |B| ${nt(ctx.fieldNt!)} above ${nt(SAA_EXTENDED_NT)}`,
          limitations: [
            "Thresholds set by AMS-01 at about 320–390 km; a context flag for likely trapped protons, not a flux model.",
            "Uses the IGRF-14 main field, so the SAA's westward drift (about 0.3° a year) is followed.",
          ],
        };

  const orbit: TrustRecord["orbit"] = {
    position,
    saa,
    fieldStrength,
    lShell: {
      value: Math.round(dipoleLShell(position.value!) * 1000) / 1000,
      source: position.source === "Supplied ephemeris" ? "Computed from the supplied ephemeris" : "Computed from the TLE-propagated position",
      sourceUrl: null,
      observedAt: req.time,
      fetchedAt: null,
      ageSeconds: 0,
      confidence: "medium",
      method: "centred-dipole L = (r/RE)/cos²(magnetic latitude), IGRF-14 2025 dipole pole",
      limitations: ["Centred-dipole approximation: differs most from the full-field L where the field is least dipolar, including the South Atlantic Anomaly."],
    },
  };
  return { orbit, saaTier: ctx.tier };
}

// ---------------------------------------------------------------------------------------
// Verdict and record
// ---------------------------------------------------------------------------------------

function verdictFor(env: TrustRecord["environment"], orbit: TrustRecord["orbit"], checks: TrustRecord["checks"], policy: TrustPolicy, envReason: string | null) {
  const unknown: string[] = [];
  if (envReason) unknown.push(envReason);
  else {
    if (env.radiation.value === null) unknown.push(`Radiation level unknown: ${env.radiation.limitations[0]}`);
    if (env.geomagnetic.value === null) unknown.push(`Geomagnetic level unknown: ${env.geomagnetic.limitations[0]}`);
  }
  if (policy.requireOrbitContext && orbit.saa.value === null) unknown.push(`Orbit context required by the policy but unknown: ${orbit.saa.limitations[0]}`);
  const notes = orbit.saa.value === null ? [`South Atlantic Anomaly not assessed: ${orbit.saa.limitations[0]}`] : [];
  if (unknown.length) return { value: "unknown" as const, reasons: [...unknown, ...notes] };

  const degraded: string[] = [];
  const s = env.radiation.value!;
  const g = env.geomagnetic.value!;
  if (s.level >= policy.degradedAtRadiation) degraded.push(`Radiation storm ${s.label} at geostationary orbit when the inference ran`);
  if (g.level >= policy.degradedAtGeomagnetic) degraded.push(`Geomagnetic storm ${g.label}`);
  if (orbit.saa.value === true) degraded.push(`Spacecraft inside the South Atlantic Anomaly (${orbit.saa.method})`);
  for (const c of checks.filter((x) => x.status === "flag")) degraded.push(`Input check flagged (${c.id}): ${c.reason}`);
  if (degraded.length) return { value: "degraded-context" as const, reasons: [...degraded, ...notes] };
  return {
    value: "consistent" as const,
    reasons: [
      `Radiation ${s.label} and geomagnetic ${g.label}, below the policy thresholds (S${policy.degradedAtRadiation}, G${policy.degradedAtGeomagnetic}); required inputs current and unflagged`,
      ...notes,
    ],
  };
}

export const RECORD_LIMITATIONS = [
  "This record describes the space environment when the inference ran. It says nothing about the spacecraft's hardware or whether the output was right.",
  "Radiation and particle readings come from GOES at geostationary orbit, not from this spacecraft's orbit.",
  "Advisory only: Gauss has no telecommand authority over any spacecraft.",
  "No regulatory or compliance claim is made.",
];

/** Words a record must never use: it describes the environment, not harm to hardware or odds of error. */
const BANNED = /\b(doses?|damaged?|failure probability|probability of failure|qualified|qualification|flight[- ]ready|space[- ]qualified|certified|compliant)\b/i;

/** Banned words in the Gauss-authored text of a record (the customer's own output is not scanned). */
export function bannedWording(record: Omit<TrustRecord, "hash">): string[] {
  const { inference: _inference, ...authored } = record;
  const hits: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const m = BANNED.exec(v);
      if (m) hits.push(m[0]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(authored);
  return hits;
}

/** Canonical JSON: keys sorted, so the same record always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function buildTrustRecord(
  req: TrustRecordRequest,
  history: EnvironmentHistory,
  options: { nowMs: number; policy?: TrustPolicy },
): TrustRecord {
  const policy = options.policy ?? DEFAULT_POLICY;
  const atMs = Date.parse(req.time);
  let envReason: string | null = null;
  let env: TrustRecord["environment"];
  let checks: TrustRecord["checks"] = [];
  const at = atMs > options.nowMs + 60_000 ? null : history.at(atMs);
  if (atMs > options.nowMs + 60_000) envReason = "Inference time is in the future";
  else if (!at) envReason = `Gauss held no reading within ${MAX_READING_LAG_MS / 60_000} min before the inference (${history.label})`;
  if (at) {
    env = environmentFields(at.point, atMs, at.issuedAt);
    checks = (at.point.senseChecks ?? []).map((c) => ({ id: c.id, status: c.status, reason: c.reason }));
  } else {
    const why = envReason ?? "No reading";
    env = {
      radiation: unknownField("NOAA S-scale", why),
      geomagnetic: unknownField("NOAA G-scale", why),
      radioBlackout: unknownField("NOAA R-scale", why),
      particleFlux: unknownField("GOES integral protons", why),
      kp: unknownField("NOAA planetary Kp", why),
      dst: unknownField("Dst", why),
    };
  }
  const { orbit, saaTier } = orbitFields(req);
  const upsetRisk = upsetRiskField(
    req.processorProfileId,
    {
      saaTier,
      saaWhy: orbit.saa.limitations[0] ?? "Not assessed",
      sLevel: env.radiation.value?.level ?? null,
      sWhy: env.radiation.limitations[0] ?? "No reading",
      gLevel: env.geomagnetic.value?.level ?? null,
      gWhy: env.geomagnetic.limitations[0] ?? "No reading",
      lShell: orbit.lShell.value,
    },
    { time: req.time, fetchedAt: env.radiation.fetchedAt },
  );
  const verdict = verdictFor(env, orbit, checks, policy, envReason);

  const body: Omit<TrustRecord, "hash" | "recordId"> = {
    schema: TRUST_RECORD_SCHEMA,
    generatedAt: new Date(options.nowMs).toISOString(),
    inference: {
      time: req.time,
      spacecraftId: req.spacecraftId,
      modelId: req.modelId,
      processorProfileId: req.processorProfileId ?? null,
      output: req.output ?? null,
      confidence: req.confidence ?? null,
      ingest: req.ingest ?? null,
    },
    environmentSource: history.label,
    environment: env,
    orbit,
    upsetRisk,
    checks,
    verdict: { ...verdict, policy },
    limitations: RECORD_LIMITATIONS,
  };
  const recordId = `tr_${createHash("sha256").update(canonicalJson({ i: body.inference, e: at?.issuedAt ?? null, s: history.label })).digest("hex").slice(0, 20)}`;
  const unsigned = { ...body, recordId };
  const banned = bannedWording(unsigned);
  if (banned.length) throw new Error(`Trust record would use banned wording: ${banned.join(", ")}`);
  return { ...unsigned, hash: createHash("sha256").update(canonicalJson(unsigned)).digest("hex") };
}
