/**
 * Sense-checks on the inputs behind each point (GAU-136): physical consistency the
 * instruments must satisfy, and NOAA's own scales as an independent cross-check.
 * A check that fails reports why; the sample is not dropped, and an input with nothing
 * current to check reads "unknown", never "pass".
 */
import { magnitude, type Vector3 } from "../physics/coordinates.js";
import type { ParticleReading, ScaleReading, SenseCheck } from "../types.js";

const utc = (ms: number) => new Date(ms).toISOString().slice(11, 16);

// ---------------------------------------------------------------------------------------
// L1 magnetic field
// ---------------------------------------------------------------------------------------

/**
 * Bt in the RTSW files is the mean of the 1-s magnitudes, so it can't be smaller than the
 * magnitude of the averaged components (they only cancel). On 2026-10-19 Bt − |B| ran from
 * −0.04 nT (rounding) to +1.36 nT (field direction turning within the minute), so only
 * "below" is impossible. A rotation from GSE to GSM can't change |B|; there the two differed
 * by at most 0.17 nT.
 */
export const FIELD_TOLERANCE = { btAbsNt: 0.1, btRel: 0.02, frameAbsNt: 0.3, frameRel: 0.05 } as const;

export interface FieldSample {
  t: number;
  bt?: number | null;
  magneticFieldGse: Vector3;
  magneticFieldGsm: Vector3 | null;
}

/** Why one field sample is inconsistent, or null when it is consistent (or has nothing to compare). */
export function fieldSampleProblem(s: FieldSample): string | null {
  const b = magnitude(s.magneticFieldGse);
  if (typeof s.bt === "number" && Number.isFinite(s.bt)) {
    const tolerance = Math.max(FIELD_TOLERANCE.btAbsNt, FIELD_TOLERANCE.btRel * b);
    if (s.bt < b - tolerance) {
      return `Bt ${s.bt.toFixed(2)} nT is below |B| ${b.toFixed(2)} nT from its components, which is impossible for a mean of magnitudes`;
    }
  }
  if (s.magneticFieldGsm) {
    const g = magnitude(s.magneticFieldGsm);
    if (Math.abs(g - b) > Math.max(FIELD_TOLERANCE.frameAbsNt, FIELD_TOLERANCE.frameRel * b)) {
      return `|B| is ${b.toFixed(2)} nT in GSE but ${g.toFixed(2)} nT in GSM; a change of frame can't change it`;
    }
  }
  return null;
}

const checkable = (s: FieldSample) =>
  (typeof s.bt === "number" && Number.isFinite(s.bt)) || s.magneticFieldGsm !== null;

/** The field samples measured in (endMs − windowMs, endMs], checked minute by minute. */
export function checkFieldMagnitude(
  series: FieldSample[],
  spacecraft: string | undefined,
  endMs: number,
  windowMs = 30 * 60_000,
): SenseCheck {
  const window = series.filter((s) => s.t > endMs - windowMs && s.t <= endMs && checkable(s));
  const id = "l1-field-magnitude";
  if (window.length === 0) {
    return { id, status: "unknown", reason: "No current L1 field samples to check", observedAt: null };
  }
  const flagged = window.map((s) => ({ s, problem: fieldSampleProblem(s) })).filter((x) => x.problem);
  const observedAt = new Date(window[window.length - 1].t).toISOString();
  const minutes = Math.round(windowMs / 60_000);
  const who = spacecraft ? `${spacecraft} ` : "";
  if (flagged.length === 0) {
    return {
      id,
      status: "pass",
      reason: `${who}Bt and |B| agree in all ${window.length} samples of the last ${minutes} min`,
      observedAt,
      checked: window.length,
      flagged: 0,
    };
  }
  const last = flagged[flagged.length - 1];
  return {
    id,
    status: "flag",
    reason: `${who}field inconsistent in ${flagged.length} of ${window.length} samples (last ${minutes} min); at ${utc(last.s.t)} UTC: ${last.problem}`,
    observedAt,
    checked: window.length,
    flagged: flagged.length,
  };
}

