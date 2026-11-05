import { buildFingerprint } from "./operator-fingerprint";
import { apiBase } from "./api/base-url";

export async function registerDeviceWithLogin(name?: string) {
  const fp = await buildFingerprint();
  // apiBase(), like every other call, so it works without the dev proxy; the session cookie authenticates.
  const res = await fetch(`${apiBase()}/api/device/register`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, fingerprintHash: fp.hash, fingerprintSignals: fp.signals }),
  });
  return res.json();
}
