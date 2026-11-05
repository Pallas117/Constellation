import { useSyncExternalStore } from 'react';
import { apiBase } from "@/lib/api/base-url";

export type ConnectivityMode = 'CLOUD' | 'SAT' | 'AIRGAP';

export interface ConnectivityStatus {
  mode: ConnectivityMode;
  latencyMs: number;
  lastChecked: string;
}

const POLL_MS = 30_000;

// Not measured yet: no latency and no check time, so nothing reads as a measured "0 ms". The mode stays CLOUD
// (the hooks that switch to fallbacks on AIRGAP shouldn't do so before the first answer).
let status: ConnectivityStatus = { mode: 'CLOUD', latencyMs: -1, lastChecked: '' };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function set(next: ConnectivityStatus) {
  status = next;
  for (const l of listeners) l();
}

async function check() {
  try {
    const response = await fetch(`${apiBase()}/api/system/connectivity`);
    if (response.ok) set((await response.json()) as ConnectivityStatus);
  } catch {
    // Server unreachable: treat the link as down (AIRGAP).
    set({ ...status, mode: 'AIRGAP', latencyMs: -1, lastChecked: new Date().toISOString() });
  }
}

/** One poll for the whole page: the HUD, the space-weather and the space-object hooks used to run three. */
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    void check();
    timer = setInterval(() => void check(), POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export const useConnectivity = (): ConnectivityStatus => useSyncExternalStore(subscribe, () => status);
