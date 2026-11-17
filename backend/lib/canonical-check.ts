import { OBSERVED_AT_MAX_LEAD_MS, PLAUSIBLE } from "../../shared/policy/limits.js";
import type { CanonicalSpaceWeatherPoint } from "../types.js";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const time = (v: unknown): number | null => (typeof v === "string" && v ? (Number.isFinite(Date.parse(v)) ? Date.parse(v) : null) : null);

/**
 * Why a canonical point is not a usable observation, or [] when it is (GAU-244). Pure: no clock, no I/O.
 * Checks what the buffer, its reload and the learning job rely on: an issue time, a measurement time
 * (observedAt, not later than the issue time beyond clock skew), finite vectors, and solar-wind and
 * index values inside the shared physical limits. Fills (-999.9, -9999, -1e5) fail the ranges.
 */
export function canonicalPointProblems(p: CanonicalSpaceWeatherPoint): string[] {
  const out: string[] = [];
  const issued = time(p?.timestamp);
  if (issued === null) out.push("timestamp missing or not a time");
  const observed = time(p?.observedAt);
  if (observed === null) out.push("observedAt missing or not a time");
  else if (issued !== null && observed - issued > OBSERVED_AT_MAX_LEAD_MS) out.push("observedAt is later than the point's timestamp");

  const v = p?.velocity;
  const b = p?.magneticField;
  if (![v?.x, v?.y, v?.z, v?.magnitude].every(finite)) out.push("velocity not finite");
  if (![b?.x, b?.y, b?.z, b?.bt].every(finite)) out.push("magnetic field not finite");
  else if (Math.abs(b.bt) > PLAUSIBLE.fieldMaxNt) out.push(`|B| ${b.bt} nT above ${PLAUSIBLE.fieldMaxNt}`);

  const speed = p?.solarWind?.speed;
  if (!finite(speed) || speed < PLAUSIBLE.speedMin || speed > PLAUSIBLE.speedMax) {
    out.push(`speed ${speed} km/s outside ${PLAUSIBLE.speedMin}-${PLAUSIBLE.speedMax}`);
  }
  const density = p?.solarWind?.density;
  if (!finite(density) || density < PLAUSIBLE.densityMin || density > PLAUSIBLE.densityMax) {
    out.push(`density ${density} cm^-3 outside ${PLAUSIBLE.densityMin}-${PLAUSIBLE.densityMax}`);
  }
  const kp = p?.indices?.kp;
  if (kp !== null && (!finite(kp) || kp < PLAUSIBLE.kpMin || kp > PLAUSIBLE.kpMax)) out.push(`Kp ${kp} outside ${PLAUSIBLE.kpMin}-${PLAUSIBLE.kpMax}`);
  const dst = p?.indices?.dst;
  if (!finite(dst) || dst < PLAUSIBLE.dstMinNt || dst > PLAUSIBLE.dstMaxNt) out.push(`Dst ${dst} nT outside ${PLAUSIBLE.dstMinNt}-${PLAUSIBLE.dstMaxNt}`);
  return out;
}
