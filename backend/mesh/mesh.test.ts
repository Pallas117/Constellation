import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { AuthenticatedRequest, AuthRole } from "../auth.js";
import { createMeshRouters, exitNodesFromEnv, onboardingSteps } from "./router.js";
import { MeshStore, parseReport } from "./store.js";

async function withApp(fn: (base: string, store: MeshStore) => Promise<void>) {
  const store = new MeshStore(null);
  const mesh = createMeshRouters(store);
  const app = express();
  app.use(express.json());
  app.use("/api/mesh", mesh.agent);
  // Stand-in for authenticateRequest: role comes from a test header.
  app.use("/api", (req: AuthenticatedRequest, _res, next) => {
    const role = req.header("x-test-role") as AuthRole | undefined;
    if (role) req.auth = { userId: `u-${role}`, email: null, role, rawRoles: [role], token: "t" };
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
    assert.equal((await fetch(`${base}/devices`, { headers: { "x-test-role": "viewer" } })).status, 403);
    await fetch(`${base}/devices`, json({ name: "judith" }, { "x-test-role": "admin" }));
    const res = await fetch(`${base}/devices`, { headers: { "x-test-role": "operator" } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { devices: { name: string }[] };
    assert.equal(body.devices[0].name, "judith");
    assert.equal(JSON.stringify(body).includes("tokenHash"), false);
  });
});

test("only admins can enroll devices", async () => {
  await withApp(async (base) => {
    assert.equal((await fetch(`${base}/devices`, json({ name: "x" }, { "x-test-role": "operator" }))).status, 403);
    assert.equal((await fetch(`${base}/devices`, json({ name: "../etc" }, { "x-test-role": "admin" }))).status, 400);
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

type Onboarding = { canSeeTeam: boolean; steps: unknown[] };

test("onboarding tells the page whether to fetch team status, so viewers never hit a 403", async () => {
  await withApp(async (base) => {
    const viewer = (await (await fetch(`${base}/onboarding`, { headers: { "x-test-role": "viewer" } })).json()) as Onboarding;
    const operator = (await (await fetch(`${base}/onboarding`, { headers: { "x-test-role": "operator" } })).json()) as Onboarding;
    assert.equal(viewer.canSeeTeam, false);
    assert.equal(operator.canSeeTeam, true);
    assert.ok(viewer.steps.length > 0);
  });
});