// ---------------------------------------------------------------------------------------
// L1 plasma tracking
// ---------------------------------------------------------------------------------------

/**
 * A plasma instrument can stop following the solar wind while the magnetometer still does
 * (GAU-153). In the January 2026 replay, during the S4 proton event, ACE's speed stayed within
 * ~10 km/s (5th–95th percentile, 282–293 km/s) from 18:20 to 21:10 UT, while |B| jumped from
 * about 9 to 55 nT with a shock that published lists put at ΔV 670 km/s. Real wind can hold its
 * speed while |B| doubles (a field rotation or a current sheet), so the field must at least
 * triple, to 20 nT or more. With ×2 alone, 7 minutes of steady pre-shock wind in the May 2024
 * replay flagged. With ×3 and 20 nT, May and October 2024 flag nothing, and January 2026 flags
 * 19:07–21:13 UT.
 */
export const PLASMA_TRACKING = { windowMin: 60, minSamples: 30, speedSpreadKmS: 15, fieldRatio: 3, minFieldNt: 20 } as const;

export interface PlasmaTracking {
  /** 5th–95th percentile spread of the speed, km/s. */
  speedSpreadKmS: number;
  /** 5th and 95th percentile of |B|, nT. */
  fieldLowNt: number;
  fieldHighNt: number;
  /** The speed held while the field rose by PLASMA_TRACKING.fieldRatio to minFieldNt or more. */
  notTracking: boolean;
}

const percentile = (sorted: number[], q: number) => sorted[Math.floor(q * (sorted.length - 1))];

/** Whether the speed followed the field over these minutes; null with too few samples. */
export function plasmaTracking(speeds: number[], fields: number[]): PlasmaTracking | null {
  const sp = speeds.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const bt = fields.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  if (sp.length < PLASMA_TRACKING.minSamples || bt.length < PLASMA_TRACKING.minSamples) return null;
  const speedSpreadKmS = percentile(sp, 0.95) - percentile(sp, 0.05);
  const fieldLowNt = percentile(bt, 0.05);
  const fieldHighNt = percentile(bt, 0.95);
  const notTracking =
    speedSpreadKmS < PLASMA_TRACKING.speedSpreadKmS &&
    fieldHighNt >= PLASMA_TRACKING.minFieldNt &&
    fieldHighNt / Math.max(fieldLowNt, 1) >= PLASMA_TRACKING.fieldRatio;
  return { speedSpreadKmS, fieldLowNt, fieldHighNt, notTracking };
}

export interface PlasmaSample {
  t: number;
  speed: number | null | undefined;
  /** |B|, nT. */
  bt: number | null | undefined;
}

/** Whether the L1 speed followed the field over (endMs − windowMs, endMs]. */
export function checkPlasmaTracking(
  series: PlasmaSample[],
  spacecraft: string | undefined,
  endMs: number,
  windowMs = PLASMA_TRACKING.windowMin * 60_000,
): SenseCheck {
  const id = "l1-plasma-tracking";
  const window = series.filter((s) => s.t > endMs - windowMs && s.t <= endMs);
  const minutes = Math.round(windowMs / 60_000);
  const tracking = plasmaTracking(
    window.map((s) => s.speed ?? Number.NaN),
    window.map((s) => s.bt ?? Number.NaN),
  );
  if (!tracking) {
    return { id, status: "unknown", reason: `Too few L1 plasma and field samples in the last ${minutes} min to check`, observedAt: null };
  }
  const observedAt = new Date(window[window.length - 1].t).toISOString();
  const who = spacecraft ? `${spacecraft} ` : "";
  const field = `${tracking.fieldLowNt.toFixed(1)}–${tracking.fieldHighNt.toFixed(1)} nT`;
  if (tracking.notTracking) {
    return {
      id,
      status: "flag",
      reason: `${who}speed held within ${tracking.speedSpreadKmS.toFixed(0)} km/s while |B| went ${field} (last ${minutes} min): the plasma reading isn't following the field, so speed and density are suspect`,
      observedAt,
      checked: window.length,
      flagged: window.length,
    };
  }
  return {
    id,
    status: "pass",
    reason: `${who}speed varied ${tracking.speedSpreadKmS.toFixed(0)} km/s with |B| ${field} over the last ${minutes} min`,
    observedAt,
    checked: window.length,
    flagged: 0,
  };
}

