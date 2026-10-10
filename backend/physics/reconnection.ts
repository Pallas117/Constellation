import type { MMSReconVectorPoint, MMSTetrahedronQuality } from "../types.js";
import {
  add,
  cross,
  magnitude,
  normalize,
  scale,
  sub,
  vec,
  type Vector3,
} from "./coordinates.js";

const MU0 = 4e-7 * Math.PI;
const RE_KM = 6371.2;
/** Minimum tetrahedron regularity (volume / volume of a regular tetrahedron of the same mean edge). */
const MIN_REGULARITY = 0.05;

export interface MMSSpacecraftSample {
  id: "mms1" | "mms2" | "mms3" | "mms4";
  timestamp: string;
  positionGsmRe: Vector3;
  magneticFieldNt: Vector3;
}

interface Matrix3 {
  a11: number;
  a12: number;
  a13: number;
  a21: number;
  a22: number;
  a23: number;
  a31: number;
  a32: number;
  a33: number;
}

function zeroMatrix(): Matrix3 {
  return {
    a11: 0,
    a12: 0,
    a13: 0,
    a21: 0,
    a22: 0,
    a23: 0,
    a31: 0,
    a32: 0,
    a33: 0,
  };
}

function matrixAdd(m: Matrix3, n: Matrix3): Matrix3 {
  return {
    a11: m.a11 + n.a11,
    a12: m.a12 + n.a12,
    a13: m.a13 + n.a13,
    a21: m.a21 + n.a21,
    a22: m.a22 + n.a22,
    a23: m.a23 + n.a23,
    a31: m.a31 + n.a31,
    a32: m.a32 + n.a32,
    a33: m.a33 + n.a33,
  };
}

function matrixFromOuter(a: Vector3, b: Vector3): Matrix3 {
  return {
    a11: a.x * b.x,
    a12: a.x * b.y,
    a13: a.x * b.z,
    a21: a.y * b.x,
    a22: a.y * b.y,
    a23: a.y * b.z,
    a31: a.z * b.x,
    a32: a.z * b.y,
    a33: a.z * b.z,
  };
}

function determinant(m: Matrix3): number {
  return (
    m.a11 * (m.a22 * m.a33 - m.a23 * m.a32) -
    m.a12 * (m.a21 * m.a33 - m.a23 * m.a31) +
    m.a13 * (m.a21 * m.a32 - m.a22 * m.a31)
  );
}

function inverse(m: Matrix3): Matrix3 | null {
  const det = determinant(m);
  // Relative test: an absolute threshold depends on the length unit and rejects every
  // real MMS configuration (separations of ~10-100 km).
  const norm = frobeniusNorm(m);
  if (!Number.isFinite(det) || norm === 0 || Math.abs(det) < 1e-12 * norm * norm * norm) {
    return null;
  }
  const invDet = 1 / det;
  return {
    a11: (m.a22 * m.a33 - m.a23 * m.a32) * invDet,
    a12: (m.a13 * m.a32 - m.a12 * m.a33) * invDet,
    a13: (m.a12 * m.a23 - m.a13 * m.a22) * invDet,
    a21: (m.a23 * m.a31 - m.a21 * m.a33) * invDet,
    a22: (m.a11 * m.a33 - m.a13 * m.a31) * invDet,
    a23: (m.a13 * m.a21 - m.a11 * m.a23) * invDet,
    a31: (m.a21 * m.a32 - m.a22 * m.a31) * invDet,
    a32: (m.a12 * m.a31 - m.a11 * m.a32) * invDet,
    a33: (m.a11 * m.a22 - m.a12 * m.a21) * invDet,
  };
}

