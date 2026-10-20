import { buildFingerprint, type DeviceFingerprint } from "./operator-fingerprint";
import { getAuthHeaders } from "./api/auth";
import { apiBase } from "./api/base-url";
import { HttpFailure } from "./api/http-error";

/**
 * Binds this browser's fingerprint to the signed-in user (any role may).
 * The fingerprint goes in the POST body only, never the URL. `base` is the
 * apiBase() prefix: "" when same-origin, else the API's absolute origin.
 */
export async function postDeviceRegistration(
  base: string,
  headers: HeadersInit,
  fp: Pick<DeviceFingerprint, "hash" | "signals">,
  name?: string,
) {
  const res = await fetch(`${base}/api/device/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ name, fingerprintHash: fp.hash, fingerprintSignals: fp.signals }),
  });
  if (!res.ok) throw new HttpFailure("Couldn't register this device", res.status);
  return res.json();
}

export async function registerDeviceWithLogin(name?: string) {
  const fp = await buildFingerprint();
  const headers = await getAuthHeaders();
  return postDeviceRegistration(apiBase(), headers, fp, name);
}

export async function sendDeviceProof(deviceId: string, proof: { sig: string; timestamp: string; nonce?: string }) {
  const headers = await getAuthHeaders();
  const res = await fetch(`/api/device/${deviceId}/proof`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(proof),
  });
  return res.json();
}

export async function sendHeartbeat(deviceId: string) {
  const headers = await getAuthHeaders();
  const res = await fetch(`/api/device/${deviceId}/heartbeat`, {
    method: "POST",
    headers: { ...headers },
  });
  return res.json();
}

export async function sendStatus(deviceId: string, status: Record<string, unknown>) {
  const headers = await getAuthHeaders();
  const res = await fetch(`/api/device/${deviceId}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(status),
  });
  return res.json();
}
