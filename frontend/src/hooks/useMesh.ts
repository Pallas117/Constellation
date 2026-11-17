import { useCallback, useState } from "react";
import { apiBase } from "@/lib/api/base-url";
import { describeHttpFailure, HttpFailure } from "@/lib/api/http-error";
import {
  MESH_ONBOARDING_PATH,
  MESH_POLL_INTERVAL_MS,
  meshDevicesPath,
  parseMeshDevices,
  parseMeshOnboarding,
  type MeshOnboarding,
} from "@/lib/api/mesh";
import type { BatteryReading, GuardReading } from "@/lib/mesh-onboarding";
import type { LinkReport } from "@/lib/link-stability";
import { usePolledFeed, useFeedSession } from "./usePolledFeed";

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
  link?: LinkReport;
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
  /** Bundles waiting at the Gauss hub for this device: counts and sizes only. */
  relay?: { queued: number; bytes: number };
  /** Fingerprint of the device's published keys, to compare with `argo keys` on the device. */
  keyFingerprint?: string;
}

export interface OnboardingStep {
  id: string;
  title: string;
  command: string | null;
  detail: string;
  pending?: boolean;
}

function api(path: string, init: RequestInit = {}) {
  return fetch(`${getBaseUrl()}/api/mesh${path}`, {
    ...init,
    credentials: "include",
    // The session cookie authenticates; no /get-session round trip per call for a bearer token it never has.
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const MESH_SIGN_IN_MESSAGE = "Couldn't load the mesh: sign in with a staff account.";

/**
 * Two feeds on the shared poller: onboarding always, the device list only when onboarding
 * says the caller may enrol (403s count as auth failures in CyberTiger). A 401/403 stops
 * that feed (`stopped`) until the page is reloaded or the session changes.
 */
export function useMesh() {
  const { userKey } = useFeedSession();
  // Bumped after enrol/revoke: restarting the feeds fetches straight away.
  const [refreshKey, setRefreshKey] = useState(0);
  const restartKey = `${userKey}:${refreshKey}`;

  const onboardingFeed = usePolledFeed<MeshOnboarding>({
    path: MESH_ONBOARDING_PATH,
    intervalMs: MESH_POLL_INTERVAL_MS,
    parse: parseMeshOnboarding,
    signInMessage: MESH_SIGN_IN_MESSAGE,
    restartKey,
  });
  const onboarding = onboardingFeed.data;
  const devicesFeed = usePolledFeed<MeshDevice[]>({
    path: meshDevicesPath(onboardingFeed.status === "live", onboarding),
    intervalMs: MESH_POLL_INTERVAL_MS,
    parse: parseMeshDevices,
    signInMessage: MESH_SIGN_IN_MESSAGE,
    restartKey,
  });

  const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);

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

  const steps = onboarding?.steps ?? [];
  const canEnroll = onboarding?.canEnroll ?? false;
  const canSeeTeam = onboarding?.canSeeTeam ?? false;
  const canRevokeAny = onboarding?.canRevokeAny ?? false;
  const me = onboarding?.me ?? null;
  const devices = devicesFeed.data;
  const error = onboardingFeed.error ?? devicesFeed.error;
  const stopped = onboardingFeed.status === "sign-in-required" || devicesFeed.status === "sign-in-required";
  return { steps, devices, me, canEnroll, canSeeTeam, canRevokeAny, error, stopped, enroll, revoke };
}

/** Argo's non-blocking warnings: the device works, but someone should look. */
export const WARNING_CLASSES: ReadonlySet<string> = new Set(["WPAD_RISK", "WIFI_RISK"]);
