import assert from "node:assert/strict";
import test from "node:test";
import type { AuthenticatedRequest } from "../auth.js";
import { argoAlarm, createSensor, watchAccess } from "./sensor.js";

function harness(start = 1_800_000_000_000) {
  let t = start;
  const alarms: Array<{ title: string; message: string; key: string }> = [];
  const logged: Array<{ severity: string; message: string }> = [];
  const sensor = createSensor({
    alarm: (title, message, key) => alarms.push({ title, message, key }),
    log: (e) => logged.push({ severity: e.severity, message: e.message }),
    now: () => t,
  });
  return { sensor, alarms, logged, advance: (ms: number) => void (t += ms), now: () => t };
}

test("the pattern sensor raises an alarm at the second wrong drawing in 15 minutes, a lockout, or probed phone codes", () => {
  const h = harness();
  h.sensor.record("pattern-miss", { userId: "u-op-123456789", ip: "100.64.0.9" });
  assert.equal(h.alarms.length, 0, "one slip is not an alarm");
  h.advance(16 * 60_000);
  h.sensor.record("pattern-miss", { userId: "u-op-123456789", ip: "100.64.0.9" });
  assert.equal(h.alarms.length, 0, "a second miss 16 minutes later is not either");
  h.sensor.record("pad-miss", { userId: "u-op-123456789", ip: "100.64.0.7" });
  assert.equal(h.alarms.length, 1);
  assert.match(h.alarms[0].message, /2 wrong drawings for operator u-op-123 in 15 minutes, last from 100\.64\.0\.7/);
  h.sensor.record("pattern-locked", { userId: "u-op-123456789", ip: "100.64.0.7" });
  assert.match(h.alarms.at(-1)!.title, /pattern locked/);
  for (let i = 0; i < 2; i++) h.sensor.record("pad-probe", { userId: null, ip: "100.64.0.66" });
  assert.equal(h.alarms.filter((a) => a.title.includes("probed")).length, 0);
  h.sensor.record("pad-probe", { userId: null, ip: "100.64.0.66" });
  assert.match(h.alarms.at(-1)!.message, /3 unknown phone codes tried from 100\.64\.0\.66/);
  assert.ok(h.logged.every((l) => !/\d+\.\d+\.\d+\.\d+\.\d+/.test(l.message)), "no pattern-like vertex lists in the log");
});

test("a duress drawing raises a critical alarm at once and never shows in the operator's own notice", () => {
  const h = harness();
  h.sensor.record("duress", { userId: "u-op-123456789", ip: "100.64.0.9", detail: "drawn at the computer" });
  assert.equal(h.alarms.length, 1);
  assert.match(h.alarms[0].title, /DURESS/);
  assert.equal(h.logged[0].severity, "critical");
  h.sensor.record("pattern-miss", { userId: "u-op-123456789", ip: "100.64.0.9" });
  const notice = h.sensor.noticeFor("u-op-123456789", 0);
  assert.deepEqual({ ...notice, lastAt: null }, { misses: 1, probes: 0, unusual: 0, lastIp: "100.64.0.9", lastAt: null });
  assert.deepEqual(h.sensor.noticeFor("u-op-123456789", h.now()), { misses: 0, probes: 0, unusual: 0, lastIp: null, lastAt: null });
});

test("an operator session that reads like bulk collection must draw the pattern again", async () => {
  const h = harness();
  const cleared: string[] = [];
  const watch = watchAccess({
    sensor: h.sensor,
    clearDrawing: async (auth) => void cleared.push(auth.token),
    ipOf: () => "100.64.0.9",
    ratePerMinute: 20,
    breadthPer5Min: 5,
    now: h.now,
  });
  const req = (path: string, role: "user" | "operator" = "operator", token = "s1") =>
    ({ method: "GET", path, auth: { userId: "u-op", email: null, role, rawRoles: [role], token, pattern: { set: true, verifiedAt: 1 } } }) as unknown as AuthenticatedRequest;
  const hit = (r: AuthenticatedRequest) => {
    let passed = false;
    watch(r, {} as never, () => (passed = true));
    assert.ok(passed, "the watch never blocks a request itself");
  };
  // The console's own rhythm: a few routes, polled.
  for (let i = 0; i < 15; i++) {
    hit(req(["/feed/space-weather/5s", "/swx/structures", "/rag/status"].at(i % 3)!));
    h.advance(4_000);
  }
  assert.deepEqual(cleared, []);
  // Viewers and the same burst from a viewer session are not watched.
  for (let i = 0; i < 40; i++) hit(req(`/feed/x${i}`, "user", "s2"));
  assert.deepEqual(cleared, []);
  // Too wide: six different routes in five minutes.
  for (const p of ["/a", "/b", "/c", "/d", "/e", "/f"]) hit(req(p));
  await Promise.resolve();
  assert.deepEqual(cleared, ["s1"]);
  assert.match(h.alarms.at(-1)!.message, /different routes in 5 minutes\. It must draw the pattern again/);
  // Flagged once per 10 minutes, then again after.
  for (let i = 0; i < 30; i++) hit(req(`/z${i}`));
  assert.equal(cleared.length, 1);
  h.advance(10 * 60_000 + 1);
  for (let i = 0; i < 25; i++) hit(req("/feed/space-weather/5s"));
  await Promise.resolve();
  assert.equal(cleared.length, 2, "too fast: 25 requests in a minute against a limit of 20");
});

test("pattern alarms go through Argo only when it is installed and not turned off", () => {
  assert.equal(argoAlarm({ PATTERN_ALERTS: "off" }), null);
  assert.equal(argoAlarm({ PATTERN_ALERTS: "log" }), null);
  assert.equal(argoAlarm({ ARGO_BIN: "/nonexistent/argo" }), null);
});
