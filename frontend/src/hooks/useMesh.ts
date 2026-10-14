import { useCallback, useEffect, useState } from "react";
import { getAuthHeaders } from "@/lib/api/auth";

const POLL_INTERVAL_MS = 30_000;

function getBaseUrl(): string {
  return import.meta.env.VITE_HELIO_PROXY_URL ?? "http://127.0.0.1:3001";
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

export function useMesh() {
  const [steps, setSteps] = useState<OnboardingStep[]>([]);
  const [devices, setDevices] = useState<MeshDevice[] | null>(null);
  const [canEnroll, setCanEnroll] = useState(false);
  const [canSeeTeam, setCanSeeTeam] = useState(false);
  const [canRevokeAny, setCanRevokeAny] = useState(false);
  const [me, setMe] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const onboarding = await api("/onboarding");
      if (!onboarding.ok) throw new Error(`Mesh HTTP ${onboarding.status}`);
      const info = await onboarding.json();
      setSteps(info.steps);
      setCanEnroll(info.canEnroll === true);
      setCanSeeTeam(info.canSeeTeam === true);
      setCanRevokeAny(info.canRevokeAny === true);
      setMe(typeof info.me === "string" ? info.me : null);
      setError(null);
      // Only call /devices when allowed: 403s count as auth failures in CyberTiger.
      // Staff get their own devices back; operators get the whole team.
      if (info.canEnroll !== true) return;
      const res = await api("/devices");
      if (!res.ok) throw new Error(`Mesh HTTP ${res.status}`);
      setDevices((await res.json()).devices);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mesh request failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /** Returns the one-time device token, or throws. */
  const enroll = useCallback(
    async (name: string): Promise<string> => {
      const res = await api("/devices", { method: "POST", body: JSON.stringify({ name }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
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

  return { steps, devices, me, canEnroll, canSeeTeam, canRevokeAny, error, enroll, revoke };
}
