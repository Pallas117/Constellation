import { useCallback, useState } from "react";
import { getAuthHeaders } from "@/lib/api/auth";
import { apiBase } from "@/lib/api/base-url";
import { describeHttpFailure } from "@/lib/api/http-error";
import {
  MESH_ONBOARDING_PATH,
  MESH_POLL_INTERVAL_MS,
  canUseMesh,
  meshDevicesPath,
  parseMeshDevices,
  parseMeshOnboarding,
  type OnboardingStep,
} from "@/lib/api/mesh";
import { useFeedSession, usePolledFeed } from "@/hooks/usePolledFeed";

export type { MeshDevice, MeshReport, OnboardingStep } from "@/lib/api/mesh";

const NO_STEPS: OnboardingStep[] = [];

function getBaseUrl(): string {
  return apiBase();
}

async function api(path: string, init: RequestInit = {}) {
  return fetch(`${getBaseUrl()}/api/mesh${path}`, {
    ...init,
    credentials: "include",
    headers: { "content-type": "application/json", ...(await getAuthHeaders()), ...(init.headers ?? {}) },
  });
}

export function useMesh() {
  const session = useFeedSession();
  // Every /api/mesh route needs staff, and CyberTiger counts 401/403s: a session
  // that can't use the mesh never asks.
  const meshAllowed = canUseMesh(session.signedIn, session.role);
  // Bumped after enrol/revoke so both feeds fetch again straight away.
  const [generation, setGeneration] = useState(0);
  const restartKey = `${session.userKey}:${generation}`;

  const onboarding = usePolledFeed({
    path: session.resolved && meshAllowed ? MESH_ONBOARDING_PATH : null,
    intervalMs: MESH_POLL_INTERVAL_MS,
    parse: parseMeshOnboarding,
    disabledStatus: session.resolved ? "sign-in-required" : "waiting",
    signInMessage: "Couldn't load the mesh: sign in with a staff account.",
    restartKey,
  });
  const devices = usePolledFeed({
    path: meshDevicesPath(meshAllowed, onboarding.status === "live", onboarding.data),
    intervalMs: MESH_POLL_INTERVAL_MS,
    parse: parseMeshDevices,
    signInMessage: "Couldn't load your devices: sign in with a staff account.",
    restartKey,
  });

  const refresh = useCallback(() => setGeneration((n) => n + 1), []);

  /** Returns the one-time device token, or throws. */
  const enroll = useCallback(
    async (name: string): Promise<string> => {
      const res = await api("/devices", { method: "POST", body: JSON.stringify({ name }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? describeHttpFailure("Couldn't enrol the device", res.status));
      refresh();
      return body.token as string;
    },
    [refresh],
  );

  const revoke = useCallback(
    async (name: string) => {
      await api(`/devices/${encodeURIComponent(name)}`, { method: "DELETE" });
      refresh();
    },
    [refresh],
  );

  const info = onboarding.data;
  return {
    steps: info?.steps ?? NO_STEPS,
    devices: info?.canEnroll ? devices.data : null,
    me: info?.me ?? null,
    canEnroll: info?.canEnroll ?? false,
    canSeeTeam: info?.canSeeTeam ?? false,
    canRevokeAny: info?.canRevokeAny ?? false,
    error: onboarding.error ?? devices.error,
    enroll,
    revoke,
  };
}
