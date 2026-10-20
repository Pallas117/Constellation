import crypto from "node:crypto";
import type { DeviceRecord } from "../types.js";

const PROOF_TTL_MS = Number(process.env.DEVICE_PROOF_TTL_MS ?? 60_000);
const MIN_SECRET_LENGTH = 32;
// Values that have been public in this repo; a .env copied without editing may still hold one.
const PUBLIC_SECRETS = new Set(["dev_device_secret_fallback", "replace-with-your-secret-or-leave-empty-for-dev"]);

/**
 * The server key for device proofs, or null when it is unset, shorter than 32 characters or
 * a value that has been public. There is no fallback: without a usable key, device proofs are
 * disabled (fail closed) instead of being signed with a key anyone can read (GAU-97).
 */
export function deviceAuthSecret(): string | null {
  const secret = process.env.DEVICE_AUTH_SECRET ?? "";
  return secret.length >= MIN_SECRET_LENGTH && !PUBLIC_SECRETS.has(secret) ? secret : null;
}

let warnedDisabled = false;

/** Whether device proofs can be verified. Logs once when they cannot, never the key itself. */
export function deviceProofsEnabled(): boolean {
  if (deviceAuthSecret() !== null) return true;
  if (!warnedDisabled) {
    warnedDisabled = true;
    console.error(
      `[device-auth] DEVICE_AUTH_SECRET is unset, shorter than ${MIN_SECRET_LENGTH} characters or a public value; device proofs are disabled.`,
    );
  }
  return false;
}

export function deriveDeviceSecret(userId: string, deviceId: string, fingerprintHash: string): string {
  const key = deviceAuthSecret();
  if (key === null) {
    throw new Error("Device proofs are disabled: DEVICE_AUTH_SECRET is not configured");
  }
  return crypto.createHmac("sha256", key).update(`${userId}:${deviceId}:${fingerprintHash}`).digest("hex");
}

export function computeProof(deviceSecret: string, nonce = "", timestamp = Date.now().toString()) {
  const payload = `${timestamp}:${nonce}`;
  const sig = crypto.createHmac("sha256", deviceSecret).update(payload).digest("hex");
  return { sig, timestamp, nonce };
}

export function verifyProof(device: DeviceRecord, sig: string, timestamp: string, nonce = ""): boolean {
  if (!device || !deviceProofsEnabled()) return false;
  // sig/timestamp come straight from a JSON body; anything but a 32-byte hex HMAC is invalid
  // (timingSafeEqual would throw on a length mismatch).
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/i.test(sig) || typeof timestamp !== "string") {
    return false;
  }
  const age = Date.now() - Date.parse(timestamp);
  if (Number.isNaN(age) || Math.abs(age) > PROOF_TTL_MS) {
    return false;
  }
  const secret = deriveDeviceSecret(device.userId, device.id, device.fingerprintHash);
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}:${nonce}`).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(sig, "hex"));
}
