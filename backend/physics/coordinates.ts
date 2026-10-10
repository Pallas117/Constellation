export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

const DEG_TO_RAD = Math.PI / 180;

export function vec(x = 0, y = 0, z = 0): Vector3 {
  return { x, y, z };
}

export function add(a: Vector3, b: Vector3): Vector3 {
  return vec(a.x + b.x, a.y + b.y, a.z + b.z);
}

export function sub(a: Vector3, b: Vector3): Vector3 {
  return vec(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function scale(a: Vector3, k: number): Vector3 {
  return vec(a.x * k, a.y * k, a.z * k);
}

export function dot(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vector3, b: Vector3): Vector3 {
  return vec(
    a.y * b.z - a.z * b.y,
    a.z * b.x - a.x * b.z,
    a.x * b.y - a.y * b.x,
  );
}

export function magnitude(v: Vector3): number {
  return Math.sqrt(dot(v, v));
}

export function normalize(v: Vector3): Vector3 {
  const mag = magnitude(v);
  if (mag === 0) {
    return vec(0, 0, 0);
  }
  return scale(v, 1 / mag);
}

// Rotation matrices follow Hapgood (1992) "<angle, axis>" notation: they rotate the
// coordinate frame (not the vector) by `angle` about `axis`.
function frameRotX(angleRad: number): number[][] {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [
    [1, 0, 0],
    [0, c, s],
    [0, -s, c],
  ];
}

function frameRotZ(angleRad: number): number[][] {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [
    [c, s, 0],
    [-s, c, 0],
    [0, 0, 1],
  ];
}

function transpose(m: number[][]): number[][] {
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

function matMulVec(m: number[][], v: Vector3): Vector3 {
  return vec(
    m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
    m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
    m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
  );
}

// Geomagnetic (centred dipole) north pole, IGRF-14 epoch 2025.
const DIPOLE_POLE_LAT_DEG = 80.8;
const DIPOLE_POLE_LON_DEG = -72.8;

interface FrameAngles {
  /** GEO -> GEI: <theta, Z> */
  geiToGeo: number[][];
  /** GEI -> GSE: <lambdaSun, Z> * <epsilon, X> */
  geiToGse: number[][];
  /** Dipole axis expressed in GSE. */
  dipoleGse: Vector3;
}

function frameAngles(timestampIso: string): FrameAngles {
  const ms = Date.parse(timestampIso);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid timestamp for frame transform: ${timestampIso}`);
  }
  // Hapgood (1992), sections 2-3. T0 counts Julian centuries from J2000 at 0h UT.
  const mjd = ms / 86400000 + 40587;
  const mjd0 = Math.floor(mjd);
  const hours = (mjd - mjd0) * 24;
  const t0 = (mjd0 - 51544.5) / 36525;

  const gstDeg = 100.461 + 36000.770 * t0 + 15.04107 * hours;
  const meanAnomDeg = 357.528 + 35999.050 * t0 + 0.04107 * hours;
  const meanLonDeg = 280.460 + 36000.772 * t0 + 0.04107 * hours;
  const m = meanAnomDeg * DEG_TO_RAD;
  const sunLonDeg = meanLonDeg + (1.915 - 0.0048 * t0) * Math.sin(m) + 0.020 * Math.sin(2 * m);
  const obliquityDeg = 23.439 - 0.013 * t0;

  const geiToGeo = frameRotZ(gstDeg * DEG_TO_RAD);
  const zSun = frameRotZ(sunLonDeg * DEG_TO_RAD);
  const xObl = frameRotX(obliquityDeg * DEG_TO_RAD);
  const geiToGse = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => zSun[i][0] * xObl[0][j] + zSun[i][1] * xObl[1][j] + zSun[i][2] * xObl[2][j]),
  );

  const lat = DIPOLE_POLE_LAT_DEG * DEG_TO_RAD;
  const lon = DIPOLE_POLE_LON_DEG * DEG_TO_RAD;
  const dipoleGeo = vec(Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat));
  const dipoleGse = matMulVec(geiToGse, matMulVec(transpose(geiToGeo), dipoleGeo));
  return { geiToGeo, geiToGse, dipoleGse };
}

/** Dipole tilt angle (rad): positive when the northern dipole axis leans toward the Sun. */
export function dipoleTiltRad(timestampIso: string): number {
  return Math.asin(clamp(frameAngles(timestampIso).dipoleGse.x, -1, 1));
}

function gseToGsmMatrix(dipoleGse: Vector3): number[][] {
  // GSE and GSM share the X (Earth-Sun) axis; GSM Z is the dipole projected onto the YZ plane.
  const psi = Math.atan2(dipoleGse.y, dipoleGse.z);
  return frameRotX(-psi);
}

export function gseToGsm(vector: Vector3, timestampIso: string): Vector3 {
  return matMulVec(gseToGsmMatrix(frameAngles(timestampIso).dipoleGse), vector);
}

export function gsmToGse(vector: Vector3, timestampIso: string): Vector3 {
  return matMulVec(transpose(gseToGsmMatrix(frameAngles(timestampIso).dipoleGse)), vector);
}

export function geoToGsm(vector: Vector3, timestampIso: string): Vector3 {
  const { geiToGeo, geiToGse, dipoleGse } = frameAngles(timestampIso);
  const gse = matMulVec(geiToGse, matMulVec(transpose(geiToGeo), vector));
  return matMulVec(gseToGsmMatrix(dipoleGse), gse);
}

export function vectorFromArray(values: number[]): Vector3 {
  return vec(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
