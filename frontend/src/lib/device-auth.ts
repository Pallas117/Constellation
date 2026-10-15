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
