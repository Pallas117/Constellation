import assert from "node:assert/strict";
import test from "node:test";
import { startBackend, stopBackend } from "./server.ts";

// Threat model TM-01: /api/auth is mounted before the /api routes, so failed sign-ins used to skip CyberTiger.
// Now the same guard runs in front of /api/auth: its 401s count toward the IP auto-block, and a blocked IP can't
// keep guessing.
test("CyberTiger counts failed sign-in requests and then blocks that address on /api/auth and /api alike", async (t) => {
  const { server, host } = await startBackend({ port: 0 });
  const { port } = server.address() as { port: number };
  const base = `http://${host}:${port}`;
  t.after(async () => {
    await stopBackend();
  });

  // The test talks over loopback; X-Forwarded-For (trusted from a loopback peer) makes it an outside address.
  const outsider = { "x-forwarded-for": "203.0.113.77" };
  const statuses: number[] = [];
  for (let i = 0; i < 8; i++) statuses.push((await fetch(`${base}/api/auth/list-sessions`, { headers: outsider })).status);
  assert.deepEqual(statuses, Array(8).fill(401), "signed out: each is refused and counted");

  const blocked = await fetch(`${base}/api/auth/get-session`, { headers: outsider });
  assert.equal(blocked.status, 429, "the ninth request is refused by CyberTiger, before better-auth");
  assert.match(JSON.stringify(await blocked.json()), /CyberTiger/);
  assert.equal((await fetch(`${base}/api/sso-options`, { headers: outsider })).status, 429, "blocked across /api too");

  // Another outside address and a direct local caller are unaffected.
  assert.equal((await fetch(`${base}/api/auth/get-session`, { headers: { "x-forwarded-for": "203.0.113.78" } })).status, 200);
  assert.equal((await fetch(`${base}/api/auth/get-session`)).status, 200);
});
