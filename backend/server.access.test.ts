import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { isAllowedOrigin, startBackend, stopBackend } from "./server.ts";

function withNodeEnv(value: string | undefined, fn: () => void) {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

test("production only allows explicitly configured origins", () => {
  withNodeEnv("production", () => {
    assert.equal(isAllowedOrigin("http://127.0.0.1:5173"), true); // in default ALLOWED_ORIGINS
    assert.equal(isAllowedOrigin("http://127.0.0.1:9999"), false);
    assert.equal(isAllowedOrigin("http://localhost:9999"), false);
    assert.equal(isAllowedOrigin("http://127.0.0.1.evil.com"), false);
    assert.equal(isAllowedOrigin("https://evil.com/?x=127.0.0.1"), false);
  });
});

test("development allows any loopback port but not look-alike hosts", () => {
  withNodeEnv("development", () => {
    assert.equal(isAllowedOrigin("http://localhost:3000"), true);
    assert.equal(isAllowedOrigin("http://127.0.0.1:4000"), true);
    assert.equal(isAllowedOrigin("http://[::1]:5173"), true);
    assert.equal(isAllowedOrigin("http://localhost.evil.com"), false);
    assert.equal(isAllowedOrigin("http://evil-localhost.com"), false);
    assert.equal(isAllowedOrigin("http://127.0.0.1.evil.com"), false);
    assert.equal(isAllowedOrigin("http://evil.com#localhost"), false);
    assert.equal(isAllowedOrigin("not a url"), false);
  });
});

/** Open a feed socket and report its first message and whether it was still open after `holdMs`. */
function feedSocket(url: string, origin?: string, holdMs = 300) {
  return new Promise<{ first: string | null; status: number | null; closeCode: number | null; openAfter: boolean }>((resolve) => {
    const result = { first: null as string | null, status: null as number | null, closeCode: null as number | null, openAfter: false };
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.on("message", (data) => (result.first ??= String(data)));
    ws.on("unexpected-response", (_req, res) => {
      result.status = res.statusCode ?? null;
      res.resume();
      ws.terminate();
    });
    ws.on("error", () => {});
    ws.on("close", (code) => (result.closeCode = code));
    setTimeout(() => {
      result.openAfter = ws.readyState === WebSocket.OPEN;
      ws.terminate();
      resolve(result);
    }, holdMs);
  });
}

test("feed WebSockets: both paths connect at once and stay open; bad origin and unknown path refused (GAU-201)", async (t) => {
  const { server, host } = await startBackend({ port: 0 });
  const { port } = server.address() as { port: number };
  const base = `ws://${host}:${port}`;
  t.after(async () => {
    delete process.env.AUTH_REQUIRED;
    await stopBackend();
  });

  process.env.AUTH_REQUIRED = "false"; // dev bypass, so the guard admits the socket
  const streams = ["space-weather", "mms-reconnection"];
  const opened = await Promise.all(streams.map((s) => feedSocket(`${base}/ws/feed/${s}`)));
  opened.forEach((r, i) => {
    assert.equal(r.status, null, streams[i]);
    assert.equal(JSON.parse(r.first ?? "{}").payload?.stream, streams[i], `${streams[i]}: its own handler answered`);
    assert.equal(r.openAfter, true, `${streams[i]}: still open`);
  });

  const blocked = await Promise.all(streams.map((s) => feedSocket(`${base}/ws/feed/${s}`, "https://evil.example")));
  blocked.forEach((r, i) => assert.equal(r.closeCode, 1008, `${streams[i]}: origin guard`));

  assert.equal((await feedSocket(`${base}/ws/feed/unknown`)).status, 400);
});

test("RAG endpoints require a session and never log query text", async (t) => {
  const { server, host } = await startBackend({ port: 0 });
  const { port } = server.address() as { port: number };
  const base = `http://${host}:${port}/api/rag`;
  t.after(async () => {
    delete process.env.AUTH_REQUIRED;
    await stopBackend();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  process.env.AUTH_REQUIRED = "true";
  assert.equal((await fetch(`${base}/status`)).status, 401);
  assert.equal((await post("/index", { dir: "/" })).status, 401);
  assert.equal((await post("/query", { query: "x" })).status, 401);

  // Authenticated (dev bypass): the query runs, but its text must not reach the logs.
  process.env.AUTH_REQUIRED = "false";
  const secret = "SECRET-OPERATOR-QUERY-7f3a";
  const logged: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const level of Object.keys(originals) as (keyof typeof originals)[]) {
    console[level] = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
  }
  let status: number;
  try {
    status = (await post("/query", { query: secret })).status;
  } finally {
    Object.assign(console, originals);
  }
  assert.notEqual(status, 401);
  assert.ok(!logged.some((line) => line.includes(secret)), `query text leaked into logs:\n${logged.join("\n")}`);
});
