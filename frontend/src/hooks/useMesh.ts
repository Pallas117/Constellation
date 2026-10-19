import { useCallback, useEffect, useState } from "react";
import { getAuthHeaders } from "@/lib/api/auth";
import { apiBase } from "@/lib/api/base-url";
import { describeHttpFailure, HttpFailure } from "@/lib/api/http-error";

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
}

export interface MeshDevice {
  name: string;
  enrolledAt: string;
  owner?: string;
  last?: MeshReport;
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
}

const INITIAL_MESH_STATE: MeshState = {
  steps: [],
  devices: null,
  canEnroll: false,
  canSeeTeam: false,
  canRevokeAny: false,
  me: null,
  error: null,
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : "Mesh request failed");

/** One poll of the onboarding info (and the device list when allowed), as an update to the held state. */
async function loadMesh(): Promise<(prev: MeshState) => MeshState> {
  let info;
  try {
    const onboarding = await api("/onboarding");
    if (!onboarding.ok) throw new HttpFailure("Couldn't load the mesh", onboarding.status);
    info = await onboarding.json();
  } catch (err) {
    const error = errorMessage(err);
    return (prev) => ({ ...prev, error });
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
  if (info.canEnroll !== true) return (prev) => ({ ...prev, ...next });
  try {
    const res = await api("/devices");
    if (!res.ok) throw new HttpFailure("Couldn't load your devices", res.status);
    const devices: MeshDevice[] = (await res.json()).devices;
    return (prev) => ({ ...prev, ...next, devices });
  } catch (err) {
    const error = errorMessage(err);
    return (prev) => ({ ...prev, ...next, error });
  }
}

export function useMesh() {
  const [state, setState] = useState<MeshState>(INITIAL_MESH_STATE);

  const refresh = useCallback(async () => {
    setState(await loadMesh());
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const update = await loadMesh();
      if (!cancelled) setState(update);
    };
    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  /** Returns the one-time device token, or throws. */
  const enroll = useCallback(
    async (name: string): Promise<string> => {
      const res = await api("/devices", { method: "POST", body: JSON.stringify({ name }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? describeHttpFailure("Couldn't enrol the device", res.status));
      void refresh();
      return body.token as string;
    },
    [refresh],
  );

  const revoke = useCallback(
    async (name: string) => {
      await api(`/devices/${encodeURIComponent(name)}`, { method: "DELETE" });
      void refresh();
    },
    [refresh],
  );

  const { steps, devices, me, canEnroll, canSeeTeam, canRevokeAny, error } = state;
  return { steps, devices, me, canEnroll, canSeeTeam, canRevokeAny, error, enroll, revoke };
}

/** Argo's non-blocking warnings: the device works, but someone should look. */
export const WARNING_CLASSES: ReadonlySet<string> = new Set(["WPAD_RISK", "WIFI_RISK"]);
