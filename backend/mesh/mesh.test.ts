import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { readFileSync } from "node:fs";
import express from "express";
import type { AuthenticatedRequest, AuthRole } from "../auth.js";
import { createMeshRouters, exitNodesFromEnv, onboardingSteps } from "./router.js";
import { MESH_CLASSES, MeshStore, hostingVerdict, parseBattery, parseHost, parseNet, parseReport, type MeshHost } from "./store.js";

async function withApp(fn: (base: string, store: MeshStore) => Promise<void>) {
  const store = new MeshStore(null);
  const mesh = createMeshRouters(store);
  const app = express();
  app.use(express.json());
  app.use("/api/mesh", mesh.agent);
  // Stand-in for authenticateRequest: role comes from a test header.
  app.use("/api", (req: AuthenticatedRequest, _res, next) => {
    const role = req.header("x-test-role") as AuthRole | undefined;
    const userId = req.header("x-test-user") ?? `u-${role}`;
    if (role) req.auth = { userId, email: null, role, rawRoles: [role], token: "t" };
    next();
  });
  app.use("/api/mesh", mesh.ui);
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mesh`, store);
  } finally {
    server.close();
  }
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const okReport = { class: "REGION", reason: "api.anthropic.com returned 403 (exit loc=HK)", loc: "hk", network: "a1b2c3d4e5f6", tailscale: true, argoVersion: "0.1.0", checkedAt: "2026-10-09T08:00:00Z" };

test("team device status is operator-only and never exposes token hashes", async () => {
  await withApp(async (base) => {
    assert.equal((await fetch(`${base}/devices`, { headers: { "x-test-role": "user" } })).status, 403);
    await fetch(`${base}/devices`, json({ name: "judith" }, { "x-test-role": "admin" }));
    const res = await fetch(`${base}/devices`, { headers: { "x-test-role": "operator" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { devices: { name: string }[] };
    assert.equal(body.devices[0].name, "judith");
    assert.equal(JSON.stringify(body).includes("tokenHash"), false);
  });
});

test("staff and above enroll devices; plain users cannot", async () => {
  await withApp(async (base) => {
    assert.equal((await fetch(`${base}/devices`, json({ name: "x" }, { "x-test-role": "user" }))).status, 403);
    assert.equal((await fetch(`${base}/devices`, json({ name: "staff-mac" }, { "x-test-role": "staff" }))).status, 201);
    assert.equal((await fetch(`${base}/devices`, json({ name: "../etc" }, { "x-test-role": "admin" }))).status, 400);
  });
});

test("staff see and revoke only their own devices; operators see all; admins revoke any", async () => {
  await withApp(async (base) => {
    const as = (user: string, role: string) => ({ "x-test-role": role, "x-test-user": user });
    await fetch(`${base}/devices`, json({ name: "alice-mac" }, as("alice", "staff")));
    await fetch(`${base}/devices`, json({ name: "bob-mac" }, as("bob", "staff")));

    const alice = (await (await fetch(`${base}/devices`, { headers: as("alice", "staff") })).json()) as { devices: { name: string }[] };
    assert.deepEqual(alice.devices.map((d) => d.name), ["alice-mac"]);
    const ops = (await (await fetch(`${base}/devices`, { headers: as("olga", "operator") })).json()) as { devices: { name: string }[] };
    assert.equal(ops.devices.length, 2);

    assert.equal((await fetch(`${base}/devices/bob-mac`, { method: "DELETE", headers: as("alice", "staff") })).status, 404);
    assert.equal((await fetch(`${base}/devices/alice-mac`, { method: "DELETE", headers: as("alice", "staff") })).status, 204);
    assert.equal((await fetch(`${base}/devices/bob-mac`, { method: "DELETE", headers: as("olga", "operator") })).status, 404);
    assert.equal((await fetch(`${base}/devices/bob-mac`, { method: "DELETE", headers: as("root", "admin") })).status, 204);
  });
});

test("agents report with their device token; bad tokens, bad payloads and floods are refused", async () => {
  await withApp(async (base, store) => {
    const enrolled = (await (await fetch(`${base}/devices`, json({ name: "judith" }, { "x-test-role": "admin" }))).json()) as { token: string };
    assert.match(enrolled.token, /^argo_/);
    const auth = { authorization: `Bearer ${enrolled.token}` };

    assert.equal((await fetch(`${base}/report`, json(okReport, { authorization: "Bearer nope" }))).status, 401);
    assert.equal((await fetch(`${base}/report`, json({ ...okReport, class: "PWNED" }, auth))).status, 400);
    assert.equal((await fetch(`${base}/report`, json({ ...okReport, publicIp: "180.188.170.58", env: { KEY: "x" } }, auth))).status, 200);
    assert.equal((await fetch(`${base}/report`, json(okReport, auth))).status, 429);

    const last = store.list()[0].last!;
    assert.equal(last.class, "REGION");
    assert.equal(last.loc, "HK");
    assert.equal(JSON.stringify(last).includes("180.188"), false, "unknown fields must be dropped");
  });
});

const judithHost: MeshHost = { ramGB: 8, pressure: "warn", swapUsedGB: 2.9, diskFreeGB: 22, cpus: 8, os: "darwin" };

test("host capacity is allowlisted and range-checked; junk drops the whole block", () => {
  assert.deepEqual(parseHost(judithHost), judithHost);
  assert.deepEqual(parseHost({ ...judithHost, ramGB: 8.04, procs: ["claude"], path: "/Users/josh" }), { ...judithHost, ramGB: 8 });
  for (const bad of [{ ...judithHost, ramGB: -1 }, { ...judithHost, ramGB: 1e9 }, { ...judithHost, cpus: 2.5 }, { ...judithHost, pressure: "fine" }, { ...judithHost, diskFreeGB: "22" }, "x", null]) {
    assert.equal(parseHost(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(parseHost({ ...judithHost, os: "<b>" })!.os, "");
  assert.equal(parseReport(okReport)!.host, undefined, "old Argo without host still parses");
  assert.deepEqual(parseReport({ ...okReport, host: judithHost })!.host, judithHost);
});

test("hosting verdict: agents only with headroom; pressure always means no", () => {
  assert.equal(hostingVerdict(undefined), "unknown");
  assert.equal(hostingVerdict({ ...judithHost, pressure: "" }), "unknown");
  assert.equal(hostingVerdict(judithHost), "no"); // 8 GB under warn: the dev Mac today
  assert.equal(hostingVerdict({ ...judithHost, pressure: "normal" }), "light");
  assert.equal(hostingVerdict({ ...judithHost, pressure: "normal", ramGB: 32, diskFreeGB: 200 }), "agents");
  assert.equal(hostingVerdict({ ...judithHost, pressure: "normal", ramGB: 32, diskFreeGB: 5 }), "no");
  assert.equal(hostingVerdict({ ...judithHost, pressure: "critical", ramGB: 64, diskFreeGB: 500 }), "no");
});

test("a report with host capacity shows the verdict on the device list", async () => {
  await withApp(async (base, store) => {
    const { token } = (await (await fetch(`${base}/devices`, json({ name: "talos" }, { "x-test-role": "admin" }))).json()) as { token: string };
    const host = { ramGB: 32, pressure: "normal", swapUsedGB: 0, diskFreeGB: 400, cpus: 12, os: "linux" };
    assert.equal((await fetch(`${base}/report`, json({ ...okReport, host }, { authorization: `Bearer ${token}` }))).status, 200);
    const d = store.list()[0];
    assert.deepEqual(d.last!.host, host);
    assert.equal(d.hosting, "agents");
    const listed = (await (await fetch(`${base}/devices`, { headers: { "x-test-role": "operator" } })).json()) as { devices: { hosting: string }[] };
    assert.equal(listed.devices[0].hosting, "agents");
  });
});

test("battery is range-checked; Shortcuts fractions become percent", () => {
  assert.deepEqual(parseBattery({ level: 83, charging: false }), { level: 83, charging: false, lowPower: false });
  assert.deepEqual(parseBattery({ level: 0.83, charging: true, lowPower: true }), { level: 83, charging: true, lowPower: true });
  assert.deepEqual(parseBattery({ level: 1, charging: false })!.level, 1, "integer 1 is 1%, not 100%");
  for (const bad of [{ level: 101, charging: false }, { level: -5, charging: false }, { level: "83", charging: false }, { level: 50 }, { level: 50, charging: "yes" }, null, 7]) {
    assert.equal(parseBattery(bad), undefined, JSON.stringify(bad));
  }
});

test("network scores are allowlisted; nothing unmeasured is invented", () => {
  const net = {
    privacy: 70,
    privacyWhy: ["Remote Login (SSH) reachable on this network -10", "<script>alert(1)</script>"],
    rttMs: 29,
    speed: "excellent",
    signal: "fair",
    rssi: -70,
    noise: -92,
    ssid: "HomeNet",
  };
  assert.deepEqual(parseReport({ ...okReport, net })!.net, {
    privacy: 70,
    privacyWhy: ["Remote Login (SSH) reachable on this network -10"],
    rttMs: 29,
    speed: "excellent",
    signal: "fair",
    rssi: -70,
    noise: -92,
  });
  const wired = parseNet({ privacy: 100, privacyWhy: [], rttMs: -1, speed: "not measured", signal: "n/a", rssi: -50, noise: -90 });
  assert.equal(wired!.rssi, undefined, "no signal numbers for a link Argo didn't grade");
  for (const bad of [{ ...net, privacy: 101 }, { ...net, privacy: 50.5 }, { ...net, speed: "blazing" }, { ...net, signal: undefined }, { ...net, rttMs: "29" }, null]) {
    assert.equal(parseNet(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(parseReport(okReport)!.net, undefined, "older Argo: no block");
});

test("platform is allowlisted and phones never host", () => {
  assert.equal(parseReport({ ...okReport, platform: "ios" })!.platform, "ios");
  assert.equal(parseReport({ ...okReport, platform: "playstation" })!.platform, undefined);
  assert.equal(hostingVerdict(undefined, "ios"), "no");
  assert.equal(hostingVerdict({ ...judithHost, pressure: "normal", ramGB: 64, diskFreeGB: 500 }, "android"), "no");
  assert.equal(hostingVerdict({ ...judithHost, pressure: "normal", ramGB: 32, diskFreeGB: 200 }, "linux"), "agents");
});

test("a phone Shortcut report (class + platform + battery) is accepted and listed", async () => {
  await withApp(async (base, store) => {
    const { token } = (await (await fetch(`${base}/devices`, json({ name: "iphone-13" }, { "x-test-role": "admin" }))).json()) as { token: string };
    const phone = { class: "OK", platform: "ios", battery: { level: 0.41, charging: false, lowPower: true }, reason: "iOS Shortcut", checkedAt: "2026-10-21T09:00:00+08:00" };
    assert.equal((await fetch(`${base}/report`, json(phone, { authorization: `Bearer ${token}` }))).status, 200);
    const d = store.list()[0];
    assert.equal(d.last!.platform, "ios");
    assert.deepEqual(d.last!.battery, { level: 41, charging: false, lowPower: true });
    assert.equal(d.last!.host, undefined);
    assert.equal(d.hosting, "no");
  });
});

test("revoked devices can no longer report", async () => {
  await withApp(async (base) => {
    const { token } = (await (await fetch(`${base}/devices`, json({ name: "old-laptop" }, { "x-test-role": "admin" }))).json()) as { token: string };
    assert.equal((await fetch(`${base}/devices/old-laptop`, { method: "DELETE", headers: { "x-test-role": "admin" } })).status, 204);
    assert.equal((await fetch(`${base}/report`, json(okReport, { authorization: `Bearer ${token}` }))).status, 401);
  });
});

test("parseReport sanitises fields", () => {
  const r = parseReport({ ...okReport, loc: "<script>", exitNode: "rm -rf /", reason: "x".repeat(5000) })!;
  assert.equal(r.loc, "");
  assert.equal(r.exitNode, "");
  assert.equal(r.reason.length, 200);
  assert.equal(parseReport(null), null);
});

test("only MY/SG exit nodes are ever offered", () => {
  assert.deepEqual(exitNodesFromEnv("exit-sg-1:SG, exit-hk-1:HK,exit-my-1:my,broken"), [
    { name: "exit-sg-1", country: "SG" },
    { name: "exit-my-1", country: "MY" },
  ]);
  const exitStep = onboardingSteps([]).find((s) => s.id === "exit-node")!;
  assert.equal(exitStep.pending, true);
});

test("devices enrolled by another process (npm run mesh:enroll) are picked up and not overwritten", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-")), "devices.json");
  const server = new MeshStore(file);
  server.enroll("existing", "u");
  await new Promise((r) => setTimeout(r, 20)); // distinct mtime
  const cli = new MeshStore(file);
  const enrolled = cli.enroll("judith", "local-cli");
  assert.ok("token" in enrolled);
  assert.equal(server.byToken(enrolled.token)?.name, "judith");
  server.record(server.byToken(enrolled.token)!, parseReport(okReport)!);
  assert.deepEqual(new MeshStore(file).list().map((d) => d.name), ["existing", "judith"]);
});

type Onboarding = { canEnroll: boolean; canSeeTeam: boolean; steps: unknown[] };

test("onboarding is for staff and above, and tells the page whether team status is visible", async () => {
  await withApp(async (base) => {
    assert.equal((await fetch(`${base}/onboarding`, { headers: { "x-test-role": "user" } })).status, 403);
    const staff = (await (await fetch(`${base}/onboarding`, { headers: { "x-test-role": "staff" } })).json()) as Onboarding;
    const operator = (await (await fetch(`${base}/onboarding`, { headers: { "x-test-role": "operator" } })).json()) as Onboarding;
    assert.equal(staff.canEnroll, true);
    assert.equal(staff.canSeeTeam, false);
    assert.equal(operator.canSeeTeam, true);
    assert.ok(staff.steps.length > 0);
  });
});

// Argo is Go, Gauss is TypeScript: a class Argo can report that Gauss doesn't accept makes every
// report a 400, silently. On 2026-10-19 Argo gained WIFI_RISK and stopped reporting for hours.
test("Gauss accepts every class Argo can report", () => {
  const go = readFileSync(new URL("../../tools/argo/classify.go", import.meta.url), "utf8");
  const argoClasses = [...go.matchAll(/^\s*\w+\s+Class\s*=\s*"([A-Z_]+)"/gm)].map((m) => m[1]);
  assert.ok(argoClasses.includes("OK") && argoClasses.includes("WIFI_RISK"), `parsed ${argoClasses.join(",")}`);
  for (const c of argoClasses) assert.ok((MESH_CLASSES as readonly string[]).includes(c), `Gauss rejects Argo class ${c}`);
});
