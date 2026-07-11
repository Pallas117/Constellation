import { bedrock } from "../lib/local-db.js";
import type { DeviceRecord, DeviceTelemetry } from "./../types.js";

const devices = new Map<string, DeviceRecord>();

export function listDevices(): DeviceRecord[] {
  return Array.from(devices.values());
}

export function getDevice(id: string): DeviceRecord | null {
  return devices.get(id) ?? null;
}

export function registerDevice(
  userId: string,
  fingerprintHash: string,
  fingerprintSignals?: Record<string, string | number>,
  name?: string,
): DeviceRecord {
  const id = `device_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const device: DeviceRecord = {
    id,
    userId,
    name,
    fingerprintHash,
    fingerprintSignals,
    registeredAt: now,
    lastSeen: now,
    status: "trusted",
    telemetry: undefined,
    swap: {
      tier: "L3",
      assignedLoadPercent: 0,
      activeJobs: 0,
      jobCapacity: 1,
      updatedAt: now,
    },
    quality: null,
  };
  devices.set(id, device);
  void bedrock.appendTelemetry({ type: "device-register", device, timestamp: now });
  return device;
}

export function heartbeatDevice(id: string): DeviceRecord | null {
  const device = devices.get(id);
  if (!device) return null;
  device.lastSeen = new Date().toISOString();
  devices.set(id, device);
  void bedrock.appendTelemetry({ type: "device-heartbeat", deviceId: id, timestamp: device.lastSeen });
  return device;
}

export function updateDeviceTelemetry(id: string, telemetry: DeviceTelemetry): DeviceRecord | null {
  const device = devices.get(id);
  if (!device) return null;
  device.telemetry = telemetry;
  device.lastSeen = new Date().toISOString();
  if (telemetry.temperatureC > 80 || telemetry.batteryPercent < 10) {
    device.status = "needs_reauth";
  }
  devices.set(id, device);
  void bedrock.appendTelemetry({ type: "device-telemetry", deviceId: id, telemetry, timestamp: device.lastSeen });
  return device;
}

export function updateDeviceStatus(
  id: string,
  payload: Partial<Pick<DeviceRecord, "status" | "fingerprintHash" | "fingerprintSignals">>,
): DeviceRecord | null {
  const device = devices.get(id);
  if (!device) return null;
  if (payload.status) device.status = payload.status;
  if (payload.fingerprintHash) device.fingerprintHash = payload.fingerprintHash;
  if (payload.fingerprintSignals) device.fingerprintSignals = payload.fingerprintSignals;
  device.lastSeen = new Date().toISOString();
  devices.set(id, device);
  void bedrock.appendTelemetry({ type: "device-status", deviceId: id, status: device.status, timestamp: device.lastSeen });
  return device;
}

export function updateDeviceQuality(
  id: string,
  payload: { score: number; sampleCount: number; networkStabilityMs: number },
): DeviceRecord | null {
  const device = devices.get(id);
  if (!device) return null;
  const now = new Date().toISOString();
  device.quality = { ...payload, updatedAt: now };
  device.lastSeen = now;
  devices.set(id, device);
  void bedrock.appendTelemetry({ type: "device-quality", deviceId: id, quality: device.quality, timestamp: now });
  return device;
}
