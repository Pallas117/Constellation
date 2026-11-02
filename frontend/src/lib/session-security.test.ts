import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_IDLE_MINUTES, IDLE_WARNING_MS, idleLimitMs, idlePhase, latestActivity } from "./idle";
import { passkeySupport, type PasskeyEnvironment } from "./passkey-support";
import { fetchWithStepUp, StepUpCancelled } from "./step-up";

const page = (url: string, extra: Partial<PasskeyEnvironment> = {}): PasskeyEnvironment => {
  const u = new URL(url);
  return {
    rpId: "localhost",
    location: { hostname: u.hostname, protocol: u.protocol, port: u.port, pathname: u.pathname, search: u.search },
    secure: u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1",
    webauthn: true,
    ...extra,
  };
};

test("passkey sign-in is offered only where the browser can complete it", () => {
  assert.deepEqual(passkeySupport(page("http://localhost:8080/login")), { ok: true });
  const ip = passkeySupport(page("http://127.0.0.1:8080/login?next=%2Foperator"));
  assert.equal(ip.ok, false);
  assert.equal(!ip.ok && ip.href, "http://localhost:8080/login?next=%2Foperator", "127.0.0.1 links to the same page at localhost");
  const tailnet = passkeySupport(page("http://gauss.example.ts.net/login"));
  assert.equal(!tailnet.ok && tailnet.reason, "other-host");
  const plain = passkeySupport(page("http://gauss.example.ts.net/login", { rpId: "gauss.example.ts.net", secure: false }));
  assert.equal(!plain.ok && plain.reason, "insecure");
  assert.deepEqual(passkeySupport(page("https://gauss.example.ts.net/login", { rpId: "gauss.example.ts.net" })), { ok: true });
  assert.equal(passkeySupport(page("https://evil-gauss.example.ts.net/login", { rpId: "gauss.example.ts.net" })).ok, false);
  const off = passkeySupport(page("http://localhost:8080/login", { rpId: null }));
  assert.equal(!off.ok && off.reason, "off");
  const old = passkeySupport(page("http://localhost:8080/login", { webauthn: false }));
  assert.equal(!old.ok && old.reason, "unsupported");
});

test("the console signs out after 15 idle minutes by default, warning a minute before", () => {
  assert.equal(idleLimitMs(undefined), DEFAULT_IDLE_MINUTES * 60_000);
  assert.equal(idleLimitMs(""), 15 * 60_000);
  assert.equal(idleLimitMs("5"), 5 * 60_000);
  assert.equal(idleLimitMs("0"), 0, "0 turns it off");
  assert.equal(idleLimitMs("0.2"), 60_000, "at least a minute");
  assert.equal(idleLimitMs("100000"), 240 * 60_000);
  assert.equal(idleLimitMs("soon"), 15 * 60_000);
  assert.equal(idleLimitMs("-3"), 15 * 60_000);

  const limit = 15 * 60_000;
  const t0 = 1_000_000;
  assert.deepEqual(idlePhase(t0, t0 + 60_000, limit), { phase: "active", remainingMs: 14 * 60_000 });
  assert.equal(idlePhase(t0, t0 + limit - IDLE_WARNING_MS, limit).phase, "warning");
  assert.equal(idlePhase(t0, t0 + limit, limit).phase, "expired");
  assert.equal(idlePhase(t0, t0 + 3 * limit, limit).phase, "expired", "waking a laptop after an hour signs out at once");
});

test("activity in another tab counts; garbage or future timestamps in storage don't", () => {
  const now = 2_000_000;
  assert.equal(latestActivity(now - 10_000, String(now - 1000), now), now - 1000);
  assert.equal(latestActivity(now - 10_000, String(now - 60_000), now), now - 10_000);
  assert.equal(latestActivity(now - 10_000, null, now), now - 10_000);
  assert.equal(latestActivity(now - 10_000, "tomorrow", now), now - 10_000);
  assert.equal(latestActivity(now - 10_000, String(now + 3_600_000), now), now - 10_000, "a planted future value can't keep a session alive");
});

test("a 428 STEP_UP_REQUIRED answer asks for a passkey touch and retries once", async () => {
  const calls: string[] = [];
  const answers = [
    new Response(JSON.stringify({ code: "STEP_UP_REQUIRED" }), { status: 428 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ];
  const fetcher = async () => (calls.push("fetch"), answers.shift() ?? new Response(null, { status: 500 }));
  const res = await fetchWithStepUp("/api/admin/users/u/role", { method: "POST" }, async () => (calls.push("touch"), true), fetcher);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["fetch", "touch", "fetch"]);

  const cancelled = fetchWithStepUp(
    "/x",
    { method: "POST" },
    async () => false,
    async () => new Response(JSON.stringify({ code: "STEP_UP_REQUIRED" }), { status: 428 }),
  );
  await assert.rejects(cancelled, StepUpCancelled);

  // Anything else passes straight through, including a plain 403.
  let touches = 0;
  const forbidden = await fetchWithStepUp("/x", {}, async () => (touches++, true), async () => new Response("{}", { status: 403 }));
  assert.equal(forbidden.status, 403);
  assert.equal(touches, 0);
});
