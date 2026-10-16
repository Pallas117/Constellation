import { getAuthHeaders } from "./auth";
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

const DEVICE_SWAP_PLAN_URL = "/api/device/swap/plan";
const DEVICE_SWAP_REBALANCE_URL = "/api/device/swap/rebalance";

export async function getDeviceSwapPlan(): Promise<DeviceSwapPlan> {
  const headers = await getAuthHeaders();
  const response = await fetch(DEVICE_SWAP_PLAN_URL, { headers });
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
} = {}): Promise<DeviceSwapPlan> {
  const headers = await getAuthHeaders();
  const response = await fetch(DEVICE_SWAP_REBALANCE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new HttpFailure("Couldn't rebalance the SWAP network", response.status);
  }

  const json = await response.json();
  if (!json?.ok || !json?.assignments) {
    throw new Error(json?.error || "Invalid SWAP rebalance response");
  }
  return {
    timestamp: json.timestamp ?? new Date().toISOString(),
    assignments: json.assignments,
    summary: json.summary ?? {},
  };
}
