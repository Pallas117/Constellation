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
  // GAU-122: public TPM summary only (status and red ids), never values.
  assert.ok(["green", "amber", "red", "insufficient"].includes(body.tpm.status));
  assert.ok(Array.isArray(body.tpm.red));
  assert.equal(JSON.stringify(body.tpm).includes("value"), false);

  t.after(async () => {
    await stopBackend();
  });
});
