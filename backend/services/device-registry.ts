import { bedrock } from "../lib/local-db.js";
import type { DeviceRecord, DeviceTelemetry } from "./../types.js";

const devices = new Map<string, DeviceRecord>();

/** Devices kept per user; registering one more evicts the least recently seen. */
export const MAX_DEVICES_PER_USER = 20;
/** Limits on the client-supplied fingerprint signals (the body limit is 2 MB). */
export const MAX_SIGNAL_KEYS = 64;
export const MAX_SIGNAL_KEY_LENGTH = 64;
export const MAX_SIGNAL_VALUE_LENGTH = 512;

/**
 * Keep at most MAX_SIGNAL_KEYS string/number entries, with keys and string
 * values truncated, so one request can't park megabytes in memory.
 */
export function sanitizeFingerprintSignals(signals: unknown): Record<string, string | number> | undefined {
  if (!signals || typeof signals !== "object" || Array.isArray(signals)) return undefined;
  const out: Record<string, string | number> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(signals as Record<string, unknown>)) {
    if (kept >= MAX_SIGNAL_KEYS) break;
    if (typeof value === "string") out[key.slice(0, MAX_SIGNAL_KEY_LENGTH)] = value.slice(0, MAX_SIGNAL_VALUE_LENGTH);
    else if (typeof value === "number" && Number.isFinite(value)) out[key.slice(0, MAX_SIGNAL_KEY_LENGTH)] = value;
    else continue;
    kept += 1;
  }
  return out;
}

function evictOldestDevices(userId: string): void {
  const owned = Array.from(devices.values()).filter((device) => device.userId === userId);
  if (owned.length <= MAX_DEVICES_PER_USER) return;
  owned.sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
  for (const device of owned.slice(0, owned.length - MAX_DEVICES_PER_USER)) {
    devices.delete(device.id);
  }
}

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
  const now = new Date().toISOString();
  const signals = sanitizeFingerprintSignals(fingerprintSignals);
  // Every login registers the browser again: reuse the user's record for the
  // same fingerprint instead of adding a new one each time.
  for (const existing of devices.values()) {
    if (existing.userId !== userId || existing.fingerprintHash !== fingerprintHash) continue;
    if (name !== undefined) existing.name = name;
    if (signals) existing.fingerprintSignals = signals;
    existing.lastSeen = now;
    // Signing in again is the re-authentication; a device marked untrusted stays so.
    if (existing.status === "needs_reauth") existing.status = "trusted";
    void bedrock.appendTelemetry({ type: "device-register", device: existing, timestamp: now });
    return existing;
  }
  const id = `device_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const device: DeviceRecord = {
    id,
    userId,
    name,
    fingerprintHash,
    fingerprintSignals: signals,
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
  evictOldestDevices(userId);
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
  if (payload.fingerprintSignals) device.fingerprintSignals = sanitizeFingerprintSignals(payload.fingerprintSignals);
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
