/**
 * Geomagnetic field model for the live magnetosphere visualisation.
 *
 * Frame: GSM (x sunward, z along the northward projection of the dipole axis),
 * units of Earth radii (Re) and nanotesla (nT). Scene coordinates map as
 * scene = (x_gsm, z_gsm, -y_gsm), which keeps both frames right-handed.
 *
 * Components:
 *  - Dipole tilt from UTC (low-precision solar ephemeris + IGRF-14 2025 pole).
 *  - Magnetopause: Shue et al. (1998), JGR 103(A8), 17691.
 *  - Bow shock: conic scaled from the Farris & Russell (1994) standoff relation.
 *  - Field lines: RK4 traces of tilted dipole + scaled uniform IMF (Dungey
 *    vacuum superposition, gives open/closed topology from Bz/By) + a
 *    tanh tail current sheet that stretches the nightside.
 *
 * The field-line model is a qualitative topology model for situational
 * awareness, not a substitute for Tsyganenko/MHD output: it is not
 * divergence-free in the near-tail transition region.
 */

export interface SolarWindDrivers {
  /** IMF Bz (GSM), nT */
  bz: number;
  /** IMF By (GSM), nT */
  by: number;
  /** Solar wind dynamic pressure, nPa */
  pdyn: number;
  /** Planetary Kp index, 0-9 */
  kp: number;
}

export type Vec3 = [number, number, number];

/** IGRF-14 epoch 2025 dipole strength (sqrt(g10² + g11² + h11²)), nT. */
export const DIPOLE_B0_NT = 29800;
/** IGRF-14 epoch 2025 geomagnetic north pole (centred dipole). */
const DIPOLE_POLE_LAT_DEG = 80.8;
const DIPOLE_POLE_LON_DEG = -72.7;

const DEG = Math.PI / 180;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Dipole tilt angle ψ (radians): angle between the GSM z axis and the
 * geomagnetic north pole. Positive when the north pole tilts toward the Sun
 * (northern summer). Accurate to ~0.5° — ample for display.
 */
export function dipoleTiltRad(epochMs: number): number {
  const d = epochMs / 86_400_000 - 10957.5; // days since J2000.0
  const L = (280.46 + 0.9856474 * d) * DEG;
  const g = (357.528 + 0.9856003 * d) * DEG;
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * d) * DEG;
  const sun: Vec3 = [Math.cos(lambda), Math.cos(eps) * Math.sin(lambda), Math.sin(eps) * Math.sin(lambda)];

  const gmst = ((280.46061837 + 360.98564736629 * d) % 360) * DEG;
  const lat = DIPOLE_POLE_LAT_DEG * DEG;
  const lon = DIPOLE_POLE_LON_DEG * DEG + gmst;
  const pole: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];

  return Math.asin(clamp(pole[0] * sun[0] + pole[1] * sun[1] + pole[2] * sun[2], -1, 1));
}

/** Shue et al. (1998) magnetopause standoff r0 (Re) and flaring α. */
export function shueMagnetopause(bz: number, pdyn: number): { r0: number; alpha: number } {
  const p = Math.max(pdyn, 0.1);
  const r0 = (10.22 + 1.29 * Math.tanh(0.184 * (bz + 8.14))) * Math.pow(p, -1 / 6.6);
  const alpha = (0.58 - 0.007 * bz) * (1 + 0.024 * Math.log(p));
  return { r0, alpha };
}

/** Magnetopause radius at angle θ from the Sun–Earth line. */
export function shueRadius(theta: number, r0: number, alpha: number): number {
  return r0 * Math.pow(2 / (1 + Math.cos(theta)), alpha);
}

/** Bow shock nose distance (Re) for fast-mode Mach number M (Farris & Russell 1994). */
export function bowShockStandoff(r0: number, mach = 8): number {
  const g = 5 / 3;
  const m2 = mach * mach;
  return r0 * (1 + 1.1 * (((g - 1) * m2 + 2) / ((g + 1) * m2)));
}

/** Equatorward / poleward auroral oval boundaries (magnetic latitude, degrees) from Kp. */
export function auroralOvalBounds(kp: number): { equatorward: number; poleward: number } {
  const k = clamp(kp, 0, 9);
  return { equatorward: Math.max(45, 66 - 2.1 * k), poleward: 76 - 0.6 * k };
}

export interface FieldModel {
  tilt: number;
  r0: number;
  alpha: number;
  tailLength: number;
  field: (p: Vec3) => Vec3;
  insideMagnetopause: (p: Vec3) => boolean;
}

