import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { asyncRoute } from "./async-route.js";

/** An app whose error handler answers a fixed 500, like backend/server.ts. */
function appWith(register: (app: express.Express) => void) {
  const app = express();
  register(app);
  app.use((_error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(_error);
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  });
  const server = app.listen(0);
  const { port } = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${port}` };
}

test("async routes: a rejected handler becomes the fixed 500, not an unhandled rejection that ends the process", async (t) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const { server, base } = appWith((app) => {
    app.get(
      "/boom",
      asyncRoute(async () => {
        throw new Error("secret detail /Users/someone/data/bedrock ENOSPC");
      }),
    );
    app.get(
      "/type-error",
      asyncRoute(async (req) => {
        // The kind of TypeError a malformed record or body causes.
        const record = JSON.parse(String(req.query.v)) as { type: string } | null;
        return record!.type;
      }),
    );
    app.get(
      "/ok",
      asyncRoute(async (_req, res) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        res.json({ ok: true });
      }),
    );
  });
  t.after(() => {
    process.off("unhandledRejection", onUnhandled);
    server.close();
  });

  const boom = await fetch(`${base}/boom`);
  assert.equal(boom.status, 500);
  const text = await boom.text();
  assert.deepEqual(JSON.parse(text), { error: "Internal server error" });
  assert.equal(text.includes("secret detail"), false, "the error message never reaches the client");

  const typeError = await fetch(`${base}/type-error?v=null`);
  assert.equal(typeError.status, 500);
  await typeError.body?.cancel();

  const ok = await fetch(`${base}/ok`);
  assert.equal(ok.status, 200, "the server is still serving");
  assert.deepEqual(await ok.json(), { ok: true });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, [], "no unhandled rejection");
});

test("async routes: a rejection after the answer started closes that connection and the server keeps serving", async (t) => {
  const { server, base } = appWith((app) => {
    app.get(
      "/half",
      asyncRoute(async (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write("[1,");
        throw new Error("stream failed midway");
      }),
    );
    app.get("/ok", (_req, res) => {
      res.json({ ok: true });
    });
  });
  t.after(() => server.close());

  await assert.rejects(async () => {
    const res = await fetch(`${base}/half`);
    await res.text();
  }, "a half-sent answer is cut off, never completed as if it were whole");
  assert.equal((await fetch(`${base}/ok`)).status, 200);
});
