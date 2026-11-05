/**
 * South Atlantic Anomaly flag (GAU-141) from the IGRF-14 field strength at the spacecraft.
 *
 * The SAA is where the weak field lets the inner radiation belt reach low orbits. AMS-01 (STS-91,
 * 370–390 km, 51.7°) defined it by the local field: B ≤ 0.26 G, with 0.21 ≤ B ≤ 0.26 G as the
 * regions near it (Fiandrini et al., IJMPA 17, 1655 (2002), doi:10.1142/S0217751X02011151;
 * JGR 108(A11) (2003), doi:10.1029/2003JA009844). Hence two tiers: core (≤ 21,000 nT) and
 * extended (≤ 26,000 nT). IGRF's secular variation carries the SAA's westward drift, about 0.3°
 * a year (Fürst et al., EPSL 281, 125 (2009), doi:10.1016/j.epsl.2009.02.004).
 *
 * The thresholds were set at about 320–390 km. |B| falls with height, so a fixed threshold
 * covers more area higher up: the flag is applied only from SAA_MIN_ALT_KM to SAA_MAX_ALT_KM and
 * reads unknown elsewhere. It is context for when trapped protons are likely, not a flux model.
 */
import { IGRF_LABEL, igrfAt } from "../physics/igrf.js";
import { RE_KM, type Ephemeris } from "./orbit.js";

export const SAA_CORE_NT = 21_000;
export const SAA_EXTENDED_NT = 26_000;
export const SAA_MIN_ALT_KM = 300;
export const SAA_MAX_ALT_KM = 450;

export type SaaTier = "core" | "extended" | "outside";

export interface SaaContext {
  /** IGRF-14 total intensity at the position, nT; null outside IGRF's 2015–2030 validity. */
  fieldNt: number | null;
  /** Null when the flag can't be applied, with `reason`. */
  tier: SaaTier | null;
  reason: string | null;
}

export function saaContext(ms: number, e: Ephemeris): SaaContext {
  const f = igrfAt(ms, e.latDeg, e.lonDeg, RE_KM + e.altKm);
  if (!f) return { fieldNt: null, tier: null, reason: `${IGRF_LABEL} covers 2015 to 2030 only` };
  const fieldNt = f.total;
  if (e.altKm < SAA_MIN_ALT_KM || e.altKm > SAA_MAX_ALT_KM) {
    return {
      fieldNt,
      tier: null,
      reason: `The B thresholds were set at about 320–390 km; not applied at ${Math.round(e.altKm)} km (range ${SAA_MIN_ALT_KM}–${SAA_MAX_ALT_KM} km)`,
    };
  }
  const tier: SaaTier = fieldNt <= SAA_CORE_NT ? "core" : fieldNt <= SAA_EXTENDED_NT ? "extended" : "outside";
  return { fieldNt, tier, reason: null };
}