// ---------------------------------------------------------------------------------------
// GOES protons
// ---------------------------------------------------------------------------------------

/**
 * Integral flux counts every particle above the threshold, so it can't rise with energy.
 * At background the channels sit close together (≥100/≥50 MeV reached 0.994 on 2026-10-19),
 * so 5 % plus 0.02 pfu is allowed for counting noise.
 */
export const SPECTRUM_TOLERANCE = { rel: 0.05, absPfu: 0.02 } as const;

/** `readings` in increasing energy, all from one GOES time step; nulls are channels with no valid value. */
export function checkProtonSpectrum(readings: Array<ParticleReading | null>): SenseCheck {
  const id = "goes-proton-spectrum";
  const valid = readings.filter((r): r is ParticleReading => r !== null);
  if (valid.length < 2) {
    return { id, status: "unknown", reason: "Fewer than two GOES proton channels to compare", observedAt: valid[0]?.timestamp ?? null };
  }
  const problems: string[] = [];
  for (let i = 1; i < valid.length; i += 1) {
    const lo = valid[i - 1];
    const hi = valid[i];
    if (hi.value > lo.value * (1 + SPECTRUM_TOLERANCE.rel) + SPECTRUM_TOLERANCE.absPfu) {
      problems.push(`${hi.energy} ${fmtPfu(hi.value)} pfu exceeds ${lo.energy} ${fmtPfu(lo.value)} pfu`);
    }
  }
  const observedAt = valid[valid.length - 1].timestamp;
  const channels = valid.map((r) => r.energy).join(", ");
  return problems.length === 0
    ? { id, status: "pass", reason: `Integral flux falls with energy across ${channels}`, observedAt, checked: valid.length, flagged: 0 }
    : {
        id,
        status: "flag",
        reason: `${problems.join("; ")}: an integral spectrum can't rise with energy, so a channel is wrong`,
        observedAt,
        checked: valid.length,
        flagged: problems.length,
      };
}

/** A real channel always varies in its last digits; this many identical samples in a row means saturated or stuck. */
export const FLAT_RUN = 4;

type Rec = Record<string, unknown>;

const isFill = (flux: unknown) => typeof flux !== "number" || !Number.isFinite(flux) || flux < 0;

/**
 * Fill values and flat-lined channels in a GOES integral-flux file (5-min rows, any order).
 * Flags a channel whose newest row is a fill or whose newest FLAT_RUN valid values are
 * identical; older fills are counted in the reason, not flagged.
 */
export function checkChannelRows(data: unknown, channels: readonly string[], id: SenseCheck["id"], unit: string): SenseCheck {
  const rows = Array.isArray(data) ? (data.filter((r) => r && typeof r === "object") as Rec[]) : [];
  const problems: string[] = [];
  let checked = 0;
  let fills = 0;
  let newest = -Infinity;
  for (const energy of channels) {
    const own = rows
      .filter((r) => r.energy === energy && typeof r.time_tag === "string" && Number.isFinite(Date.parse(r.time_tag)))
      .sort((a, b) => Date.parse(a.time_tag as string) - Date.parse(b.time_tag as string));
    if (own.length === 0) continue;
    checked += own.length;
    const channelFills = own.filter((r) => isFill(r.flux)).length;
    fills += channelFills;
    const last = own[own.length - 1];
    newest = Math.max(newest, Date.parse(last.time_tag as string));
    if (isFill(last.flux)) {
      problems.push(`newest ${energy} sample (${utc(Date.parse(last.time_tag as string))} UTC) is a fill value`);
      continue;
    }
    const values = own.filter((r) => !isFill(r.flux)).map((r) => r.flux as number);
    const tail = values.slice(-FLAT_RUN);
    if (tail.length === FLAT_RUN && tail[0] > 0 && tail.every((v) => v === tail[0])) {
      problems.push(`${energy} has read exactly ${tail[0]} ${unit} for ${FLAT_RUN} samples: saturated or stuck`);
    }
  }
  if (checked === 0) {
    return { id, status: "unknown", reason: `No GOES ${channels.join("/")} rows to check`, observedAt: null };
  }
  const observedAt = new Date(newest).toISOString();
  const skipped = fills > 0 ? `; ${fills} fill value${fills === 1 ? "" : "s"} in the file skipped` : "";
  return problems.length === 0
    ? { id, status: "pass", reason: `${channels.join(", ")}: current and varying${skipped}`, observedAt, checked, flagged: fills }
    : { id, status: "flag", reason: `${problems.join("; ")}${skipped}`, observedAt, checked, flagged: fills + problems.length };
}

