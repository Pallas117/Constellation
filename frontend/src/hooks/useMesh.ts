import { useCallback, useEffect, useRef, useState } from "react";
import { getAuthHeaders } from "@/lib/api/auth";
import { apiBase } from "@/lib/api/base-url";
import { describeHttpFailure, HttpFailure } from "@/lib/api/http-error";
import { stopsPolling, type BatteryReading, type GuardReading } from "@/lib/mesh-onboarding";

const POLL_INTERVAL_MS = 30_000;

function getBaseUrl(): string {
  return apiBase();
}

export interface MeshReport {
  class: string;
  reason: string;
  loc: string;
  tailscale: boolean;
  exitNode: string;
  breakerOpen: boolean;
  argoVersion: string;
  checkedAt: string;
  receivedAt: string;
  host?: MeshHost;
  platform?: "macos" | "linux" | "windows" | "ios" | "android";
  battery?: BatteryReading;
  net?: MeshNet;
  guard?: MeshGuard;
}

/** Argo's resource guard decision (backend/mesh/store.ts MeshGuard, GAU-195). */
export interface MeshGuard extends GuardReading {
  at: string;
  level: "ok" | "watch" | "risk" | "block";
  reasons: string[];
  warnMin: number;
  swapRiseGB: number;
  minToFloor: number;
}

/** Argo's measured network scores (backend/mesh/store.ts MeshNet); -1 / "not measured" is never a guess. */
export interface MeshNet {
  privacy: number;
  privacyWhy: string[];
  rttMs: number;
  speed: string;
  signal: string;
  rssi?: number;
  noise?: number;
}

export interface MeshHost {
  ramGB: number;
  pressure: "normal" | "warn" | "critical" | "";
  swapUsedGB: number;
  diskFreeGB: number;
  cpus: number;
  os: string;
}

export type HostingVerdict = "agents" | "light" | "no" | "unknown";

export interface MeshDevice {
  name: string;
  enrolledAt: string;
  owner?: string;
  last?: MeshReport;
  rejectedAt?: string;
  hosting?: HostingVerdict;
  hostingWhy?: string[];
}

export interface OnboardingStep {
  id: string;
  title: string;
  command: string | null;
  detail: string;
  pending?: boolean;
}

async function api(path: string, init: RequestInit = {}) {
  return fetch(`${getBaseUrl()}/api/mesh${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(await getAuthHeaders()), ...(init.headers ?? {}) },
  });
}

interface MeshState {
  steps: OnboardingStep[];
  devices: MeshDevice[] | null;
  canEnroll: boolean;
  canSeeTeam: boolean;
  canRevokeAny: boolean;
  me: string | null;
  error: string | null;
  /** Set after a 401/403: polling has stopped until the page is reloaded (CyberTiger counts them). */
  stopped: boolean;
}

const INITIAL_MESH_STATE: MeshState = {
  steps: [],
  devices: null,
  canEnroll: false,
  canSeeTeam: false,
  canRevokeAny: false,
  me: null,
  error: null,
  stopped: false,
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : "Mesh request failed");
const stoppedBy = (err: unknown) => err instanceof HttpFailure && stopsPolling(err.status);

type Update = (prev: MeshState) => MeshState;

/** One poll of the onboarding info (and the device list when allowed), as an update to the held state. */
async function loadMesh(): Promise<{ update: Update; stopped: boolean }> {
  let info;
  try {
    const onboarding = await api("/onboarding");
    if (!onboarding.ok) throw new HttpFailure("Couldn't load the mesh", onboarding.status);
    info = await onboarding.json();
  } catch (err) {
    const error = errorMessage(err);
    const stopped = stoppedBy(err);
    return { update: (prev) => ({ ...prev, error, stopped }), stopped };
  }
  const next = {
    steps: info.steps,
    canEnroll: info.canEnroll === true,
    canSeeTeam: info.canSeeTeam === true,
    canRevokeAny: info.canRevokeAny === true,
    me: typeof info.me === "string" ? info.me : null,
    error: null,
  };
  // Only call /devices when allowed: 403s count as auth failures in CyberTiger.
  // Staff get their own devices back; operators get the whole team.
  if (info.canEnroll !== true) return { update: (prev) => ({ ...prev, ...next }), stopped: false };
  try {
    const res = await api("/devices");
    if (!res.ok) throw new HttpFailure("Couldn't load your devices", res.status);
    const devices: MeshDevice[] = (await res.json()).devices;
    return { update: (prev) => ({ ...prev, ...next, devices }), stopped: false };
  } catch (err) {
    const error = errorMessage(err);
    const stopped = stoppedBy(err);
    return { update: (prev) => ({ ...prev, ...next, error, stopped }), stopped };
  }
}

export function useMesh() {
  const [state, setState] = useState<MeshState>(INITIAL_MESH_STATE);
  const stoppedRef = useRef(false);

  const refresh = useCallback(async () => {
    const { update, stopped } = await loadMesh();
    stoppedRef.current ||= stopped;
    setState(update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = async () => {
      // A hidden tab has nobody to show it to; an expired session in a forgotten tab
      // was the way this page could get a teammate's address blocked.
      if (stoppedRef.current || (timer !== undefined && document.visibilityState === "hidden")) return;
      const { update, stopped } = await loadMesh();
      if (cancelled) return;
      if (stopped) {
        stoppedRef.current = true;
        clearInterval(timer);
      }
      setState(update);
    };
    void poll();
    timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /** Returns the one-time device token, or throws. */
  const enroll = useCallback(
    async (name: string): Promise<string> => {
      const res = await api("/devices", { method: "POST", body: JSON.stringify({ name }) });
      // An error page or empty body must still read as a message, not a JSON parse error.
      const body = (await res.json().catch(() => ({}))) as { error?: string; token?: string };
      if (!res.ok) throw new Error(body.error ?? describeHttpFailure("Couldn't enrol the device", res.status));
      void refresh();
      return body.token as string;
    },
    [refresh],
  );

  const revoke = useCallback(
    async (name: string) => {
      const res = await api(`/devices/${encodeURIComponent(name)}`, { method: "DELETE" });
      // A failed revoke must not look like a success: the device would keep its mesh access.
      if (!res.ok) throw new HttpFailure("Couldn't revoke the device", res.status);
      void refresh();
    },
    [refresh],
  );

  const { steps, devices, me, canEnroll, canSeeTeam, canRevokeAny, error, stopped } = state;
  return { steps, devices, me, canEnroll, canSeeTeam, canRevokeAny, error, stopped, enroll, revoke };
}

/** Argo's non-blocking warnings: the device works, but someone should look. */
export const WARNING_CLASSES: ReadonlySet<string> = new Set(["WPAD_RISK", "WIFI_RISK"]);
