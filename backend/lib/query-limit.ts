/** `?limit=` clamped to 1..max; a missing or non-numeric value gives the default (NaN passed
 * through Math.min/max, and slice(NaN) returned the whole buffer instead of the cap). */
export function queryLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) ? Math.max(1, Math.min(Math.floor(n), max)) : Math.min(fallback, max);
}