export function createFieldModel(drivers: SolarWindDrivers, epochMs: number, tailLength = 40): FieldModel {
  const tilt = dipoleTiltRad(epochMs);
  const { r0, alpha } = shueMagnetopause(drivers.bz, drivers.pdyn);
  const sinT = Math.sin(tilt);
  const cosT = Math.cos(tilt);
  // Dipole moment points to geomagnetic south.
  const m: Vec3 = [-sinT, 0, -cosT];

  // Effective IMF: saturates so that strong driving puts the dayside null at
  // ~r0 (polar cap boundary ~65° MLAT) and weak driving leaves it beyond the
  // magnetopause (boundary ~72-75° MLAT).
  const bt = Math.hypot(drivers.by, drivers.bz);
  const extMag = bt > 1e-3 ? (DIPOLE_B0_NT / (r0 * r0 * r0)) * 0.9 * Math.tanh(bt / 8) : 0;
  const ext: Vec3 = bt > 1e-3 ? [0, (drivers.by / bt) * extMag, (drivers.bz / bt) * extMag] : [0, 0, 0];

  const southward = Math.max(0, -drivers.bz);
  const tailB = 12 * Math.sqrt(Math.max(drivers.pdyn, 0.1) / 2) * (1 + 0.05 * southward);
  const sheetHalfThickness = 2;
  const hingeDistance = 10;
  const tanT = Math.tan(tilt);

  const field = ([x, y, z]: Vec3): Vec3 => {
    const r2 = x * x + y * y + z * z;
    const r = Math.sqrt(r2);
    const inv3 = DIPOLE_B0_NT / (r2 * r);
    const mr = (m[0] * x + m[1] * y + m[2] * z) / r;
    let bx = inv3 * (3 * mr * (x / r) - m[0]) + ext[0];
    const by = inv3 * (3 * mr * (y / r) - m[1]) + ext[1];
    const bz = inv3 * (3 * mr * (z / r) - m[2]) + ext[2];
    if (x < -4) {
      const zHinge = -tanT * Math.max(x, -hingeDistance);
      // North lobe points sunward (+x), south lobe anti-sunward.
      bx += tailB * Math.tanh((z - zHinge) / sheetHalfThickness) * smoothstep(-4, -10, x);
    }
    return [bx, by, bz];
  };

  const insideMagnetopause = ([x, y, z]: Vec3): boolean => {
    if (x < -tailLength) return false;
    const r = Math.sqrt(x * x + y * y + z * z);
    const theta = Math.acos(clamp(x / r, -1, 1));
    if (theta > 2.8) return Math.hypot(y, z) < shueRadius(2.8, r0, alpha) * Math.sin(2.8);
    return r < shueRadius(theta, r0, alpha);
  };

  return { tilt, r0, alpha, tailLength, field, insideMagnetopause };
}

export type Topology = 'closed' | 'open';

export interface FieldLine {
  /** GSM points, Re */
  points: Vec3[];
  /** |B| at each point, nT */
  strength: number[];
  topology: Topology;
  /** Footpoint magnetic latitude (deg, signed by hemisphere) */
  footLatitude: number;
  /** Footpoint magnetic local time angle (rad, 0 = noon) */
  footMlt: number;
}

/**
 * Trace one field line from a surface footpoint outward with adaptive RK4.
 * `direction` = -1 follows -B (outward from the northern hemisphere).
 */
export function traceFieldLine(model: FieldModel, start: Vec3, direction: 1 | -1, maxSteps = 4000): { points: Vec3[]; strength: number[]; topology: Topology } {
  const points: Vec3[] = [start];
  const strength: number[] = [];
  const unit = (p: Vec3): Vec3 | null => {
    const b = model.field(p);
    const mag = Math.hypot(b[0], b[1], b[2]);
    if (mag < 1e-6) return null;
    return [(direction * b[0]) / mag, (direction * b[1]) / mag, (direction * b[2]) / mag];
  };
  const mag = (p: Vec3) => {
    const b = model.field(p);
    return Math.hypot(b[0], b[1], b[2]);
  };
  strength.push(mag(start));

  let p = start;
  for (let i = 0; i < maxSteps; i++) {
    const r = Math.hypot(p[0], p[1], p[2]);
    const h = clamp(0.03 * r, 0.02, 0.6);
    const k1 = unit(p);
    if (!k1) break;
    const p2: Vec3 = [p[0] + 0.5 * h * k1[0], p[1] + 0.5 * h * k1[1], p[2] + 0.5 * h * k1[2]];
    const k2 = unit(p2);
    if (!k2) break;
    const p3: Vec3 = [p[0] + 0.5 * h * k2[0], p[1] + 0.5 * h * k2[1], p[2] + 0.5 * h * k2[2]];
    const k3 = unit(p3);
    if (!k3) break;
    const p4: Vec3 = [p[0] + h * k3[0], p[1] + h * k3[1], p[2] + h * k3[2]];
    const k4 = unit(p4);
    if (!k4) break;
    const next: Vec3 = [
      p[0] + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
      p[1] + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
      p[2] + (h / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]),
    ];
    const rn = Math.hypot(next[0], next[1], next[2]);
    if (rn <= 1) {
      // Land exactly on the surface.
      const s = 1 / rn;
      points.push([next[0] * s, next[1] * s, next[2] * s]);
      strength.push(mag(points[points.length - 1]));
      return { points, strength, topology: 'closed' };
    }
    points.push(next);
    strength.push(mag(next));
    if (!model.insideMagnetopause(next)) return { points, strength, topology: 'open' };
    p = next;
  }
  return { points, strength, topology: 'open' };
}

