// Parsers and path rules for the mesh feeds behind useMesh (`staff` role and up).
import type { MeshDevice, OnboardingStep } from "../../hooks/useMesh.ts";

export const MESH_ONBOARDING_PATH = "/api/mesh/onboarding";
export const MESH_DEVICES_PATH = "/api/mesh/devices";
export const MESH_POLL_INTERVAL_MS = 30_000;

export interface MeshOnboarding {
  steps: OnboardingStep[];
  canEnroll: boolean;
  canSeeTeam: boolean;
  canRevokeAny: boolean;
  me: string | null;
}

export function parseMeshOnboarding(json: unknown): MeshOnboarding {
  if (!json || typeof json !== "object") throw new Error("Invalid mesh onboarding format");
  const info = json as Record<string, unknown>;
  return {
    steps: Array.isArray(info.steps) ? (info.steps as OnboardingStep[]) : [],
    canEnroll: info.canEnroll === true,
    canSeeTeam: info.canSeeTeam === true,
    canRevokeAny: info.canRevokeAny === true,
    me: typeof info.me === "string" ? info.me : null,
  };
}

export function parseMeshDevices(json: unknown): MeshDevice[] {
  const devices = (json as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(devices)) throw new Error("Invalid mesh devices format");
  return devices as MeshDevice[];
}

/**
 * /devices only when onboarding says the caller may enrol, because CyberTiger counts
 * 403s. Staff get their own devices back; operators get the whole team.
 * `onboardingLive` is false while onboarding is failing or has stopped on 401/403, so a
 * session that just ended doesn't draw a second 401 from /devices.
 */
export function meshDevicesPath(onboardingLive: boolean, onboarding: MeshOnboarding | null): string | null {
  return onboardingLive && onboarding?.canEnroll === true ? MESH_DEVICES_PATH : null;
}
