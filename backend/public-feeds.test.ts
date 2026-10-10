import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { startBackend, stopBackend } from "./server.ts";

// The landing visualisation is public; anonymous visitors must get data, not
// 401s (CyberTiger would count those and block their IP). Everything else stays
// behind sign-in.
test("landing feeds are public; other API routes still require a session", async (t) => {
  const { server, host } = await startBackend({ port: 0 });
  t.after(async () => {
    await stopBackend();
  });
  const base = `http://${host}:${(server.address() as AddressInfo).port}`;

  assert.equal((await fetch(`${base}/api/system/connectivity`)).status, 200);
  assert.notEqual((await fetch(`${base}/api/feed/space-weather/latest`)).status, 401);

  assert.equal((await fetch(`${base}/api/feed/space-objects`)).status, 401);
  assert.equal((await fetch(`${base}/api/mesh/onboarding`)).status, 401);
  assert.equal((await fetch(`${base}/api/system/connectivity`, { method: "POST" })).status, 401);
});

test("sso-options is public and reports Google SSO off without credentials", async (t) => {
  const { server, host } = await startBackend({ port: 0 });
  t.after(async () => {
    await stopBackend();
  });
  const base = `http://${host}:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/sso-options`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.google, Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET));
  assert.equal(JSON.stringify(body).includes("secret"), false);
});
