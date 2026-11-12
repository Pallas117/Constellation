import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { readFileSync } from "node:fs";
import express from "express";
import type { AuthenticatedRequest, AuthRole } from "../auth.js";
import { createMeshRouters, exitNodesFromEnv, onboardingSteps } from "./router.js";
import {
  GUARD_ADMISSIONS,
  GUARD_CODE_TEXT,
  GUARD_LEVELS,
  MESH_CLASSES,
  MeshStore,
  assessHosting,
  assessMemory,
  hostingVerdict,
  parseBattery,
  parsePower,
  parseGuard,
  parseHost,
  parseNet,
  parseReport,
  type MeshGuard,
  type MeshHost,
  type MeshReport,
} from "./store.js";

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

const goodHost: MeshHost = { ramGB: 32, pressure: "normal", swapUsedGB: 0, diskFreeGB: 400, cpus: 12, os: "darwin" };
const guard = (g: Partial<MeshGuard> = {}): MeshGuard => ({
  at: "2026-10-23T12:00:00Z",
  level: "ok",
  admission: "open",
  slots: 4,
  headroomGB: 9.5,
  reasons: [],
  warnMin: 0,
  swapRiseGB: 0,
  minToFloor: -1,
  ...g,
});

test("Argo's guard block is allowlisted; unknown codes drop alone, bad values drop the block", () => {
  const g = guard({ level: "risk", admission: "closed", slots: 0, reasons: ["swap-rising", "mem-warn-sustained"] });
  assert.deepEqual(parseGuard({ ...g, procs: ["chrome"] }), g);
  assert.deepEqual(parseGuard({ ...g, reasons: ["swap-rising", "<script>", 7, "rm -rf"] })!.reasons, ["swap-rising"]);
  for (const bad of [{ level: "fine" }, { admission: "yes" }, { slots: -1 }, { slots: 1.5 }, { headroomGB: "9" }, { warnMin: 61 }, { minToFloor: -2 }, { at: "soon" }]) {
    assert.equal(parseGuard({ ...g, ...bad }), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(parseBattery({ level: 64, charging: false, external: true }), { level: 64, charging: false, lowPower: false, external: true });
  const power = { mode: "negative", sourceW: 6.4, loadW: 9.2, marginW: -2.8 };
  assert.deepEqual(parseBattery({ level: 64, charging: true, external: true, power }), { level: 64, charging: true, lowPower: false, external: true, power });
  assert.deepEqual(parsePower({ mode: "eclipse", loadW: 7, marginW: -7 }), { mode: "eclipse", sourceW: 0, loadW: 7, marginW: -7 }, "Go omits a zero source");
  for (const bad of [{ mode: "sunny" }, { sourceW: -1 }, { loadW: "9" }, { marginW: 1e6 }, { marginW: undefined }]) {
    assert.equal(parsePower({ ...power, ...bad }), undefined, JSON.stringify(bad));
  }
  assert.equal(parseBattery({ level: 64, charging: true, power: { mode: "bad" } })!.power, undefined, "a bad power block drops alone");
});

test("hosting verdict uses report age, battery power, swap and Argo's guard, and says why", () => {
  const now = new Date("2026-10-23T12:05:00Z");
  const fresh = { receivedAt: "2026-10-23T12:00:00Z", now };
  assert.equal(hostingVerdict(goodHost, "macos", fresh), "agents");
  assert.deepEqual(assessHosting(goodHost, "macos", { ...fresh, now: new Date("2026-10-23T12:20:00Z") }), { verdict: "unknown", why: ["no report for 20 min"] });
  assert.equal(hostingVerdict({ ...goodHost, swapUsedGB: 4.5 }, "macos", fresh), "no");

  const battery = (level: number, external?: boolean) => ({ level, charging: false, lowPower: false, ...(external === undefined ? {} : { external }) });
  assert.deepEqual(assessHosting(goodHost, "macos", { ...fresh, battery: battery(60, false) }), { verdict: "light", why: ["on battery power: light work only"] });
  assert.equal(hostingVerdict(goodHost, "macos", { ...fresh, battery: battery(18, false) }), "no");
  assert.equal(hostingVerdict(goodHost, "macos", { ...fresh, battery: battery(80, true) }), "agents", "plugged in, held at 80%, is not on battery");
  assert.equal(hostingVerdict(goodHost, "macos", { ...fresh, battery: battery(18) }), "no", "phones' charging=false means on battery");

  // SWaP power budget from Argo (tools/argo/power.go): a deficit or a thin margin means light work only.
  const powered = (power: Record<string, unknown>) => parseBattery({ level: 90, charging: true, external: true, power })!;
  assert.equal(hostingVerdict(goodHost, "macos", { ...fresh, battery: powered({ mode: "positive", sourceW: 76.8, loadW: 12, marginW: 64.8 }) }), "agents");
  assert.deepEqual(assessHosting(goodHost, "macos", { ...fresh, battery: powered({ mode: "negative", sourceW: 6.4, loadW: 9.2, marginW: -2.8 }) }), {
    verdict: "light",
    why: ["the charger can't carry the load: drawing 9.2 W from 6.4 W"],
  });
  assert.deepEqual(assessHosting(goodHost, "macos", { ...fresh, battery: powered({ mode: "positive", sourceW: 16, loadW: 12.5, marginW: 3.5 }) }).why, ["only 3.5 W of power margin"]);

  const closed = assessHosting(goodHost, "macos", { ...fresh, guard: guard({ level: "risk", admission: "closed", slots: 0, reasons: ["mem-warn-sustained", "swap-rising"] }) });
  assert.equal(closed.verdict, "no");
  assert.deepEqual(closed.why, ["Argo guard closed to new work: memory at warn for 30+ of the last 60 min, swap climbing at warn"]);
  assert.equal(hostingVerdict(goodHost, "macos", { ...fresh, guard: guard({ level: "watch", admission: "limited", slots: 1, reasons: ["on-battery"] }) }), "light");
  assert.equal(hostingVerdict(goodHost, "macos", { ...fresh, guard: guard({ slots: 0 }) }), "light", "a new host cools down first");
  assert.equal(hostingVerdict(goodHost, "macos", { ...fresh, guard: guard({ admission: "full", slots: 0, headroomGB: 0, reasons: ["no-headroom"] }) }), "no");
  assert.equal(hostingVerdict(goodHost, "macos", { ...fresh, guard: guard() }), "agents");
  assert.equal(hostingVerdict(goodHost, "macos", { ...fresh, guard: guard({ admission: "closed", at: "2026-10-22T12:00:00Z" }) }), "agents", "a day-old guard is ignored");

  const small = assessHosting({ ...goodHost, ramGB: 4 }, "linux", fresh);
  assert.deepEqual(small, { verdict: "no", why: ["needs 8 GB RAM and 10 GB free disk (has 4 GB, 400 GB free)"] });
});

test("an Argo report with guard and battery reaches the device list with its reasons", async () => {
  await withApp(async (base, store) => {
    const { token } = (await (await fetch(`${base}/devices`, json({ name: "judith" }, { "x-test-role": "staff" }))).json()) as { token: string };
    const report = {
      ...okReport,
      checkedAt: new Date().toISOString(),
      host: goodHost,
      platform: "macos",
      battery: { level: 72, charging: true, external: true, lowPower: false },
      guard: guard({ at: new Date().toISOString(), level: "watch", admission: "limited", slots: 1, reasons: ["charger-weak"] }),
    };
    assert.equal((await fetch(`${base}/report`, json(report, { authorization: `Bearer ${token}` }))).status, 200);
    const d = store.list()[0];
    assert.equal(d.last!.guard!.admission, "limited");
    assert.equal(d.last!.battery!.external, true);
    assert.equal(d.hosting, "light");
    assert.deepEqual(d.hostingWhy, ["Argo guard: light work only: charger weaker than the draw"]);
  });
});

test("Gauss knows every guard code, level and admission Argo can send", () => {
  const go = readFileSync(new URL("../../tools/argo/guard.go", import.meta.url), "utf8");
  const codes = [...go.matchAll(/a\.add\("\w+", "([a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(codes.length >= 18 && codes.includes("swap-rising"), `parsed ${codes.join(",")}`);
  for (const c of codes) assert.ok(Object.hasOwn(GUARD_CODE_TEXT, c), `Gauss drops Argo guard code ${c}`);
  const levels = go.match(/\[\.\.\.\]string\{"ok", "watch", "risk", "block"\}/);
  assert.ok(levels, "guard.go level names changed");
  assert.deepEqual([...GUARD_LEVELS], ["ok", "watch", "risk", "block"]);
  for (const a of GUARD_ADMISSIONS) assert.ok(go.includes(`next.Admission = "${a}"`), `Argo never sends admission ${a}`);
});

test("a refused report is remembered (at most once a minute) so the page can say why a device looks silent", async () => {
  await withApp(async (base, store) => {
    const { token } = (await (await fetch(`${base}/devices`, json({ name: "talos" }, { "x-test-role": "staff" }))).json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };
    assert.equal((await fetch(`${base}/report`, json({ ...okReport, class: "NEW_CLASS" }, auth))).status, 400);
    const first = store.list()[0].rejectedAt;
    assert.ok(first && !store.list()[0].last, "rejection recorded, nothing else stored");
    assert.equal((await fetch(`${base}/report`, json({ ...okReport, class: "NEW_CLASS" }, auth))).status, 400);
    assert.equal(store.list()[0].rejectedAt, first, "no second write within the minute");
    assert.equal((await fetch(`${base}/report`, json(okReport, auth))).status, 200);
    assert.equal(store.list()[0].rejectedAt, undefined, "an accepted report clears it");
  });
});

test("onboarding points new devices at argo guard", () => {
  const steps = onboardingSteps([]);
  assert.ok(steps.find((s) => s.id === "guard")?.command === "argo guard");
  assert.match(steps.find((s) => s.id === "enroll")!.detail, /first report/);
});

// Fleet memory watch (GAU-240): the hub's view of each device's memory, from what Argo already reports.
const MEM_NOW = new Date("2026-11-11T04:00:00Z");
const memHost = (pressure: MeshHost["pressure"]): MeshHost => ({ ramGB: 8, pressure, swapUsedGB: 1, diskFreeGB: 20, cpus: 8, os: "macos" });
const memReport = (over: Partial<MeshReport> = {}): MeshReport => ({ ...parseReport(okReport)!, receivedAt: MEM_NOW.toISOString(), ...over });
const memGuard = (g: Partial<MeshGuard> = {}) => guard({ at: MEM_NOW.toISOString(), ...g });

test("memory state: critical and risk come only from fresh guard codes or kernel pressure (GAU-240)", () => {
  const state = (over: Partial<MeshReport>) => assessMemory(memReport(over), MEM_NOW);
  assert.deepEqual(state({ host: memHost("normal"), guard: memGuard() }), { state: "ok", why: [] });
  assert.deepEqual(state({ guard: memGuard({ level: "block", reasons: ["mem-critical", "battery-low"] }) }), { state: "critical", why: ["memory pressure critical"] });
  assert.deepEqual(state({ guard: memGuard({ level: "risk", reasons: ["mem-paging"] }) }), { state: "critical", why: ["swapping out fast: memory short"] });
  assert.deepEqual(state({ host: memHost("critical") }), { state: "critical", why: ["memory pressure critical"] }, "kernel pressure alone, older Argo");
  assert.deepEqual(state({ guard: memGuard({ level: "risk", reasons: ["swap-rising", "mem-warn-sustained"] }) }), {
    state: "risk",
    why: ["swap climbing at warn", "memory at warn for 30+ of the last 60 min"],
  });
  assert.equal(state({ guard: memGuard({ level: "watch", reasons: ["no-headroom"] }) }).state, "watch", "a full machine is not a failing one");
  assert.equal(state({ guard: memGuard({ level: "risk", reasons: ["no-headroom"] }) }).state, "risk");
  assert.deepEqual(state({ host: memHost("warn"), guard: memGuard({ level: "watch", reasons: ["mem-warn-coping"] }) }), { state: "watch", why: ["memory at warn but coping"] });
  assert.deepEqual(state({ host: memHost("warn") }), { state: "watch", why: ["memory pressure at warn"] });
  assert.equal(state({ guard: memGuard({ level: "risk", reasons: ["battery-low", "disk-low"] }) }).state, "ok", "battery and disk findings are not memory");
});

test("memory state: what the hub cannot know is unknown, never ok (GAU-240)", () => {
  assert.deepEqual(assessMemory(undefined, MEM_NOW), { state: "unknown", why: ["no report yet"] });
  assert.deepEqual(assessMemory(memReport({ platform: "ios", guard: memGuard({ reasons: ["mem-critical"] }) }), MEM_NOW).state, "unknown");
  assert.deepEqual(assessMemory(memReport(), MEM_NOW), { state: "unknown", why: ["no memory reading in the report"] });
  const old = memReport({ receivedAt: "2026-11-11T03:40:00Z", guard: memGuard({ at: "2026-11-11T03:40:00Z", reasons: ["mem-critical"] }) });
  assert.deepEqual(assessMemory(old, MEM_NOW), { state: "unknown", why: ["no report for 20 min"] }, "a stale critical says nothing about now");
  // A guard reading much older than the report it rides on is ignored; kernel pressure still counts.
  const lag = memReport({ host: memHost("warn"), guard: memGuard({ at: "2026-11-11T03:00:00Z", reasons: ["mem-critical"] }) });
  assert.equal(assessMemory(lag, MEM_NOW).state, "watch");
  assert.equal(assessMemory(memReport({ receivedAt: "not a time", host: memHost("normal") }), MEM_NOW).state, "unknown");
});

test("fleet memory: the device list, the worsening signal and the watcher's file agree (GAU-240)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-mem-"));
  const store = new MeshStore(path.join(dir, "devices.json"));
  const mac = store.byToken((store.enroll("judith", "u") as { token: string }).token)!;
  const box = store.byToken((store.enroll("devbox", "u") as { token: string }).token)!;
  store.enroll("never", "u");

  assert.equal(store.record(mac, memReport({ host: memHost("normal"), guard: memGuard() }), MEM_NOW), undefined, "ok is not a signal");
  const risk = memReport({ guard: memGuard({ level: "risk", reasons: ["swap-rising"] }) });
  assert.deepEqual(store.record(box, risk, MEM_NOW), { state: "risk", why: ["swap climbing at warn"] });
  assert.equal(store.record(box, risk, MEM_NOW), undefined, "the same state again is not signalled twice");
  const critical = memReport({ guard: memGuard({ level: "block", reasons: ["mem-critical"] }) });
  assert.equal(store.record(box, critical, MEM_NOW)?.state, "critical", "worse again is signalled");
  assert.equal(store.record(box, risk, MEM_NOW), undefined, "getting better is not signalled");

  store.record(box, critical, MEM_NOW);
  assert.deepEqual(store.fleetMemory(MEM_NOW).map((d) => `${d.name}:${d.state}`), ["devbox:critical", "judith:ok", "never:unknown"]);
  const listed = store.list(MEM_NOW).find((d) => d.name === "devbox")!;
  assert.equal(listed.memory, "critical");
  assert.deepEqual(listed.memoryWhy, ["memory pressure critical"]);

  const file = path.join(dir, "fleet-memory.json");
  const written = JSON.parse(fs.readFileSync(file, "utf8")) as { at: string; staleAfterMs: number; devices: Array<Record<string, unknown>> };
  assert.equal(written.at, MEM_NOW.toISOString());
  assert.equal(written.staleAfterMs, 15 * 60_000);
  assert.deepEqual(written.devices[0], { name: "devbox", state: "critical", why: ["memory pressure critical"], reportedAt: MEM_NOW.toISOString() });
  assert.deepEqual(Object.keys(written.devices[0]).sort(), ["name", "reportedAt", "state", "why"], "states and reasons only: no token hash, no network details");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, "utf8").includes("tokenHash"), false);
});
