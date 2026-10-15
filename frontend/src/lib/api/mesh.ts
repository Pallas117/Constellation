// Mesh onboarding and device list behind useMesh (`staff` role and up).
import { hasRole, type Role } from "../roles.ts";

export const MESH_ONBOARDING_PATH = "/api/mesh/onboarding";
export const MESH_DEVICES_PATH = "/api/mesh/devices";
export const MESH_POLL_INTERVAL_MS = 30_000;

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

export interface MeshOnboarding {
  steps: OnboardingStep[];
  canEnroll: boolean;
  canSeeTeam: boolean;
  canRevokeAny: boolean;
  me: string | null;
}

/** Whether this session may call /api/mesh/* at all (the API requires staff). */
export function canUseMesh(signedIn: boolean, role: Role | null): boolean {
  return signedIn && role !== null && hasRole(role, "staff");
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
 * /devices only when the role and the server both allow it, because CyberTiger
 * counts 403s. Staff get their own devices back; operators get the whole team.
 * `onboardingLive` is false while onboarding is failing or has stopped on
 * 401/403, so a session that just ended doesn't draw a second 401 from /devices.
 */
export function meshDevicesPath(meshAllowed: boolean, onboardingLive: boolean, onboarding: MeshOnboarding | null): string | null {
  return meshAllowed && onboardingLive && onboarding?.canEnroll === true ? MESH_DEVICES_PATH : null;
}
