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

function rotationMatrixY(angleRad: number): number[][] {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [
    [c, 0, s],
    [0, 1, 0],
    [-s, 0, c],
  ];
}

function rotationMatrixZ(angleRad: number): number[][] {
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  return [
    [c, -s, 0],
    [s, c, 0],
    [0, 0, 1],
  ];
}

function matMulVec(m: number[][], v: Vector3): Vector3 {
  return vec(
    m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
    m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
    m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
  );
}

function dayOfYear(ts: Date): number {
  const start = new Date(Date.UTC(ts.getUTCFullYear(), 0, 0));
  const diff = ts.getTime() - start.getTime();
  return Math.floor(diff / 86400000);
}

function estimateDipoleTiltRad(ts: Date): number {
  // Operational approximation: annual + diurnal dipole variation.
  const doy = dayOfYear(ts);
  const universalHours = ts.getUTCHours() + ts.getUTCMinutes() / 60;
  const annual = 11 * Math.sin(((2 * Math.PI) / 365.25) * (doy - 80));
  const diurnal = 2 * Math.sin(((2 * Math.PI) / 24) * (universalHours - 12));
  return (annual + diurnal) * DEG_TO_RAD;
}

export function gseToGsm(vector: Vector3, timestampIso: string): Vector3 {
  const ts = new Date(timestampIso);
  const tilt = estimateDipoleTiltRad(ts);
  // Approximation: rotate around Y then small correction around Z.
  const yRot = rotationMatrixY(tilt);
  const zRot = rotationMatrixZ(tilt * 0.15);
  return matMulVec(zRot, matMulVec(yRot, vector));
}

export function geoToGsm(vector: Vector3, timestampIso: string): Vector3 {
  const ts = new Date(timestampIso);
  const tilt = estimateDipoleTiltRad(ts);
  // Approximation for GEO -> GSM alignment using dipole tilt.
  const zRot = rotationMatrixZ(-tilt * 0.5);
  const yRot = rotationMatrixY(tilt);
  return matMulVec(yRot, matMulVec(zRot, vector));
}

export function vectorFromArray(values: number[]): Vector3 {
  return vec(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