const fmtPfu = (v: number) => (v >= 100 ? Math.round(v).toLocaleString("en-GB") : v.toPrecision(2));

// ---------------------------------------------------------------------------------------
// NOAA's own scales
// ---------------------------------------------------------------------------------------

export interface NoaaScales {
  R: number | null;
  S: number | null;
  G: number | null;
  /** NOAA's stamp for the "latest observed" entry (UTC). */
  observedAt: string | null;
}

/** NOAA scales older than this aren't compared; the product normally updates every few minutes. */
export const NOAA_SCALES_MAX_AGE_MS = 60 * 60_000;

/**
 * Gauss's own R, S and G levels against NOAA's latest observed scales. NOAA is the
 * cross-check, not the source of record: a disagreement is flagged with both values
 * (timing alone can cause one around a threshold) and Gauss's levels are not changed.
 */
export function compareScales(
  noaa: NoaaScales | null,
  gauss: { R?: ScaleReading; S?: ScaleReading; G?: ScaleReading },
  nowMs: number,
): SenseCheck {
  const id = "noaa-scales";
  if (!noaa || !noaa.observedAt) return { id, status: "unknown", reason: "NOAA scales not available", observedAt: null };
  const age = nowMs - Date.parse(noaa.observedAt);
  if (!Number.isFinite(age) || age > NOAA_SCALES_MAX_AGE_MS) {
    return { id, status: "unknown", reason: "NOAA scales are older than 1 h", observedAt: noaa.observedAt };
  }
  const agree: string[] = [];
  const differ: string[] = [];
  const unchecked: string[] = [];
  for (const scale of ["R", "S", "G"] as const) {
    const theirs = noaa[scale];
    const ours = gauss[scale];
    if (theirs === null || !ours || ours.level === null) {
      unchecked.push(scale);
    } else if (theirs === ours.level) {
      agree.push(`${scale}${theirs}`);
    } else {
      differ.push(`NOAA ${scale}${theirs}, Gauss ${ours.label} (${ours.basis})`);
    }
  }
  const tail = unchecked.length ? `; ${unchecked.join(", ")} not compared (unknown on one side)` : "";
  if (differ.length > 0) {
    return { id, status: "flag", reason: `${differ.join("; ")}${tail}`, observedAt: noaa.observedAt, checked: 3 - unchecked.length, flagged: differ.length };
  }
  if (agree.length === 0) {
    return { id, status: "unknown", reason: `Nothing to compare${tail}`, observedAt: noaa.observedAt };
  }
  return { id, status: "pass", reason: `NOAA agrees: ${agree.join(" ")}${tail}`, observedAt: noaa.observedAt, checked: agree.length, flagged: 0 };
}

/** A check from an older fetch is unknown once its input is older than `maxAgeMs`. */
export function expireCheck(check: SenseCheck, nowMs: number, maxAgeMs: number, what: string): SenseCheck {
  const t = check.observedAt ? Date.parse(check.observedAt) : Number.NaN;
  if (check.status !== "unknown" && (!Number.isFinite(t) || nowMs - t > maxAgeMs)) {
    return { id: check.id, status: "unknown", reason: `${what} older than ${Math.round(maxAgeMs / 60_000)} min`, observedAt: check.observedAt };
  }
  return check;
}