function mul(a: Matrix3, b: Matrix3): Matrix3 {
  return {
    a11: a.a11 * b.a11 + a.a12 * b.a21 + a.a13 * b.a31,
    a12: a.a11 * b.a12 + a.a12 * b.a22 + a.a13 * b.a32,
    a13: a.a11 * b.a13 + a.a12 * b.a23 + a.a13 * b.a33,
    a21: a.a21 * b.a11 + a.a22 * b.a21 + a.a23 * b.a31,
    a22: a.a21 * b.a12 + a.a22 * b.a22 + a.a23 * b.a32,
    a23: a.a21 * b.a13 + a.a22 * b.a23 + a.a23 * b.a33,
    a31: a.a31 * b.a11 + a.a32 * b.a21 + a.a33 * b.a31,
    a32: a.a31 * b.a12 + a.a32 * b.a22 + a.a33 * b.a32,
    a33: a.a31 * b.a13 + a.a32 * b.a23 + a.a33 * b.a33,
  };
}

function trace(m: Matrix3): number {
  return m.a11 + m.a22 + m.a33;
}

function frobeniusNorm(m: Matrix3): number {
  return Math.sqrt(
    m.a11 * m.a11 +
      m.a12 * m.a12 +
      m.a13 * m.a13 +
      m.a21 * m.a21 +
      m.a22 * m.a22 +
      m.a23 * m.a23 +
      m.a31 * m.a31 +
      m.a32 * m.a32 +
      m.a33 * m.a33,
  );
}

function rowToVector(m: Matrix3, row: 1 | 2 | 3): Vector3 {
  if (row === 1) return vec(m.a11, m.a12, m.a13);
  if (row === 2) return vec(m.a21, m.a22, m.a23);
  return vec(m.a31, m.a32, m.a33);
}

function barycenter(values: Vector3[]): Vector3 {
  if (values.length === 0) return vec(0, 0, 0);
  const sum = values.reduce((acc, curr) => add(acc, curr), vec(0, 0, 0));
  return scale(sum, 1 / values.length);
}

function tetrahedronVolume(points: Vector3[]): number {
  if (points.length < 4) return 0;
  const a = sub(points[1], points[0]);
  const b = sub(points[2], points[0]);
  const c = sub(points[3], points[0]);
  return Math.abs(
    a.x * (b.y * c.z - b.z * c.y) -
      a.y * (b.x * c.z - b.z * c.x) +
      a.z * (b.x * c.y - b.y * c.x),
  ) / 6;
}

function computeGradient(samples: MMSSpacecraftSample[]): {
  gradient: Matrix3 | null;
  barycenterPosition: Vector3;
  barycenterB: Vector3;
  volume: number;
  conditionNumber: number;
} {
  // Work in km so the gradient is nT/km; positions arrive in Earth radii.
  const positions = samples.map((s) => scale(s.positionGsmRe, RE_KM));
  const fields = samples.map((s) => s.magneticFieldNt);
  const rcKm = barycenter(positions);
  const rc = scale(rcKm, 1 / RE_KM);
  const bc = barycenter(fields);

  let rMatrix = zeroMatrix();
  let rbMatrix = zeroMatrix();
  for (let i = 0; i < samples.length; i += 1) {
    const dr = sub(positions[i], rcKm);
    const db = sub(fields[i], bc);
    rMatrix = matrixAdd(rMatrix, matrixFromOuter(dr, dr));
    rbMatrix = matrixAdd(rbMatrix, matrixFromOuter(dr, db));
  }

  const rInv = inverse(rMatrix);
  const volume = tetrahedronVolume(positions);
  const cond = rInv ? frobeniusNorm(rMatrix) * frobeniusNorm(rInv) : Number.POSITIVE_INFINITY;
  if (!rInv) {
    return { gradient: null, barycenterPosition: rc, barycenterB: bc, volume, conditionNumber: cond };
  }

  return {
    gradient: mul(rInv, rbMatrix),
    barycenterPosition: rc,
    barycenterB: bc,
    volume,
    conditionNumber: cond,
  };
}

function meanEdge(points: Vector3[]): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      sum += magnitude(sub(points[i], points[j]));
      n += 1;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Scale-free shape quality in [0, 1]: 1 for a regular tetrahedron, 0 when degenerate. */
function regularity(points: Vector3[], volume: number): number {
  const a = meanEdge(points);
  return a > 0 ? volume / (a ** 3 / (6 * Math.SQRT2)) : 0;
}

