import assert from "node:assert/strict";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import express from "express";
import type { AuthenticatedRequest } from "./auth.js";
import router from "./device-registry.js";
import { computeProof, deriveDeviceSecret } from "./services/device-auth.js";
import type { DeviceRecord } from "./types.js";

type DeviceBody = { ok: boolean; device: DeviceRecord };

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as AuthenticatedRequest).auth = {
    userId: "status-user",
    email: "status@example.com",
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

const post = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

async function register(fingerprintHash: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${base}/register`, post({ fingerprintHash, ...extra }));
}

async function registered(fingerprintHash: string): Promise<DeviceRecord> {
  const res = await register(fingerprintHash);
  assert.equal(res.status, 201);
  return ((await res.json()) as DeviceBody).device;
}

async function statusOf(id: string): Promise<DeviceRecord["status"]> {
  return ((await (await fetch(`${base}/${id}`)).json()) as DeviceBody).device.status;
}

test("REQ-SEC-017: a newly registered device is unverified, not trusted", async () => {
  const device = await registered("fp-new");
  assert.equal(device.status, "unverified");
  assert.equal(await statusOf(device.id), "unverified");
});

test("REQ-SEC-017: the owner cannot set a device to trusted through /status", async () => {
  const device = await registered("fp-owner");
  const res = await fetch(`${base}/${device.id}/status`, post({ status: "trusted" }));
  assert.equal(res.status, 400);
  assert.equal(await statusOf(device.id), "unverified");

  const down = await fetch(`${base}/${device.id}/status`, post({ status: "revoked" }));
  assert.equal(down.status, 200);
  assert.equal(await statusOf(device.id), "revoked");
});

test("REQ-SEC-017: /status rejects a status outside the allowed set with 400", async () => {
  const device = await registered("fp-bad-status");
  for (const status of ["admin", "", 7, null, { $ne: 1 }, "needs_reauth"]) {
    const res = await fetch(`${base}/${device.id}/status`, post({ status }));
    assert.equal(res.status, 400, `status ${JSON.stringify(status)} must be rejected`);
  }
  assert.equal(await statusOf(device.id), "unverified");
});

test("REQ-SEC-017: only a verified proof marks a device trusted", async () => {
  const saved = process.env.DEVICE_AUTH_SECRET;
  process.env.DEVICE_AUTH_SECRET = crypto.randomBytes(32).toString("hex");
  try {
    const device = await registered("fp-proof");
    assert.equal(await statusOf(device.id), "unverified");
    const proof = computeProof(deriveDeviceSecret(device.userId, device.id, device.fingerprintHash), "status-n1");
    const res = await fetch(`${base}/${device.id}/proof`, post(proof));
    assert.equal(res.status, 200);
    assert.equal(await statusOf(device.id), "trusted");
  } finally {
    if (saved === undefined) delete process.env.DEVICE_AUTH_SECRET;
    else process.env.DEVICE_AUTH_SECRET = saved;
  }
});

test("REQ-SEC-017: oversized or non-flat fingerprintSignals are rejected with 400", async () => {
  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i]));
  const longString = { ua: "x".repeat(257) };
  const nested = { screen: { w: 1 } };
  for (const signals of [tooMany, longString, nested, ["a"], "text", { [`${"k".repeat(65)}`]: 1 }]) {
    const res = await register("fp-signals", { fingerprintSignals: signals });
    assert.equal(res.status, 400, `register must reject ${JSON.stringify(signals).slice(0, 40)}`);
  }
  const device = await registered("fp-signals-ok");
  const res = await fetch(`${base}/${device.id}/status`, post({ fingerprintSignals: tooMany }));
  assert.equal(res.status, 400);

  const ok = await register("fp-signals-small", { fingerprintSignals: { ua: "x".repeat(256), dpr: 2 } });
  assert.equal(ok.status, 201);
});
