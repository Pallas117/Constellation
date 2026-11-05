/**
 * NOAA space-weather scales for the two storm streams Gauss keeps apart.
 *
 * Radiation storms (S-scale) and geomagnetic storms (G-scale) come from the
 * same Sun but are only loosely coupled in time, and they call for different
 * actions: on 19 Jan 2026 GOES protons were at S2–S3 from 04:40 UT while Kp
 * stayed below 5 (G0) until 18 UT; both then peaked together at S4 and G4
 * (backend/replay, GAU-138). Bit errors
 * and detector hits follow the particle (S) stream; induced currents, drag and
 * GNSS/HF effects follow the geomagnetic (G) stream. Radio blackouts (R-scale)
 * follow solar X-rays and reach Earth with the light, before either storm.
 * A missing or stale input is unknown (level null), never "no storm".
 *
 * Scales: https://www.swpc.noaa.gov/noaa-scales-explanation
 */
import type { CanonicalSpaceWeatherPoint, ParticleReading, ScaleReading, XrayReading } from "../types.js";
import { freshnessLabel, freshnessMs, type FreshnessKey } from "../../shared/policy/freshness.js";

/** NOAA S-scale lower bounds on the GOES ≥10 MeV integral proton flux, in pfu (S1…S5). */
export const S_SCALE_PFU = [10, 1e2, 1e3, 1e4, 1e5] as const;
export const S_SCALE_CHANNEL = ">=10 MeV";

type KpKind = CanonicalSpaceWeatherPoint["indices"]["kpKind"];

/**
 * A Kp value older than this is not current: the completed 3-hour Kp's bound, the longest a
 * Kp reading is used (see currentKp in adapters/noaa-swpc.ts).
 */
export const KP_MAX_AGE_MS = freshnessMs("kp_planetary_3h");

/**
 * The freshness rule for a Kp reading of either NOAA product: the running estimate is published
 * every minute, so it expires sooner than a completed 3-hour value. An unknown product gets the
 * shorter bound.
 */
export const kpFreshnessKey = (kind: KpKind): FreshnessKey => (kind === "planetary-3h" ? "kp_planetary_3h" : "kp_estimated_1m");

/** Maximum age of a Kp reading of `kind`, in ms. */
export const kpMaxAgeMs = (kind: KpKind): number => freshnessMs(kpFreshnessKey(kind));

/**
 * A Kp reading only while it is within its product's freshness bound at `nowMs`, else null
 * (GAU-232). The nowcast, the storm tier and forecast scoring use this, so a Kp of 6 from
 * yesterday can't hold a severe tier: past the bound Kp is unknown and the tier falls back to
 * Bz and the Dst slope (GAU-230).
 */
export function currentKpReading<R extends { value: number; observedAt: string | null; kind: NonNullable<KpKind> }>(
  reading: R | null | undefined,
  nowMs: number,
): R | null {
  if (!reading?.observedAt || !Number.isFinite(reading.value)) return null;
  const age = nowMs - Date.parse(reading.observedAt);
  return Number.isFinite(age) && age <= kpMaxAgeMs(reading.kind) ? reading : null;
}

const UNKNOWN = (scale: "S" | "G" | "R", basis: string, observedAt: string | null = null): ScaleReading => ({
  level: null,
  label: `${scale}?`,
  basis,
  observedAt,
});

/**
 * Radiation storm level from the ≥10 MeV proton reading already on the point.
 * The reading is null when GOES is missing or older than its freshness limit.
 */
export function radiationStorm(protons: ParticleReading | null | undefined): ScaleReading {
  if (!protons) return UNKNOWN("S", "No current GOES ≥10 MeV proton reading");
  if (protons.energy !== S_SCALE_CHANNEL || !Number.isFinite(protons.value) || protons.value < 0) {
    return UNKNOWN("S", `GOES reading is not the ${S_SCALE_CHANNEL} channel`, protons.timestamp);
  }
  const level = S_SCALE_PFU.filter((bound) => protons.value >= bound).length as ScaleReading["level"];
  return {
    level,
    label: `S${level}`,
    basis: `GOES ${S_SCALE_CHANNEL} protons ${formatFlux(protons.value)} pfu`,
    observedAt: protons.timestamp,
  };
}

