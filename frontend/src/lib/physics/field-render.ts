/**
 * Render-ready field-line buffers, built off the main thread.
 *
 * The worker traces the field and packs everything the scene needs into flat
 * typed arrays that are *transferred* (zero-copy) to the main thread, so
 * accepting a new trace costs ~1 ms instead of ~120 ms of deserialising and
 * rebuilding nested arrays (which used to drop frames on every retrace).
 */
import {
  auroralOvalBounds,
  bowShockStandoff,
  dipoleTiltRad,
  gsmToScene,
  shueMagnetopause,
  type MagnetosphereState,
  type SolarWindDrivers,
} from './geomagnetic';

export interface FieldRenderData {
  /** Segment endpoints in scene coordinates: [x0,y0,z0, x1,y1,z1, ...]. */
  segments: Float32Array;
  /** Linear-RGB colour per segment endpoint, matching `segments`. */
  colors: Float32Array;
  /** Field-line vertices in scene coordinates, all lines concatenated. */
  pathPoints: Float32Array;
  /** Cumulative arc length (Re) at each vertex, restarting at 0 per line. */
  pathCum: Float32Array;
  /** Index of each line's first vertex; length = lines + 1. */
  pathStart: Uint32Array;
  /** 1 where the line is open to the solar wind. */
  pathOpen: Uint8Array;
}

/** Scalars the boundaries need; cheap enough to compute on the main thread. */
export interface FieldScalars {
  r0: number;
  alpha: number;
  bowShock: number;
  tilt: number;
  oval: { equatorward: number; poleward: number };
}

export interface TracedModel extends FieldScalars {
  /** Share of seed footpoints whose field line is open; null until traced. */
  openFraction: number | null;
  /** Null until the worker has traced the field lines. */
  render: FieldRenderData | null;
}

export function fieldScalars(d: SolarWindDrivers, epochMs: number): FieldScalars {
  const { r0, alpha } = shueMagnetopause(d.bz, d.pdyn);
  return { r0, alpha, bowShock: bowShockStandoff(r0), tilt: dipoleTiltRad(epochMs), oval: auroralOvalBounds(d.kp) };
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hex = (h: string): [number, number, number] => [
  srgbToLinear(parseInt(h.slice(1, 3), 16) / 255),
  srgbToLinear(parseInt(h.slice(3, 5), 16) / 255),
  srgbToLinear(parseInt(h.slice(5, 7), 16) / 255),
];

// Lightbound brand palette: closed flux warm white -> Earth blue, open flux amber -> Sun.
export const CLOSED_NEAR = hex('#F3F0E8');
export const CLOSED_FAR = hex('#2378C4');
export const OPEN_NEAR = hex('#E7B14A');
export const OPEN_FAR = hex('#C2552A');

const LOG_B_MIN = Math.log10(5);
const LOG_B_MAX = Math.log10(60000);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export function buildFieldRender(state: MagnetosphereState): FieldRenderData {
  const lines = state.lines;
  let vertices = 0;
  let segments = 0;
  for (const l of lines) {
    vertices += l.points.length;
    segments += Math.max(0, l.points.length - 1);
  }
  const seg = new Float32Array(segments * 6);
  const col = new Float32Array(segments * 6);
  const pathPoints = new Float32Array(vertices * 3);
  const pathCum = new Float32Array(vertices);
  const pathStart = new Uint32Array(lines.length + 1);
  const pathOpen = new Uint8Array(lines.length);

  let v = 0;
  let s = 0;
  const vc = new Float32Array(3);
  const vertexColor = (near: number[], far: number[], b: number, r: number) => {
    const t = clamp01((Math.log10(Math.max(b, 1e-6)) - LOG_B_MIN) / (LOG_B_MAX - LOG_B_MIN));
    const w = t ** 1.6;
    // Lines converge at the poles; dim them near the surface so the additive
    // blend doesn't saturate the inner magnetosphere.
    const k = (0.3 + 0.5 * t) * (0.15 + 0.85 * smoothstep(1.0, 2.4, r));
    for (let c = 0; c < 3; c++) vc[c] = (far[c] + (near[c] - far[c]) * w) * k;
    return vc;
  };

  lines.forEach((line, li) => {
    const open = line.topology === 'open';
    pathOpen[li] = open ? 1 : 0;
    pathStart[li] = v;
    const near = open ? OPEN_NEAR : CLOSED_NEAR;
    const far = open ? OPEN_FAR : CLOSED_FAR;
    let cum = 0;
    let prev: [number, number, number] | null = null;
    for (let i = 0; i < line.points.length; i++) {
      const p = gsmToScene(line.points[i]);
      if (prev) cum += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
      pathPoints.set(p, v * 3);
      pathCum[v] = cum;
      v++;
      if (prev) {
        const ra = Math.hypot(...line.points[i - 1]);
        const rb = Math.hypot(...line.points[i]);
        seg.set(prev, s * 6);
        seg.set(p, s * 6 + 3);
        col.set(vertexColor(near, far, line.strength[i - 1], ra), s * 6);
        col.set(vertexColor(near, far, line.strength[i], rb), s * 6 + 3);
        s++;
      }
      prev = p;
    }
  });
  pathStart[lines.length] = v;
  return { segments: seg, colors: col, pathPoints, pathCum, pathStart, pathOpen };
}

/** Buffers to list in postMessage's transfer argument. */
export function transferables(r: FieldRenderData): ArrayBuffer[] {
  return [r.segments, r.colors, r.pathPoints, r.pathCum, r.pathStart, r.pathOpen].map((a) => a.buffer as ArrayBuffer);
}

export function tracedModel(state: MagnetosphereState): TracedModel {
  return {
    r0: state.r0,
    alpha: state.alpha,
    bowShock: state.bowShock,
    tilt: state.tilt,
    oval: state.oval,
    openFraction: state.openFraction,
    render: buildFieldRender(state),
  };
}
