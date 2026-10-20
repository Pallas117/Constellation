/**
 * Orbit context for a trust record (GAU-57): where the spacecraft was in Earth's field.
 *
 * L-shell here is the centred-dipole value: the equatorial crossing distance, in Earth radii, of
 * the dipole field line through the spacecraft, L = (r / RE) / cos²(λm), with the magnetic
 * latitude λm taken from the IGRF-14 2025 dipole pole the rest of the backend uses. It is a
 * standard first approximation (Walt, "Introduction to Geomagnetically Trapped Radiation", 1994,
 * ch. 2). It differs from McIlwain's L computed with the full IGRF most where the real field is
 * least dipolar, which includes the South Atlantic Anomaly, so its confidence is "medium".
 *
 * The South Atlantic Anomaly is not modelled yet (GAU-141): a centred dipole cannot place it,
 * because the anomaly comes from the dipole's offset. The SAA flag therefore reads unknown.
 */
import { DIPOLE_POLE_LAT_DEG, DIPOLE_POLE_LON_DEG } from "../physics/coordinates.js";

/** IGRF reference radius, km. */
export const RE_KM = 6371.2;

export interface Ephemeris {
  latDeg: number;
  lonDeg: number;
  altKm: number;
}

/** Why an ephemeris can't be used, or null when it is plausible for an Earth-orbiting spacecraft. */
export function ephemerisProblem(e: unknown): string | null {
  if (!e || typeof e !== "object") return "no ephemeris given";
  const { latDeg, lonDeg, altKm } = e as Partial<Ephemeris>;
  if (typeof latDeg !== "number" || !Number.isFinite(latDeg) || latDeg < -90 || latDeg > 90) return "latitude must be −90 to 90 degrees";
  if (typeof lonDeg !== "number" || !Number.isFinite(lonDeg) || lonDeg < -180 || lonDeg > 360) return "longitude must be −180 to 360 degrees";
  if (typeof altKm !== "number" || !Number.isFinite(altKm) || altKm < 100 || altKm > 60_000) return "altitude must be 100 to 60,000 km";
  return null;
}

/** Geomagnetic (centred-dipole) latitude, degrees, of a geographic position (spherical Earth). */
export function dipoleLatitudeDeg(latDeg: number, lonDeg: number): number {
  const d = Math.PI / 180;
  const p = [Math.cos(DIPOLE_POLE_LAT_DEG * d) * Math.cos(DIPOLE_POLE_LON_DEG * d), Math.cos(DIPOLE_POLE_LAT_DEG * d) * Math.sin(DIPOLE_POLE_LON_DEG * d), Math.sin(DIPOLE_POLE_LAT_DEG * d)];
  const r = [Math.cos(latDeg * d) * Math.cos(lonDeg * d), Math.cos(latDeg * d) * Math.sin(lonDeg * d), Math.sin(latDeg * d)];
  const s = p[0] * r[0] + p[1] * r[1] + p[2] * r[2];
  return Math.asin(Math.max(-1, Math.min(1, s))) / d;
}

/** Centred-dipole L-shell of a position. */
export function dipoleLShell(e: Ephemeris): number {
  const lambda = (dipoleLatitudeDeg(e.latDeg, e.lonDeg) * Math.PI) / 180;
  const c = Math.cos(lambda);
  return (RE_KM + e.altKm) / RE_KM / (c * c);
}
