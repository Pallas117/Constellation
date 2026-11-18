import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { startBackend, stopBackend } from "./server.ts";

const testPort = 0; // use ephemeral port
let backendUrl: string;

test("backend harness starts and responds to /health", async (t) => {
  const { server, host, port } = await startBackend({ port: testPort });
  const address = server.address();
  assert.ok(address, "Server must bind to an address");
  const actualPort = typeof address === "object" && address?.port ? address.port : port;
  backendUrl = `http://${host}:${actualPort}`;

  const response = await fetch(`${backendUrl}/health`);
  assert.strictEqual(response.status, 200);
  const body = (await response.json()) as { ok: boolean; timestamp: string; tpm: { status: string; red: string[] } };
  assert.strictEqual(body.ok, true);
  assert.ok(typeof body.timestamp === "string");
  // GAU-122: public TPM summary only (status and red ids), never values.
  assert.ok(["green", "amber", "red", "insufficient"].includes(body.tpm.status));
  assert.ok(Array.isArray(body.tpm.red));
  assert.equal(JSON.stringify(body.tpm).includes("value"), false);

  t.after(async () => {
    await stopBackend();
  });
});

test("backend answers a bad request body with 400 or 413, not 500, and does not count it against the IP (GAU-231)", async (t) => {
  const { server, host, port } = await startBackend({ port: testPort });
  const address = server.address();
  const url = `http://${host}:${typeof address === "object" && address?.port ? address.port : port}`;
  t.after(async () => {
    await stopBackend();
  });
  const post = (path: string, body: string) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });

  // The pilot route most likely to get a bad body. No key is sent: the body is read first.
  const invalid = await post("/api/v1/data/trust/records", '{"time": ');
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid JSON" });
  assert.equal(invalid.headers.get("x-content-type-options"), "nosniff");

  const oversized = await post("/api/v1/data/trust/records", JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "request body too large" });

  // A client retrying a malformed body must not get its IP blocked: the guard counts only 401/403.
  for (let i = 0; i < 40; i += 1) await post("/api/v1/data/trust/records", "{");
  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200);
  const unauthenticated = await post("/api/v1/data/trust/records", "{}");
  assert.equal(unauthenticated.status, 401, "still answered by the API, not blocked (429)");
});

test("a disallowed CORS origin gets no Access-Control-Allow-Origin and no 500 (REQ-SEC-021)", async (t) => {
  const { server, host, port } = await startBackend({ port: testPort });
  const address = server.address();
  const url = `http://${host}:${typeof address === "object" && address?.port ? address.port : port}`;
  t.after(async () => {
    await stopBackend();
  });
  const blocked = await fetch(`${url}/health`, { headers: { origin: "https://evil.example" } });
  assert.notEqual(blocked.status, 500);
  assert.equal(blocked.headers.get("access-control-allow-origin"), null);
});

test("an unauthenticated WebSocket upgrade is refused with 401 before it opens (REQ-SEC-020)", async (t) => {
  const { server, host, port } = await startBackend({ port: testPort });
  const address = server.address();
  const actual = typeof address === "object" && address?.port ? address.port : port;
  t.after(async () => {
    await stopBackend();
  });
  const outcome = await new Promise<{ status: number | null; opened: boolean }>((resolve) => {
    const ws = new WebSocket(`ws://${host}:${actual}/ws/feed/space-weather`);
    ws.on("open", () => {
      ws.terminate();
      resolve({ status: null, opened: true });
    });
    ws.on("unexpected-response", (_req, res) => {
      res.resume();
      resolve({ status: res.statusCode ?? null, opened: false });
    });
    ws.on("error", () => resolve({ status: null, opened: false }));
  });
  assert.equal(outcome.opened, false);
  assert.ok(outcome.status === 401 || outcome.status === 403, `status ${outcome.status}`);
});
