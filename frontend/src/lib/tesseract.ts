/**
 * The rotating tesseract shared by the operator geometry (GAU-235) and the
 * signing-key pattern lock (backend/trust/pattern-page.ts, GAU-67): 16
 * vertices at (±1, ±1, ±1, ±1), 32 edges between vertices one coordinate
 * apart, rotated in the xy, zw and xz planes and projected 4D → 3D → 2D from
 * a viewer at distance 2.45 (the UI-UX-Gauss GeometricEncryption projection).
 * The vertex order and labels match the pattern lock's.
 */

export type Vec4 = readonly [number, number, number, number];

export interface Rotation {
  xy: number;
  zw: number;
  xz: number;
}

export const VERTEX_LABELS = "ABCDEFGHIJKLMNOP";

export const VERTICES: readonly Vec4[] = (() => {
  const out: Vec4[] = [];
  for (let x = -1; x <= 1; x += 2)
    for (let y = -1; y <= 1; y += 2) for (let z = -1; z <= 1; z += 2) for (let w = -1; w <= 1; w += 2) out.push([x, y, z, w]);
  return out;
})();

export const EDGES: ReadonlyArray<readonly [number, number]> = (() => {
  const out: Array<readonly [number, number]> = [];
  for (let i = 0; i < VERTICES.length; i++)
    for (let j = i + 1; j < VERTICES.length; j++) {
      if (VERTICES[i].filter((c, k) => c !== VERTICES[j][k]).length === 1) out.push([i, j]);
    }
  return out;
})();

const DISTANCE = 2.45;
/** Largest projected extent over all orientations is under 0.671, so this scale keeps the figure inside its box. */
export const FIT = 0.675;

/**
 * Screen position of a vertex in a `size`-pixel square box, and its depth: the projection's
 * scale there (0.09 far to 0.89 near over all orientations), for drawing near vertices larger and brighter.
 */
export function project([x0, y0, z0, w0]: Vec4, rot: Rotation, size: number): { x: number; y: number; depth: number } {
  let x = x0;
  let y = y0;
  let z = z0;
  let w = w0;
  let a = x * Math.cos(rot.xy) - y * Math.sin(rot.xy);
  let b = x * Math.sin(rot.xy) + y * Math.cos(rot.xy);
  x = a;
  y = b;
  a = z * Math.cos(rot.zw) - w * Math.sin(rot.zw);
  b = z * Math.sin(rot.zw) + w * Math.cos(rot.zw);
  z = a;
  w = b;
  a = x * Math.cos(rot.xz) - z * Math.sin(rot.xz);
  b = x * Math.sin(rot.xz) + z * Math.cos(rot.xz);
  x = a;
  z = b;
  const f4 = 1 / (DISTANCE - w);
  const f3 = 1 / (DISTANCE - z * f4);
  const scale = size * FIT;
  return { x: x * f4 * f3 * scale + size / 2, y: y * f4 * f3 * scale + size / 2, depth: f4 * f3 };
}

/** A fresh starting orientation: the figure never opens the same way twice. */
export function randomRotation(random: () => number = Math.random): Rotation {
  const turn = () => random() * Math.PI * 2;
  return { xy: turn(), zw: turn(), xz: turn() };
}