/** Surface point at magnetic latitude/MLT angle, in GSM. */
export function magneticFootpoint(tilt: number, mlatDeg: number, mltRad: number, radius = 1.02): Vec3 {
  const lat = mlatDeg * DEG;
  const s = Math.sin(tilt);
  const c = Math.cos(tilt);
  // Magnetic frame basis in GSM: e1 toward noon in the magnetic equator, e3 north pole.
  const e1: Vec3 = [c, 0, -s];
  const e2: Vec3 = [0, 1, 0];
  const e3: Vec3 = [s, 0, c];
  const cl = Math.cos(lat);
  const a = cl * Math.cos(mltRad);
  const b = cl * Math.sin(mltRad);
  const n = Math.sin(lat);
  return [
    radius * (a * e1[0] + b * e2[0] + n * e3[0]),
    radius * (a * e1[1] + b * e2[1] + n * e3[1]),
    radius * (a * e1[2] + b * e2[2] + n * e3[2]),
  ];
}

/** Keep at most `max` points, always retaining both ends. */
function decimate<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

export interface MagnetosphereState {
  tilt: number;
  r0: number;
  alpha: number;
  bowShock: number;
  oval: { equatorward: number; poleward: number };
  lines: FieldLine[];
  openFraction: number;
}

export const DEFAULT_SEED_LATITUDES = [50, 57, 62, 66, 69, 72, 75, 78, 82];
export const DEFAULT_SEED_MLT_COUNT = 12;

export function computeMagnetosphere(
  drivers: SolarWindDrivers,
  epochMs: number,
  opts: { latitudes?: number[]; mltCount?: number; maxPointsPerLine?: number; tailLength?: number } = {},
): MagnetosphereState {
  const latitudes = opts.latitudes ?? DEFAULT_SEED_LATITUDES;
  const mltCount = opts.mltCount ?? DEFAULT_SEED_MLT_COUNT;
  const maxPts = opts.maxPointsPerLine ?? 160;
  const model = createFieldModel(drivers, epochMs, opts.tailLength);
  const lines: FieldLine[] = [];
  let seeds = 0;
  let open = 0;

  for (const hemi of [1, -1] as const) {
    for (const lat of latitudes) {
      for (let k = 0; k < mltCount; k++) {
        // Offset alternate rings so lines don't stack in the same meridian.
        const mlt = ((k + (lat % 2) * 0.5) / mltCount) * Math.PI * 2;
        const start = magneticFootpoint(model.tilt, hemi * lat, mlt);
        // Northern field points into the Earth: follow -B outward. Southern: +B.
        const t = traceFieldLine(model, start, hemi === 1 ? -1 : 1);
        seeds++;
        if (t.topology === 'open') open++;
        // Closed lines are traced from the north already.
        if (hemi === -1 && t.topology === 'closed') continue;
        lines.push({
          points: decimate(t.points, maxPts),
          strength: decimate(t.strength, maxPts),
          topology: t.topology,
          footLatitude: hemi * lat,
          footMlt: mlt,
        });
      }
    }
  }

  return {
    tilt: model.tilt,
    r0: model.r0,
    alpha: model.alpha,
    bowShock: bowShockStandoff(model.r0),
    oval: auroralOvalBounds(drivers.kp),
    lines,
    openFraction: seeds ? open / seeds : 0,
  };
}

/** GSM → three.js scene coordinates. */
export const gsmToScene = ([x, y, z]: Vec3): Vec3 => [x, z, -y];

/**
 * Recover drivers from the legacy normalised visual params
 * (compression 0.6-1 from Pdyn/10, reconnection 0-1 from -Bz/15).
 */
export function driversFromVisualParams(compression: number, reconnection: number, kp = 2): SolarWindDrivers {
  const pressureNorm = clamp((1 - compression) / 0.4, 0, 1);
  return { bz: -clamp(reconnection, 0, 1) * 15, by: 0, pdyn: Math.max(0.5, pressureNorm * 10), kp };
}
