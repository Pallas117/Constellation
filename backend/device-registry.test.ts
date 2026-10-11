import test from "node:test";
import assert from "node:assert";
import express from "express";
import router from "./device-registry.js";
import type { DeviceRecord } from "./types.js";

type DeviceBody = { ok: boolean; device: DeviceRecord };

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as any).auth = {
    userId: "test-user",
    email: "test@example.com",
    role: "operator",
    rawRoles: ["operator"],
    token: "test-token",
  };
  next();
});
app.use("/api/device", router);

const server = app.listen(0);
const port = (server.address() as any).port;
const base = `http://127.0.0.1:${port}`;

test("device registry can register a device and retrieve it", async (t) => {
  t.after(() => server.close());

  const registerResponse = await fetch(`${base}/api/device/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprintHash: "abc123", name: "test-device" }),
  });
  assert.strictEqual(registerResponse.status, 201);
  const body = (await registerResponse.json()) as DeviceBody;
  assert.strictEqual(body.ok, true);
  assert.strictEqual(typeof body.device?.id, "string");
  const deviceId = body.device.id;

  const getResponse = await fetch(`${base}/api/device/${deviceId}`);
  assert.strictEqual(getResponse.status, 200);
  const getBody = (await getResponse.json()) as DeviceBody;
  assert.strictEqual(getBody.ok, true);
  assert.strictEqual(getBody.device.id, deviceId);

  const telemetryResponse = await fetch(`${base}/api/device/${deviceId}/telemetry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      temperatureC: 48.2,
      batteryPercent: 92,
      powerWatts: 15.5,
      computeLoadPercent: 38,
      networkLatencyMs: 34,
      signalStrength: 88,
    }),
  });
  assert.strictEqual(telemetryResponse.status, 200);
  const telemetryBody = (await telemetryResponse.json()) as DeviceBody;
  assert.strictEqual(telemetryBody.ok, true);
  assert.strictEqual(telemetryBody.device.telemetry?.temperatureC, 48.2);

  const planResponse = await fetch(`${base}/api/device/swap/plan`);
  assert.strictEqual(planResponse.status, 200);
  const planBody = (await planResponse.json()) as { ok: boolean; plan: { assignments: unknown[] } };
  assert.strictEqual(planBody.ok, true);
  assert.strictEqual(Array.isArray(planBody.plan.assignments), true);

  const rebalanceResponse = await fetch(`${base}/api/device/swap/rebalance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requiredComputePercent: 60, requiredPowerWatts: 100 }),
  });
  assert.strictEqual(rebalanceResponse.status, 200);
  const rebalanceBody = (await rebalanceResponse.json()) as { ok: boolean; message: string };
  assert.strictEqual(rebalanceBody.ok, true);
  assert.strictEqual(typeof rebalanceBody.message, "string");
});
