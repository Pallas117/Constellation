import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { AuthContext, AuthRole } from "./auth.js";
import router from "./device-registry.js";
import type { DeviceRecord } from "./types.js";

type DeviceBody = { device: DeviceRecord };
type DeviceList = { devices: DeviceRecord[] };

// Each request picks its identity from the x-test-user / x-test-role headers.
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const userId = req.header("x-test-user");
  if (userId) {
    const role = (req.header("x-test-role") ?? "operator") as AuthRole;
    (req as express.Request & { auth?: AuthContext }).auth = { userId, email: null, role, rawRoles: [role], token: "test" };
  }
  next();
});
app.use("/api/device", router);

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/device`;

function call(path: string, user: string | null, options: { method?: string; body?: unknown; role?: AuthRole } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (user) headers["x-test-user"] = user;
  if (options.role) headers["x-test-role"] = options.role;
  return fetch(`${base}${path}`, {
    method: options.method ?? (options.body ? "POST" : "GET"),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

const telemetry = { temperatureC: 40, batteryPercent: 80, powerWatts: 10, computeLoadPercent: 20, networkLatencyMs: 30 };

test("devices can only be modified and listed by their owner or an admin", async (t) => {
  t.after(() => server.close());

  const aliceDevice = ((await (await call("/register", "alice", { body: { fingerprintHash: "fp-alice" } })).json()) as DeviceBody).device;
  const bobDevice = ((await (await call("/register", "bob", { body: { fingerprintHash: "fp-bob" } })).json()) as DeviceBody).device;

  await t.test("another user cannot heartbeat, set status or push telemetry", async () => {
    for (const [path, body] of [
      ["heartbeat", {}],
      ["status", { status: "untrusted" }],
      ["telemetry", telemetry],
    ] as const) {
      const res = await call(`/${aliceDevice.id}/${path}`, "bob", { body });
      assert.equal(res.status, 404, `bob should not reach alice's /${path}`);
    }
    const after = ((await (await call("/", "alice")).json()) as DeviceList).devices.find((d) => d.id === aliceDevice.id);
    assert.ok(after, "alice still sees her device");
    assert.equal(after.status, aliceDevice.status);
    assert.equal(after.telemetry, aliceDevice.telemetry);
  });

  await t.test("unauthenticated requests are rejected", async () => {
    assert.equal((await call(`/${aliceDevice.id}/heartbeat`, null, { body: {} })).status, 401);
    assert.equal((await call("/", null)).status, 401);
  });

  await t.test("the owner can heartbeat, set status and push telemetry", async () => {
    assert.equal((await call(`/${aliceDevice.id}/heartbeat`, "alice", { body: {} })).status, 200);
    assert.equal((await call(`/${aliceDevice.id}/status`, "alice", { body: { status: "trusted" } })).status, 200);
    const res = await call(`/${aliceDevice.id}/telemetry`, "alice", { body: telemetry });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as DeviceBody).device.telemetry?.temperatureC, 40);
  });

  await t.test("an admin can modify any device", async () => {
    assert.equal((await call(`/${bobDevice.id}/heartbeat`, "carol", { body: {}, role: "admin" })).status, 200);
  });

  await t.test("listing returns only the caller's devices unless admin", async () => {
    const ids = async (user: string, role?: AuthRole) =>
      ((await (await call("/", user, { role })).json()) as DeviceList).devices.map((d) => d.id);
    assert.deepEqual(await ids("alice"), [aliceDevice.id]);
    assert.deepEqual(await ids("bob"), [bobDevice.id]);
    assert.deepEqual(await ids("mallory"), []);
    const adminIds = await ids("carol", "admin");
    assert.ok(adminIds.includes(aliceDevice.id) && adminIds.includes(bobDevice.id));
  });
});
