import assert from "node:assert/strict";
import test from "node:test";
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
  const body = await response.json();
  assert.strictEqual(body.ok, true);
  assert.ok(typeof body.timestamp === "string");

  t.after(async () => {
    await stopBackend();
  });
});
