import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import express from "express";
import router from "./device-registry.js";
import { computeProof, deriveDeviceSecret } from "./services/device-auth.js";
import type { DeviceRecord } from "./types.js";

type DeviceBody = { ok: boolean; device: DeviceRecord };

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as any).auth = {
    userId: "proof-user",
    email: "proof@example.com",
    role: "operator",
    rawRoles: ["operator"],
    token: "test-token",
  };
  next();
});
app.use("/api/device", router);

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/device`;
after(() => server.close());

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function register(fingerprintHash: string): Promise<DeviceRecord> {
  const res = await fetch(`${base}/register`, json({ fingerprintHash }));
  assert.equal(res.status, 201);
  return ((await res.json()) as DeviceBody).device;
}

async function statusOf(id: string): Promise<DeviceRecord["status"]> {
  return ((await (await fetch(`${base}/${id}`)).json()) as DeviceBody).device.status;
}

function proofFor(deviceSecret: string) {
  return computeProof(deviceSecret, "n1", new Date().toISOString());
}

async function withKey(value: string | undefined, fn: () => Promise<void>) {
  const saved = process.env.DEVICE_AUTH_SECRET;
  if (value === undefined) delete process.env.DEVICE_AUTH_SECRET;
  else process.env.DEVICE_AUTH_SECRET = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env.DEVICE_AUTH_SECRET;
    else process.env.DEVICE_AUTH_SECRET = saved;
  }
}

test("without DEVICE_AUTH_SECRET, /proof answers 503 and leaves the device's status alone (GAU-97)", async () => {
  await withKey(undefined, async () => {
    const device = await register("fp-unconfigured");
    const before = await statusOf(device.id);
    // Signed with the key the old code fell back to, which is public.
    const forgedSecret = crypto
      .createHmac("sha256", "dev_device_secret_fallback")
      .update(`${device.userId}:${device.id}:${device.fingerprintHash}`)
      .digest("hex");
    const res = await fetch(`${base}/${device.id}/proof`, json(proofFor(forgedSecret)));
    assert.equal(res.status, 503);
    assert.equal(await statusOf(device.id), before);
  });
});

test("with DEVICE_AUTH_SECRET set, a genuine proof marks the device trusted and a bad one untrusted", async () => {
  await withKey(crypto.randomBytes(32).toString("hex"), async () => {
    const device = await register("fp-configured");

    const bad = await fetch(`${base}/${device.id}/proof`, json({ sig: crypto.randomBytes(32).toString("hex"), timestamp: new Date().toISOString() }));
    assert.equal(bad.status, 401);
    assert.equal(await statusOf(device.id), "untrusted");

    const malformed = await fetch(`${base}/${device.id}/proof`, json({ sig: "not-hex", timestamp: new Date().toISOString() }));
    assert.equal(malformed.status, 401, "a malformed signature is rejected, not a 500");

    const genuine = proofFor(deriveDeviceSecret(device.userId, device.id, device.fingerprintHash));
    const ok = await fetch(`${base}/${device.id}/proof`, json(genuine));
    assert.equal(ok.status, 200);
    assert.equal(await statusOf(device.id), "trusted");
  });
});
