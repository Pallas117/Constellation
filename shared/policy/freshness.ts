/**
 * Measurement freshness policy (GAU-212): how old each measured quantity may be before Gauss
 * treats it as not current. Past its bound a value is unknown or flagged stale, never shown as
 * live. The numbers live in freshness.json, the one source of truth; the backend, the frontend and
 * the guard test (backend/lib/freshness-policy.test.ts) read them through this module, so one Kp
 * cannot be fresh on one surface and stale on another (audit finding F7).
 *
 * Ages are of the measurement itself (its observation time), not of the fetch that brought it.
 */
import policy from "./freshness.json" with { type: "json" };

export interface FreshnessRule {
  /** Maximum age of a measurement, in minutes. */
  maxAgeMin: number;
  /** How often the source publishes. */
  cadence: string;
  /** The upstream product the bound applies to. */
  source: string;
  /** Why the bound is what it is. */
  why: string;
}

/** One key per measured quantity; a misspelt key is a type error. */
export type FreshnessKey = keyof typeof policy;

export const FRESHNESS_POLICY: Readonly<Record<FreshnessKey, FreshnessRule>> = policy;

/** Maximum measurement age for `key`, in minutes. */
export const freshnessMin = (key: FreshnessKey): number => FRESHNESS_POLICY[key].maxAgeMin;

/** Maximum measurement age for `key`, in ms. */
export const freshnessMs = (key: FreshnessKey): number => freshnessMin(key) * 60_000;

/** The bound as people read it in a reason: "15 min", "6 h". */
export function freshnessLabel(key: FreshnessKey): string {
  const min = freshnessMin(key);
  return min % 60 === 0 ? `${min / 60} h` : `${min} min`;
}
