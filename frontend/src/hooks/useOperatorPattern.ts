import { useEffect, useState } from "react";
import { fetchPatternStatus, type PatternStatus } from "@/lib/pattern";

type State = { key: string; status: PatternStatus | null; error: string | null };

// One status request per user and refresh, shared by the route guard and the pattern pages.
const cache = new Map<string, Promise<PatternStatus>>();
let generation = 0;
const listeners = new Set<() => void>();

/** Re-read the pattern status everywhere (after setting or drawing it). */
export function refreshOperatorPattern(): void {
  cache.clear();
  generation++;
  for (const listener of listeners) listener();
}

function load(key: string): Promise<PatternStatus> {
  let pending = cache.get(key);
  if (!pending) {
    pending = fetchPatternStatus();
    cache.set(key, pending);
    pending.catch(() => cache.delete(key));
  }
  return pending;
}

/**
 * The operator pattern status for the signed-in user (GAU-235): whether they must draw one, have
 * set one, and have drawn it in this session. Only asked for when `userId` is set: the route is
 * open to every signed-in role, so it never earns a 401/403 from CyberTiger.
 */
export function useOperatorPattern(userId: string | null | undefined): { status: PatternStatus | null; error: string | null; loading: boolean } {
  const [tick, setTick] = useState(generation);
  const [state, setState] = useState<State>({ key: "", status: null, error: null });
  const key = userId ? `${userId}|${tick}` : "";

  useEffect(() => {
    const listener = () => setTick(generation);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!userId) return;
    let live = true;
    load(userId).then(
      (status) => live && setState({ key, status, error: null }),
      (err: unknown) => live && setState({ key, status: null, error: err instanceof Error ? err.message : "Could not check your pattern." }),
    );
    return () => {
      live = false;
    };
  }, [userId, key]);

  const current = state.key === key ? state : null;
  return { status: current?.status ?? null, error: current?.error ?? null, loading: Boolean(userId) && !current };
}
