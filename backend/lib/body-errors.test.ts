import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { bodyErrorResponse } from "./body-errors.js";

/** The server's own order: express.json() first, the error handler last (backend/server.ts). */
async function withApp(fn: (url: string, seen: unknown[]) => Promise<void>) {
  const seen: unknown[] = [];
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.post("/echo", (req, res) => {
    res.json({ got: req.body });
  });
  app.post("/boom", () => {
    throw new Error("server fault");
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    seen.push(error);
    const bodyError = bodyErrorResponse(error);
    if (bodyError) {
      res.status(bodyError.status).json({ error: bodyError.error });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  });
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.close();
  }
}

const postRaw = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

test("body errors: invalid JSON is the client's mistake, 400 (GAU-231)", async () => {
  await withApp(async (url) => {
    for (const body of ['{"time": ', "{'single': 'quotes'}", '"a bare string"']) {
      const res = await postRaw(`${url}/echo`, body);
      assert.equal(res.status, 400, body);
      assert.deepEqual(await res.json(), { error: "invalid JSON" });
    }
  });
});

test("body errors: a body over the 2 MB limit is 413 (GAU-231)", async () => {
  await withApp(async (url) => {
    const res = await postRaw(`${url}/echo`, JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }));
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "request body too large" });

    const ok = await postRaw(`${url}/echo`, JSON.stringify({ pad: "x".repeat(1024 * 1024) }));
    assert.equal(ok.status, 200, "a 1 MB body is still accepted");
  });
});

test("body errors: an unsupported content encoding is 415 (GAU-231)", async () => {
  await withApp(async (url) => {
    const res = await postRaw(`${url}/echo`, "{}", { "content-encoding": "compress" });
    assert.equal(res.status, 415);
    assert.deepEqual(await res.json(), { error: "unsupported content encoding" });
  });
});

test("body errors: the answer never repeats the rejected body (GAU-231)", async () => {
  await withApp(async (url, seen) => {
    const res = await postRaw(`${url}/echo`, '{"key": "gk_secret_value", ');
    const text = await res.text();
    assert.equal(text.includes("gk_secret_value"), false);
    // body-parser keeps the raw body on the error, which is why the server must not log it whole.
    assert.equal((seen[0] as { body?: string }).body?.includes("gk_secret_value"), true);
  });
});

test("body errors: a real server fault is still 500 (GAU-231)", async () => {
  await withApp(async (url) => {
    const res = await postRaw(`${url}/boom`, "{}");
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: "Internal server error" });
  });
});

test("body errors: only body-parser's error types are mapped", () => {
  assert.equal(bodyErrorResponse(new Error("x")), null);
  assert.equal(bodyErrorResponse(null), null);
  assert.equal(bodyErrorResponse("entity.parse.failed"), null);
  assert.equal(bodyErrorResponse({ type: "toString" }), null, "inherited names are not error types");
  assert.equal(bodyErrorResponse({ type: "entity.verify.failed", status: 403 }), null, "unknown types stay a 500");
  assert.deepEqual(bodyErrorResponse({ type: "entity.too.large" }), { status: 413, error: "request body too large" });
});
