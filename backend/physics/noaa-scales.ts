/**
 * NOAA space-weather scales for the two storm streams Gauss keeps apart.
 *
 * Radiation storms (S-scale) and geomagnetic storms (G-scale) come from the
 * same Sun but are only loosely coupled, and they call for different actions:
 * the 19 Jan 2026 S4 radiation storm came with only Dst −236 nT. Bit errors
 * and detector hits follow the particle (S) stream; induced currents, drag and
 * GNSS/HF effects follow the geomagnetic (G) stream. A missing or stale input
 * is unknown (level null), never "no storm".
 *
 * Scales: https://www.swpc.noaa.gov/noaa-scales-explanation
 */
import type { CanonicalSpaceWeatherPoint, ParticleReading, ScaleReading } from "../types.js";

/** NOAA S-scale lower bounds on the GOES ≥10 MeV integral proton flux, in pfu (S1…S5). */
export const S_SCALE_PFU = [10, 1e2, 1e3, 1e4, 1e5] as const;
export const S_SCALE_CHANNEL = ">=10 MeV";

/**
 * A Kp value older than this is not current. The completed 3-hour Kp is used for
 * up to 6 h (see currentKp in adapters/noaa-swpc.ts), so the same bound applies.
 */
export const KP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const UNKNOWN = (scale: "S" | "G", basis: string, observedAt: string | null = null): ScaleReading => ({
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
 * Only a current NOAA Kp reading counts: points without one carry a placeholder.
 */
export function geomagneticStorm(indices: CanonicalSpaceWeatherPoint["indices"], nowMs: number): ScaleReading {
  const observedAt = indices.kpObservedAt ?? null;
  if (!indices.kpKind || !observedAt) return UNKNOWN("G", "No NOAA Kp reading");
  const age = nowMs - Date.parse(observedAt);
  if (!Number.isFinite(age) || age > KP_MAX_AGE_MS) return UNKNOWN("G", "Kp reading is older than 6 h", observedAt);
  if (!Number.isFinite(indices.kp)) return UNKNOWN("G", "Kp is not a number", observedAt);
  const level = Math.min(5, Math.max(0, Math.floor(indices.kp) - 4)) as ScaleReading["level"];
  const kind = indices.kpKind === "estimated-1m" ? "running 3-hour estimate" : "last completed 3-hour Kp";
  return {
    level,
    label: `G${level}`,
    basis: `Kp ${indices.kp.toFixed(2)} (${kind})`,
    observedAt,
  };
}

function formatFlux(pfu: number): string {
  return pfu >= 100 ? Math.round(pfu).toLocaleString("en-GB") : pfu.toPrecision(2);
}
