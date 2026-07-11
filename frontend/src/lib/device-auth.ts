import { buildFingerprint } from "./operator-fingerprint";
import { getAuthHeaders } from "./api/auth";

export async function registerDeviceWithLogin(name?: string) {
  const fp = await buildFingerprint();
  const headers = await getAuthHeaders();
  const res = await fetch("/api/device/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ name, fingerprintHash: fp.hash, fingerprintSignals: fp.signals }),
  });
  return res.json();
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
