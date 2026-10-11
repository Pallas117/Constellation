import crypto from "node:crypto";
import type { DeviceRecord } from "./device-registry.js";

const DEFAULT_PROOF_TTL_MS = 60_000;
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

/**
 * Max age of a proof (either way), in ms. A malformed DEVICE_PROOF_TTL_MS falls back to the
 * default instead of turning the age check off: NaN compares false with everything (GAU-98).
 */
function proofTtlMs(): number {
  const ttl = Number(process.env.DEVICE_PROOF_TTL_MS ?? DEFAULT_PROOF_TTL_MS);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_PROOF_TTL_MS;
}

/** Unexpired proofs one device can have accepted at once; beyond this its proofs are refused. */
export const MAX_LIVE_PROOFS_PER_DEVICE = 100;
// Accepted proofs per device id: lowercased signature -> last moment it could pass the age check.
const acceptedProofs = new Map<string, Map<string, number>>();

/**
 * Accept each proof once (GAU-99). False if the device already used this signature, or already
 * has MAX_LIVE_PROOFS_PER_DEVICE unexpired proofs: holding one device's secret then can't grow
 * memory without bound, and only that device is refused. Hex decoding ignores case, so an
 * uppercase copy is the same proof; signatures are lowercased before they are remembered.
 */
function acceptOnce(deviceId: string, sig: string, expiresAt: number): boolean {
  const now = Date.now();
  for (const [id, seen] of acceptedProofs) {
    for (const [s, exp] of seen) if (exp < now) seen.delete(s);
    if (seen.size === 0) acceptedProofs.delete(id);
  }
  const seen = acceptedProofs.get(deviceId) ?? new Map<string, number>();
  const key = sig.toLowerCase();
  if (seen.has(key) || seen.size >= MAX_LIVE_PROOFS_PER_DEVICE) return false;
  seen.set(key, expiresAt);
  acceptedProofs.set(deviceId, seen);
  return true;
}

/** Signs `${timestamp}:${nonce}`. The timestamp is Unix epoch milliseconds as a decimal string. */
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
  // Only the format computeProof signs: epoch milliseconds as a decimal string. Date.parse
  // returned NaN for that and accepted loose formats ("1" is 2001) instead (GAU-98).
  const ttl = proofTtlMs();
  if (!/^\d{1,16}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > ttl) {
    return false;
  }
  const secret = deriveDeviceSecret(device.userId, device.id, device.fingerprintHash);
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}:${nonce}`).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(sig, "hex"))) return false;
  // Only genuine proofs are remembered, until they would fail the age check anyway.
  return acceptOnce(device.id, sig, Number(timestamp) + ttl);
}
