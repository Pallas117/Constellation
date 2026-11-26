import assert from "node:assert/strict";
import test from "node:test";
import { auth } from "./better-auth.js";
import { startBackend, stopBackend } from "./server.ts";

// Threat model TM-04 / TM-12: operator and admin sessions end on the server after 30 min without a request. The
// dashboard left open then gets 401s with `x-gauss-session: ended`, and CyberTiger must not count those against
// the operator's own address (or they'd be blocked when they come back).
test("an operator session idle for 30 min is ended on the server; the 401s that follow don't trip CyberTiger", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const { server, host } = await startBackend({ port: 0 });
  const { port } = server.address() as { port: number };
  const base = `http://${host}:${port}`;

  // Stand in for the session lookup and revoke, so the real guard, idle check and API policy run.
  const api = auth.api as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  const real = { getSession: api.getSession, revokeSession: api.revokeSession };
  const revoked: unknown[] = [];
  api.getSession = async () => ({
    session: { token: "idle-test-session-token" },
    user: { id: "op-1", email: "op@example.com", role: "operator" },
  });
  api.revokeSession = async (input: unknown) => {
    revoked.push((input as { body?: { token?: string } }).body?.token);
    return { status: true };
  };
  t.after(async () => {
    Object.assign(api, real);
    t.mock.timers.reset();
    await stopBackend();
  });

  // An outside address (X-Forwarded-For from the loopback proxy), so CyberTiger would count its failures.
  const headers = { "x-forwarded-for": "203.0.113.90" };
  const status = () => fetch(`${base}/api/rag/status`, { headers });

  const first = await status();
  assert.notEqual(first.status, 401, "active operator session is accepted");
  t.mock.timers.tick(29 * 60_000);
  assert.notEqual((await status()).status, 401, "29 min later: still active, and the clock restarts");

  t.mock.timers.tick(31 * 60_000);
  const ended = await status();
  assert.equal(ended.status, 401, "31 min idle: ended on the server");
  assert.equal(ended.headers.get("x-gauss-session"), "ended");
  assert.match(JSON.stringify(await ended.json()), /30 minutes without activity/);
  assert.deepEqual(revoked, ["idle-test-session-token"], "the session row is revoked too");

  // The open dashboard keeps polling with the dead cookie: refused, never blocked.
  const after: number[] = [];
  for (let i = 0; i < 12; i++) after.push((await status()).status);
  assert.deepEqual(after, Array(12).fill(401), "still ended (not 429): CyberTiger didn't block the operator");
  assert.equal((await fetch(`${base}/api/sso-options`, { headers })).status, 200, "the address is not blocked");
});
