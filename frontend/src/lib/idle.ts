/**
 * Idle sign-out for the operator console (GAU-235). After a stretch with no
 * pointer, key or touch input in any Gauss tab, the console signs the operator
 * out (the server ends the session); a minute before, it warns. The server also
 * expires any session unused for 12 hours (backend/passkey-policy.ts), which
 * covers closed tabs and sleeping laptops.
 *
 * VITE_IDLE_SIGNOUT_MINUTES sets the limit at build time (default 15; 0 turns
 * it off, e.g. for a wall display that is watched, not touched).
 */

export const DEFAULT_IDLE_MINUTES = 15;
export const MAX_IDLE_MINUTES = 240;
export const IDLE_WARNING_MS = 60_000;
/** Shared by every tab of this origin, so activity in one keeps the others signed in. */
export const ACTIVITY_STORAGE_KEY = "gauss.lastActivity";

export function idleLimitMs(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_IDLE_MINUTES * 60_000;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_IDLE_MINUTES * 60_000;
  if (minutes === 0) return 0;
  return Math.min(Math.max(minutes, 1), MAX_IDLE_MINUTES) * 60_000;
}

export type IdlePhase = "active" | "warning" | "expired";

export function idlePhase(lastActivity: number, now: number, limitMs: number, warningMs = IDLE_WARNING_MS): { phase: IdlePhase; remainingMs: number } {
  const remainingMs = Math.max(0, lastActivity + limitMs - now);
  if (remainingMs === 0) return { phase: "expired", remainingMs };
  return { phase: remainingMs <= warningMs ? "warning" : "active", remainingMs };
}

/** The latest activity seen here or in another tab; ignores unreadable or future values. */
export function latestActivity(local: number, shared: string | null, now: number): number {
  const other = Number(shared);
  return Number.isFinite(other) && other <= now + 5_000 ? Math.max(local, other) : local;
}
