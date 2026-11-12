import { apiBase } from "./base-url";
import { HttpFailure } from "./http-error";

export interface DeviceSwapAssignment {
  id: string;
  name?: string;
  status?: string;
  tier: number;
  score: number;
  health?: number;
  load?: number;
  lastSeen?: string;
  updatedAt?: string;
}

export interface DeviceSwapPlan {
  timestamp: string;
  assignments: DeviceSwapAssignment[];
  summary: Record<string, number>;
}

// apiBase(), like every other call, so these work without the dev proxy; the session cookie authenticates.
const DEVICE_SWAP_PLAN_URL = `${apiBase()}/api/device/swap/plan`;
const DEVICE_SWAP_REBALANCE_URL = `${apiBase()}/api/device/swap/rebalance`;

export async function getDeviceSwapPlan(): Promise<DeviceSwapPlan> {
  const response = await fetch(DEVICE_SWAP_PLAN_URL, { credentials: "include" });
  if (!response.ok) {
    throw new HttpFailure("Couldn't load the SWAP plan", response.status);
  }
  const json = await response.json();
  if (!json?.ok || !json?.plan) {
    throw new Error(json?.error || "Invalid SWAP plan response");
  }
  return json.plan as DeviceSwapPlan;
}

export async function requestDeviceSwapRebalance(payload: {
  requiredComputePercent?: number;
  requiredPowerWatts?: number;
  thermalThresholdC?: number;
} = {}): Promise<DeviceSwapPlan & { message?: string }> {
  const response = await fetch(DEVICE_SWAP_REBALANCE_URL, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new HttpFailure("Couldn't rebalance the SWAP network", response.status);
  }

  const json = await response.json();
  // The route answers { ok, plan: { timestamp, assignments, summary }, message } (device-registry.ts); reading
  // `assignments` at the top level failed every rebalance with "Invalid SWAP rebalance response".
  const plan = json?.plan;
  if (!json?.ok || !Array.isArray(plan?.assignments)) {
    throw new Error(json?.error || "Invalid SWAP rebalance response");
  }
  return {
    timestamp: plan.timestamp ?? new Date().toISOString(),
    assignments: plan.assignments,
    summary: plan.summary ?? {},
    message: typeof json.message === "string" ? json.message : undefined,
  };
}