function toQuality(
  valid: boolean,
  volume: number,
  conditionNumber: number,
  divCurlRatio: number,
  reason?: string,
): MMSTetrahedronQuality {
  let confidence: "high" | "medium" | "low" = "low";
  if (valid && divCurlRatio <= 0.3 && conditionNumber < 80) {
    confidence = "high";
  } else if (valid && divCurlRatio <= 0.7) {
    confidence = "medium";
  }
  return {
    valid,
    volume,
    conditionNumber,
    divCurlRatio,
    confidence,
    reason,
  };
}

function estimateLmn(barycenterB: Vector3, gradient: Matrix3): {
  l: Vector3;
  m: Vector3;
  n: Vector3;
} {
  const n = normalize(rowToVector(gradient, 1));
  const l = normalize(barycenterB);
  const m = normalize(cross(n, l));
  return { l, m, n };
}

function nearestTimestamp(samples: MMSSpacecraftSample[]): string {
  const sorted = [...samples].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return sorted[Math.floor(sorted.length / 2)]?.timestamp ?? new Date().toISOString();
}

export function computeMMSReconnectionVector(
  samples: MMSSpacecraftSample[],
): MMSReconVectorPoint | null {
  if (samples.length < 4) {
    return null;
  }

  const grouped = new Map<string, MMSSpacecraftSample>();
  for (const sample of samples) {
    grouped.set(sample.id, sample);
  }
  if (grouped.size < 4) {
    return null;
  }

  const ordered = ["mms1", "mms2", "mms3", "mms4"].map((id) => grouped.get(id)!);
  const result = computeGradient(ordered);
  if (!result.gradient) {
    return {
      timestamp: nearestTimestamp(ordered),
      barycenterGsmRe: result.barycenterPosition,
      currentDensity: { x: 0, y: 0, z: 0, magnitude: 0 },
      normal: { x: 0, y: 0, z: 0 },
      lmn: {
        l: { x: 0, y: 0, z: 0 },
        m: { x: 0, y: 0, z: 0 },
        n: { x: 0, y: 0, z: 0 },
      },
      quality: toQuality(false, result.volume, result.conditionNumber, 1, "Singular tetrahedron geometry"),
    };
  }

  // gradient.aij = dB_j/dx_i (from sum dr_i * dB_j), so curl_x = dBz/dy - dBy/dz = a23 - a32.
  const curl = vec(
    result.gradient.a23 - result.gradient.a32,
    result.gradient.a31 - result.gradient.a13,
    result.gradient.a12 - result.gradient.a21,
  );
  // curl is nT/km = 1e-12 T/m; J = curl / mu0 in A/m^2, reported in nA/m^2.
  const current = scale(curl, (1e-12 / MU0) * 1e9);
  const divB = trace(result.gradient);
  const curlMag = magnitude(curl);
  const divCurlRatio = curlMag > 0 ? Math.abs(divB) / curlMag : 1;
  const lmn = estimateLmn(result.barycenterB, result.gradient);

  const shape = regularity(ordered.map((s) => scale(s.positionGsmRe, RE_KM)), result.volume);
  const valid = shape >= MIN_REGULARITY && result.conditionNumber < 2e3;
  return {
    timestamp: nearestTimestamp(ordered),
    barycenterGsmRe: result.barycenterPosition,
    currentDensity: {
      x: current.x,
      y: current.y,
      z: current.z,
      magnitude: magnitude(current),
    },
    normal: lmn.n,
    lmn,
    quality: toQuality(valid, result.volume, result.conditionNumber, divCurlRatio),
  };
}

export function withinSkewWindow(samples: MMSSpacecraftSample[], maxSkewSeconds: number): boolean {
  if (samples.length < 4) {
    return false;
  }
  const times = samples.map((sample) => Date.parse(sample.timestamp)).sort((a, b) => a - b);
  return (times[times.length - 1] - times[0]) / 1000 <= maxSkewSeconds;
}
