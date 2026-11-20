import assert from "node:assert/strict";
import test from "node:test";
import type { AuthenticatedRequest, AuthRole } from "../auth.js";
import { createSensor } from "./sensor.js";
import { loginMapFrom, TAILNET_IDENTITY, tailnetIdentity } from "./tailnet.js";

function setup(options: { map?: Map<string, string[]>; enabled?: boolean } = {}) {
  const alarms: string[] = [];
  const sensor = createSensor({ alarm: (title) => void alarms.push(title), log: () => undefined });
  const owners: Record<string, string> = { "100.73.1.1": "josh@lightbound.uk", "100.73.2.2": "intruder@example.com" };
  const identity = tailnetIdentity({
    lookup: { whois: async (ip) => owners[ip] ?? null, self: async () => "josh@lightbound.uk" },
    sensor,
    ipOf: (req) => (req as unknown as { testIp: string }).testIp,
    loginMap: options.map ?? new Map(),
    enabled: () => options.enabled ?? true,
  });
  const call = async (method: string, path: string, ip: string, role: AuthRole = "operator", email = "josh@lightbound.uk") => {
    const req = { method, path, testIp: ip, auth: { userId: "u-josh", email, role, rawRoles: [role], token: "t" } } as unknown as AuthenticatedRequest;
    let status = 200;
    let body: unknown;
    let passed = false;
    await identity.middleware(req, { status: (s: number) => ((status = s), { json: (b: unknown) => void (body = b) }) } as never, () => void (passed = true));
    return { status: passed ? 200 : status, body };
  };
  return { call, alarms };
}

test("operator requests only count from the account owner's own device on the tailnet", async () => {
  const { call, alarms } = setup();
  assert.equal((await call("POST", "/rag/query", "100.73.1.1")).status, 200, "Josh's phone, on his tailnet login");
  assert.equal((await call("POST", "/rag/query", "127.0.0.1")).status, 200, "straight from this Mac: its owner");
  const stolen = await call("POST", "/rag/query", "100.73.2.2");
  assert.equal(stolen.status, 428, "a copied cookie on someone else's device");
  assert.equal((stolen.body as { code: string }).code, TAILNET_IDENTITY);
  assert.equal((await call("GET", "/swx/structures", "192.168.1.20")).status, 428, "not on the tailnet at all");
  assert.ok(alarms.some((a) => /wrong device/.test(a)));
  // Viewer routes and the pattern routes are never checked.
  assert.equal((await call("GET", "/feed/aurora/map", "100.73.2.2")).status, 200);
  assert.equal((await call("POST", "/operator-pattern/verify", "100.73.2.2")).status, 200);
});

test("TAILNET_LOGIN_MAP links an account to a different Tailscale login; TAILNET_IDENTITY=off turns the check off", async () => {
  const map = loginMapFrom({ TAILNET_LOGIN_MAP: "ops@lightbound.uk=intruder@example.com, x@y.z = a@b.c" });
  assert.deepEqual([...map.entries()], [["ops@lightbound.uk", ["intruder@example.com"]], ["x@y.z", ["a@b.c"]]]);
  const mapped = setup({ map });
  assert.equal((await mapped.call("POST", "/rag/query", "100.73.2.2", "operator", "ops@lightbound.uk")).status, 200);
  assert.equal((await mapped.call("POST", "/rag/query", "100.73.1.1", "operator", "ops@lightbound.uk")).status, 428);
  const off = setup({ enabled: false });
  assert.equal((await off.call("POST", "/rag/query", "100.73.2.2")).status, 200);
});
