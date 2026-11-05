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
 * A centred dipole cannot place the South Atlantic Anomaly, because the anomaly comes from the
 * dipole's offset, so the SAA flag uses the full IGRF-14 field instead (saa.ts, GAU-141).
 *
 * Positions: a supplied ephemeris is taken as geocentric latitude/longitude and altitude above
 * a 6371.2 km sphere; a TLE is propagated with SGP4 (satellite.js, the Vallado et al. 2006
 * "Revisiting Spacetrack Report #3" algorithm) to Earth-fixed coordinates and converted the same
 * way. SGP4 error grows with time from the TLE epoch, so a TLE more than MAX_TLE_AGE_DAYS from
 * the inference is not used.
 */
import { eciToEcf, gstime, propagate, twoline2satrec } from "satellite.js";
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

/** A TLE whose epoch is further than this from the inference time is not used. */
export const MAX_TLE_AGE_DAYS = 7;
/** An ephemeris and a TLE further apart than this describe different places: conflicting inputs. */
export const EPHEMERIS_TLE_CONFLICT_KM = 100;

/**
 * Why one TLE line is malformed, or null: 69 characters, starting with its line number, and the
 * modulo-10 checksum in column 69 (digits add their value, "-" adds 1). satellite.js does not
 * check these: a malformed TLE parses without an error and propagates to null positions.
 */
export function tleLineProblem(line: string, n: 1 | 2): string | null {
  if (line.length !== 69) return `line ${n} must be 69 characters`;
  if (!line.startsWith(`${n} `)) return `line ${n} must start with "${n} "`;
  let sum = 0;
  for (const ch of line.slice(0, 68)) {
    if (ch >= "0" && ch <= "9") sum += Number(ch);
    else if (ch === "-") sum += 1;
  }
  if (sum % 10 !== Number(line[68])) return `line ${n} checksum fails`;
  return null;
}

/** Why a TLE can't be used, or null when both lines are well formed and name the same object. */
export function tleProblem(tle: unknown): string | null {
  if (!Array.isArray(tle) || tle.length !== 2 || !tle.every((l) => typeof l === "string")) return "tle must be two lines";
  const [l1, l2] = tle as [string, string];
  const problem = tleLineProblem(l1, 1) ?? tleLineProblem(l2, 2);
  if (problem) return problem;
  if (l1.slice(2, 7) !== l2.slice(2, 7)) return "the two lines name different catalogue numbers";
  return null;
}

export interface TlePosition {
  ephemeris: Ephemeris;
  /** TLE epoch (UTC). */
  epoch: string;
  /** Inference time minus epoch, days (negative when the inference is before the epoch). */
  ageDays: number;
}

/** Spacecraft position at `timeMs` from a TLE, or why it can't be had. */
export function propagateTle(tle: [string, string], timeMs: number): TlePosition | { error: string } {
  const problem = tleProblem(tle);
  if (problem) return { error: problem };
  const rec = twoline2satrec(tle[0], tle[1]);
  const epochMs = (rec.jdsatepoch - 2440587.5) * 86_400_000;
  const ageDays = (timeMs - epochMs) / 86_400_000;
  const epoch = new Date(Math.round(epochMs)).toISOString();
  if (!Number.isFinite(ageDays)) return { error: "TLE epoch could not be read" };
  if (Math.abs(ageDays) > MAX_TLE_AGE_DAYS) {
    return { error: `TLE epoch ${epoch.slice(0, 10)} is ${Math.abs(ageDays).toFixed(1)} days from the inference (limit ${MAX_TLE_AGE_DAYS})` };
  }
  const date = new Date(timeMs);
  const pv = propagate(rec, date);
  const p = pv?.position;
  if (!p || typeof p !== "object" || ![p.x, p.y, p.z].every((v) => typeof v === "number" && Number.isFinite(v))) {
    return { error: `SGP4 could not propagate this TLE${rec.error ? ` (error ${rec.error})` : ""}: decayed or invalid elements` };
  }
  const e = eciToEcf(p, gstime(date));
  const r = Math.hypot(e.x, e.y, e.z);
  const ephemeris = {
    latDeg: (Math.asin(e.z / r) * 180) / Math.PI,
    lonDeg: (Math.atan2(e.y, e.x) * 180) / Math.PI,
    altKm: r - RE_KM,
  };
  if (ephemerisProblem(ephemeris)) return { error: `SGP4 position is not a plausible orbit (${ephemerisProblem(ephemeris)})` };
  return { ephemeris, epoch, ageDays };
}

/** Straight-line distance between two positions, km (spherical Earth, as above). */
export function distanceKm(a: Ephemeris, b: Ephemeris): number {
  const v = (e: Ephemeris) => {
    const d = Math.PI / 180;
    const r = RE_KM + e.altKm;
    return [r * Math.cos(e.latDeg * d) * Math.cos(e.lonDeg * d), r * Math.cos(e.latDeg * d) * Math.sin(e.lonDeg * d), r * Math.sin(e.latDeg * d)];
  };
  const [p, q] = [v(a), v(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Centred-dipole L-shell of a position. */
export function dipoleLShell(e: Ephemeris): number {
  const lambda = (dipoleLatitudeDeg(e.latDeg, e.lonDeg) * Math.PI) / 180;
  const c = Math.cos(lambda);
  return (RE_KM + e.altKm) / RE_KM / (c * c);
}
