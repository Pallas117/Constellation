import crypto from "node:crypto";
import type { DeviceRecord } from "./device-registry.js";

const SECRET = process.env.DEVICE_AUTH_SECRET || "dev_device_secret_fallback";
const PROOF_TTL_MS = Number(process.env.DEVICE_PROOF_TTL_MS ?? 60_000);

export function deriveDeviceSecret(userId: string, deviceId: string, fingerprintHash: string): string {
  return crypto.createHmac("sha256", SECRET).update(`${userId}:${deviceId}:${fingerprintHash}`).digest("hex");
}

export function computeProof(deviceSecret: string, nonce = "", timestamp = Date.now().toString()) {
  const payload = `${timestamp}:${nonce}`;
  const sig = crypto.createHmac("sha256", deviceSecret).update(payload).digest("hex");
  return { sig, timestamp, nonce };
}

export function verifyProof(device: DeviceRecord, sig: string, timestamp: string, nonce = ""): boolean {
  if (!device) return false;
  const age = Date.now() - Date.parse(timestamp);
  if (Number.isNaN(age) || Math.abs(age) > PROOF_TTL_MS) {
    return false;
  }
  const secret = deriveDeviceSecret(device.userId, device.id, device.fingerprintHash);
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}:${nonce}`).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(sig, "hex"));
}