/**
 * Geomagnetic storm level from planetary Kp: G1 at Kp 5 … G5 at Kp 9. Fractional
 * Kp (4.67 for "5−") is floored, matching the readouts in the frontend.
 * Only a current NOAA Kp reading counts: a point with no Kp (null) or no reading time is unknown.
 */
export function geomagneticStorm(indices: CanonicalSpaceWeatherPoint["indices"], nowMs: number): ScaleReading {
  const observedAt = indices.kpObservedAt ?? null;
  const kp = indices.kp;
  if (kp === null || !indices.kpKind || !observedAt) return UNKNOWN("G", "No NOAA Kp reading");
  const age = nowMs - Date.parse(observedAt);
  if (!Number.isFinite(age) || age > kpMaxAgeMs(indices.kpKind)) {
    return UNKNOWN("G", `Kp reading is older than ${freshnessLabel(kpFreshnessKey(indices.kpKind))}`, observedAt);
  }
  if (!Number.isFinite(kp)) return UNKNOWN("G", "Kp is not a number", observedAt);
  const level = Math.min(5, Math.max(0, Math.floor(kp) - 4)) as ScaleReading["level"];
  const kind = indices.kpKind === "estimated-1m" ? "running 3-hour estimate" : "last completed 3-hour Kp";
  return {
    level,
    label: `G${level}`,
    basis: `Kp ${kp.toFixed(2)} (${kind})`,
    observedAt,
  };
}

/** NOAA R-scale lower bounds on the GOES 0.1–0.8 nm X-ray flux, W m^-2: M1, M5, X1, X10, X20 (R1…R5). */
export const R_SCALE_WM2 = [1e-5, 5e-5, 1e-4, 1e-3, 2e-3] as const;
export const XRAY_BAND = "0.1-0.8nm";

/** Flare class of an X-ray flux: A < 1e-7 ≤ B < 1e-6 ≤ C < 1e-5 ≤ M < 1e-4 ≤ X, e.g. 5.7e-7 → "B5.7". */
export function flareClass(wm2: number): string {
  if (!Number.isFinite(wm2) || wm2 <= 0) return "?";
  const classes: Array<[string, number]> = [["X", 1e-4], ["M", 1e-5], ["C", 1e-6], ["B", 1e-7]];
  const [letter, base] = classes.find(([, b]) => wm2 >= b) ?? ["A", 1e-8];
  // Truncate, so a flux just under a class boundary never reads as the next class; the
  // epsilon absorbs float division error (3e-6 / 1e-6 = 2.9999999999999996).
  const n = wm2 / base + 1e-9;
  return `${letter}${n >= 10 ? Math.floor(n) : (Math.floor(n * 10) / 10).toFixed(1)}`;
}

/**
 * Radio blackout level from the GOES long-band X-ray reading already on the point.
 * The reading is null when GOES X-rays are missing or older than their freshness limit.
 */
export function radioBlackout(xray: XrayReading | null | undefined): ScaleReading {
  if (!xray) return UNKNOWN("R", "No current GOES X-ray reading");
  if (xray.band !== XRAY_BAND || !Number.isFinite(xray.value) || xray.value <= 0) {
    return UNKNOWN("R", `GOES reading is not the ${XRAY_BAND} band`, xray.timestamp);
  }
  const level = R_SCALE_WM2.filter((bound) => xray.value >= bound).length as ScaleReading["level"];
  return {
    level,
    label: `R${level}`,
    basis: `GOES ${XRAY_BAND} X-rays ${xray.value.toExponential(1)} W/m² (${flareClass(xray.value)})`,
    observedAt: xray.timestamp,
  };
}

function formatFlux(pfu: number): string {
  return pfu >= 100 ? Math.round(pfu).toLocaleString("en-GB") : pfu.toPrecision(2);
}
