import { bedrock } from "../lib/local-db.js";
import { listDevices, updateDeviceStatus } from "./device-registry.js";
import type { DeviceRecord, DeviceSwapAssignment } from "../types.js";

export interface SwapRequest {
  requiredComputePercent?: number;
  requiredPowerWatts?: number;
  thermalThresholdC?: number;
}

const DEFAULT_THERMAL_THRESHOLD = Number(process.env.DEVICE_SWAP_THERMAL_THRESHOLD_C ?? 70);
const DEFAULT_COMPUTE_LOAD = Number(process.env.DEVICE_SWAP_DEFAULT_COMPUTE_PERCENT ?? 70);
const DEFAULT_POWER_BUDGET = Number(process.env.DEVICE_SWAP_DEFAULT_POWER_W ?? 120);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function computeHealthScore(device: DeviceRecord): number {
  let score = 100;
  if (device.status !== "trusted") {
    score -= 40;
  }

  const telemetry = device.telemetry;
  if (!telemetry) {
    score -= 20;
  } else {
    const thermalPenalty = Math.max(0, telemetry.temperatureC - 55) * 0.9;
    const batteryPenalty = Math.max(0, 40 - telemetry.batteryPercent) * 0.6;
    const computePenalty = Math.max(0, telemetry.computeLoadPercent - 65) * 0.8;
    const latencyPenalty = Math.max(0, telemetry.networkLatencyMs - 120) * 0.12;
    score -= thermalPenalty + batteryPenalty + computePenalty + latencyPenalty;

    if (telemetry.temperatureC >= 85) {
      score -= 15;
    }
    if (telemetry.batteryPercent <= 10) {
      score -= 20;
    }
  }

  return clamp(score, 0, 100);
}

function computeTier(score: number): "L1" | "L2" | "L3" {
  if (score >= 70) return "L1";
  if (score >= 45) return "L2";
  return "L3";
}

function computeJobCapacity(device: DeviceRecord): number {
  const telemetry = device.telemetry;
  if (!telemetry) return 1;
  const capacity = Math.max(1, Math.floor((100 - telemetry.computeLoadPercent) / 20) + 1);
  return clamp(capacity, 1, 5);
}

function buildAssignment(device: DeviceRecord): DeviceSwapAssignment {
  const score = computeHealthScore(device);
  const tier = computeTier(score);
  const jobCapacity = computeJobCapacity(device);
  const recommendedLoadPercent = Math.min(100, Math.floor(score * 0.9));
  const reason = device.telemetry
    ? `health=${score.toFixed(0)} status=${device.status}`
    : `unknown telemetry, using conservative fallback`; 

  return {
    deviceId: device.id,
    tier,
    recommendedLoadPercent,
    activeJobs: device.swap?.activeJobs ?? 0,
    jobCapacity,
    score,
    reason,
  };
}

function sortAssignments(assignments: DeviceSwapAssignment[]): DeviceSwapAssignment[] {
  return assignments
    .slice()
    .sort((a, b) => {
      if (a.tier !== b.tier) {
        return a.tier.localeCompare(b.tier);
      }
      return b.score - a.score;
    });
}

export function createSwapPlan(request: SwapRequest = {}): { timestamp: string; assignments: DeviceSwapAssignment[]; summary: Record<string, number> } {
  const look = {
    requiredComputePercent: request.requiredComputePercent ?? DEFAULT_COMPUTE_LOAD,
    requiredPowerWatts: request.requiredPowerWatts ?? DEFAULT_POWER_BUDGET,
    thermalThresholdC: request.thermalThresholdC ?? DEFAULT_THERMAL_THRESHOLD,
  };

  const devices = listDevices();
  const assignments = devices.map((device) => buildAssignment(device));
  const sorted = sortAssignments(assignments);
  const healthy = sorted.filter((it) => it.score >= 70).length;
  const warning = sorted.filter((it) => it.score >= 45 && it.score < 70).length;
  const critical = sorted.filter((it) => it.score < 45).length;

  const activeL1 = sorted.filter((it) => it.tier === "L1").map((it) => it.deviceId);
  const activeL2 = sorted.filter((it) => it.tier === "L2").map((it) => it.deviceId);
  const activeL3 = sorted.filter((it) => it.tier === "L3").map((it) => it.deviceId);

  const plan = {
    timestamp: new Date().toISOString(),
    assignments: sorted,
    summary: {
      totalDevices: sorted.length,
      healthy,
      warning,
      critical,
      activeL1: activeL1.length,
      activeL2: activeL2.length,
      activeL3: activeL3.length,
      requiredComputePercent: look.requiredComputePercent,
      requiredPowerWatts: look.requiredPowerWatts,
      thermalThresholdC: look.thermalThresholdC,
    } as Record<string, number>,
  };

  void bedrock.appendTelemetry({ type: "swap-plan", plan, timestamp: plan.timestamp });
  return plan;
}

export function rebalanceDeviceNetwork(request: SwapRequest = {}): { plan: ReturnType<typeof createSwapPlan>; message: string } {
  const plan = createSwapPlan(request);
  const assignmentCount = plan.assignments.reduce((sum, assignment) => sum + assignment.jobCapacity, 0);
  const message = assignmentCount > 0 ? "Device network rebalanced across redundancy tiers" : "No devices available to assign";

  for (const assignment of plan.assignments) {
    const device = listDevices().find((deviceRecord) => deviceRecord.id === assignment.deviceId);
    if (!device) continue;
    updateDeviceStatus(device.id, { status: assignment.score < 45 ? "needs_reauth" : device.status });
    device.swap = {
      tier: assignment.tier,
      assignedLoadPercent: assignment.recommendedLoadPercent,
      activeJobs: assignment.activeJobs,
      jobCapacity: assignment.jobCapacity,
      updatedAt: new Date().toISOString(),
    };
  }

  void bedrock.appendTelemetry({ type: "swap-rebalance", request, plan, timestamp: new Date().toISOString() });
  return { plan, message };
}
