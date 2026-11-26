/**
 * Which feeds may poll right now (GAU-235). CyberTiger counts 401/403s and auto-blocks the IP, so
 * the moment a session ends, every role-gated poll must stop: not after the session atom refetches,
 * not after navigation. `markSessionEnded` records the ending session before the sign-out request
 * leaves; `signedInFor` then reads as signed out at once. A new sign-in has a new session id, so
 * it is never held back by an old marker.
 */

export type SessionData = { user?: { id?: string } | null; session?: { id?: string } | null } | null | undefined;

const keyOf = (data: SessionData): string | null => data?.session?.id ?? data?.user?.id ?? null;

let ended: string | null = null;
const listeners = new Set<() => void>();

/** Call before `signOut()`: polls stop on this tick. */
export function markSessionEnded(data: SessionData): void {
  const key = keyOf(data);
  if (!key || key === ended) return;
  ended = key;
  for (const listener of listeners) listener();
}

export function subscribeSessionEnded(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const endedSessionKey = (): string | null => ended;

/** Test hook. */
export function resetSessionEnded(): void {
  ended = null;
}

/** True when `data` holds a user whose session has not been ended here. */
export function signedInFor(data: SessionData, endedKey: string | null = ended): boolean {
  if (!data?.user?.id) return false;
  return endedKey === null || keyOf(data) !== endedKey;
}

/** A role-gated route's path while signed in, else null (nothing is requested). */
export function gatedPath(path: string, signedIn: boolean): string | null {
  return signedIn ? path : null;
}

/**
 * Whether a protected page should swap for "checking your session" (which unmounts it, and a
 * wizard like /setup loses its step and swallows the first click). Only before the first answer:
 * a later background refetch keeps the page mounted.
 */
export const showSessionWait = (isPending: boolean, answeredBefore: boolean): boolean => isPending && !answeredBefore;
