import assert from "node:assert/strict";
import test from "node:test";
import { batteryLabel, copyText, deviceStage, enrollCommand, guardLine, isTailnetHost, stopsPolling } from "./mesh-onboarding";

test("the mesh page stops polling on 401 and 403, never on other failures", () => {
  assert.equal(stopsPolling(401), true);
  assert.equal(stopsPolling(403), true);
  for (const s of [200, 404, 429, 500, 502]) assert.equal(stopsPolling(s), false, String(s));
});

test("tailnet hosts are the ones Argo accepts", () => {
  for (const h of ["judith.tail1234.ts.net", "100.64.0.1", "100.127.255.254", "100.107.156.105", "[fd7a:115c:a1e0::1]"]) assert.ok(isTailnetHost(h), h);
  for (const h of ["127.0.0.1", "localhost", "100.63.0.1", "100.128.0.1", "lightbound.uk", "ts.net.evil.com"]) assert.ok(!isTailnetHost(h), h);
});

test("the enroll command uses this page's origin only when it is a tailnet address", () => {
  assert.deepEqual(enrollCommand({ protocol: "http:", host: "judith.tail1234.ts.net", hostname: "judith.tail1234.ts.net" }, "talos"), {
    command: "argo enroll http://judith.tail1234.ts.net talos",
    exact: true,
  });
  assert.deepEqual(enrollCommand({ protocol: "http:", host: "100.107.156.105:8080", hostname: "100.107.156.105" }, "talos").command, "argo enroll http://100.107.156.105:8080 talos");
  const local = enrollCommand({ protocol: "http:", host: "127.0.0.1:8080", hostname: "127.0.0.1" }, "talos");
  assert.equal(local.exact, false, "another device can't reach this Mac's loopback");
  assert.match(local.command, /<this-gauss-tailnet-name> talos$/);
});

test("a new device moves from waiting to silent; refused and stale reports say so", () => {
  const enrolledAt = "2026-10-23T12:00:00Z";
  const at = (m: number) => Date.parse(enrolledAt) + m * 60_000;
  assert.equal(deviceStage({ enrolledAt }, at(2)), "waiting");
  assert.equal(deviceStage({ enrolledAt }, at(11)), "silent");
  assert.equal(deviceStage({ enrolledAt, rejectedAt: "2026-10-23T12:01:00Z" }, at(2)), "rejected");
  const last = { receivedAt: "2026-10-23T12:03:00Z" };
  assert.equal(deviceStage({ enrolledAt, last }, at(5)), "reporting");
  assert.equal(deviceStage({ enrolledAt, last, rejectedAt: "2026-10-23T12:01:00Z" }, at(5)), "reporting", "an older refusal no longer matters");
  assert.equal(deviceStage({ enrolledAt, last }, at(20)), "stale");
});

test("battery and guard lines read plainly", () => {
  assert.equal(batteryLabel({ level: 72, charging: false, lowPower: false, external: true }), "72% · plugged in");
  assert.equal(batteryLabel({ level: 48, charging: false, lowPower: true, external: false }), "48% · on battery · low power");
  assert.equal(batteryLabel({ level: 90, charging: true, lowPower: false }), "90% charging", "phones say only whether they charge");
  assert.equal(guardLine({ admission: "limited", slots: 1, headroomGB: 2.4 }), "Argo guard: light work only · 1 agent slot · 2.4 GB free");
  assert.equal(guardLine({ admission: "closed", slots: 0, headroomGB: 0 }), "Argo guard: closed to new work · 0 agent slots · 0 GB free");
});

test("copying falls back to manual when the page has no clipboard", async () => {
  assert.equal(await copyText("argo_x", undefined), "manual");
  assert.equal(await copyText("argo_x", { writeText: () => Promise.reject(new Error("NotAllowedError")) }), "manual");
  let copied = "";
  assert.equal(await copyText("argo_x", { writeText: async (t: string) => void (copied = t) }), "copied");
  assert.equal(copied, "argo_x");
});
