/**
 * Deterministic per-index random in [0, 1). Scene geometry built from it is a pure
 * function of its inputs (render-safe), and particles keep their identity across rebuilds.
 * `salt` gives independent streams for the different properties of one index.
 */
export function seeded(i: number, salt = 0): number {
  let t = (i * 0x9e3779b1 + salt * 0x85ebca6b + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
