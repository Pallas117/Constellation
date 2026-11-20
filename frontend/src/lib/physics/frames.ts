/**
 * Geographic (GEO) and inertial (GEI) positions in the scene's GSM frame, for things fixed to
 * the Earth or in orbit around it (the storm walkthrough's SAA outline and satellite, GAU-229).
 *
 * The same low-precision Sun and sidereal-time formulas as dipoleTiltRad (~0.5°, display only);
 * frames.test.ts checks them against the backend's Hapgood (1992) transforms.
 */
import type { Vec3 } from './geomagnetic.ts';

const DEG = Math.PI / 180;
/** Earth radius used for altitudes, km (IGRF reference radius, as backend/trust/orbit.ts). */
export const RE_KM = 6371.2;
const MU_KM3_S2 = 398_600.4418;

/** IGRF-14 epoch 2025 geomagnetic north pole (centred dipole), as geomagnetic.ts. */
const POLE_LAT_DEG = 80.8;
const POLE_LON_DEG = -72.7;

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const m = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / m, a[1] / m, a[2] / m];
};

/** Greenwich mean sidereal time, radians. */
export function gmstRad(ms: number): number {
  const d = ms / 86_400_000 - 10957.5;
  const deg = (280.46061837 + 360.98564736629 * d) % 360;
  return (deg < 0 ? deg + 360 : deg) * DEG;
}

/** Unit vector to the Sun in GEI (mean equator and equinox of date). */
export function sunGei(ms: number): Vec3 {
  const d = ms / 86_400_000 - 10957.5;
  const L = (280.46 + 0.9856474 * d) * DEG;
  const g = (357.528 + 0.9856003 * d) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * d) * DEG;
  return [Math.cos(lambda), Math.cos(eps) * Math.sin(lambda), Math.sin(eps) * Math.sin(lambda)];
}

/** GEO → GEI: turn by the sidereal angle about the polar axis. */
export function geoToGei([x, y, z]: Vec3, ms: number): Vec3 {
  const t = gmstRad(ms);
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c * x - s * y, s * x + c * y, z];
}

export function geiToGeo([x, y, z]: Vec3, ms: number): Vec3 {
  const t = gmstRad(ms);
  const c = Math.cos(t);
  const s = Math.sin(t);
  return [c * x + s * y, -s * x + c * y, z];
}

/** The GSM axes expressed in GEI: X to the Sun, Z the dipole axis projected perpendicular to X. */
export function gsmAxesGei(ms: number): [Vec3, Vec3, Vec3] {
  const x = sunGei(ms);
  const pole = geoToGei(latLonToUnit(POLE_LAT_DEG, POLE_LON_DEG), ms);
  const y = norm(cross(pole, x));
  return [x, y, cross(x, y)];
}

export function geiToGsm(v: Vec3, ms: number): Vec3 {
  const [x, y, z] = gsmAxesGei(ms);
  return [dot(v, x), dot(v, y), dot(v, z)];
}

export function geoToGsm(v: Vec3, ms: number): Vec3 {
  return geiToGsm(geoToGei(v, ms), ms);
}

export function latLonToUnit(latDeg: number, lonDeg: number): Vec3 {
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

export function unitToLatLon([x, y, z]: Vec3): { lat: number; lon: number } {
  return { lat: Math.asin(Math.max(-1, Math.min(1, z))) / DEG, lon: Math.atan2(y, x) / DEG };
}

/** A point at (lat, lon, altitude) in GSM, Earth radii. */
export function geoPointGsm(latDeg: number, lonDeg: number, altKm: number, ms: number): Vec3 {
  const r = 1 + altKm / RE_KM;
  const g = geoToGsm(latLonToUnit(latDeg, lonDeg), ms);
  return [g[0] * r, g[1] * r, g[2] * r];
}

export interface CircularOrbit {
  altKm: number;
  inclinationDeg: number;
  /** Right ascension of the ascending node, degrees. */
  raanDeg: number;
  /** Time of an ascending-node crossing (UTC ms). */
  epochMs: number;
}

export function orbitPeriodMs(altKm: number): number {
  const a = RE_KM + altKm;
  return 2 * Math.PI * Math.sqrt((a * a * a) / MU_KM3_S2) * 1000;
}

/** Unit position in GEI on a circular orbit (no perturbations: a teaching orbit, not an ephemeris). */
export function circularOrbitGei(o: CircularOrbit, ms: number): Vec3 {
  const u = (2 * Math.PI * (ms - o.epochMs)) / orbitPeriodMs(o.altKm);
  const i = o.inclinationDeg * DEG;
  const node = o.raanDeg * DEG;
  const cu = Math.cos(u);
  const su = Math.sin(u);
  return [
    cu * Math.cos(node) - su * Math.cos(i) * Math.sin(node),
    cu * Math.sin(node) + su * Math.cos(i) * Math.cos(node),
    su * Math.sin(i),
  ];
}

/** Sub-satellite point (geocentric latitude), degrees. */
export function subSatellitePoint(o: CircularOrbit, ms: number): { lat: number; lon: number } {
  return unitToLatLon(geiToGeo(circularOrbitGei(o, ms), ms));
}

/**
 * Whether (lat, lon) lies inside an outline of [lat, lon] vertices (even-odd rule on the
 * lat/lon plane). Fine for an outline that doesn't cross the antimeridian or a pole, like the SAA.
 */
export function insideOutline(lat: number, lon: number, outline: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [yi, xi] = outline[i];
    const [yj, xj] = outline[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
