import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "express";
import { CyberTigerDaemon } from "./daemon.js";

function mockRequest(input: {
  method?: string;
  url?: string;
  ip?: string;
  forwarded?: string;
  headers?: Record<string, string>;
}): Request {
  return {
    method: input.method ?? "GET",
    originalUrl: input.url ?? "/api/feed/sources/status",
    url: input.url ?? "/api/feed/sources/status",
    headers: { ...(input.forwarded ? { "x-forwarded-for": input.forwarded } : {}), ...(input.headers ?? {}) },
    ip: input.ip ?? "127.0.0.1",
    socket: { remoteAddress: input.ip ?? "127.0.0.1" },
  } as unknown as Request;
}

test("blocks malicious signature and places IP on blocklist", () => {
  const daemon = new CyberTigerDaemon({
    rateLimitMax: 1000,
    autoBlockSeconds: 60,
    maxEvents: 1000,
  });

  const req = mockRequest({
    method: "GET",
    url: "/api/feed/space-weather/5s?query=union%20select%201",
    ip: "10.0.0.5",
  });

  const decision = daemon.inspectRequest(req);
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 400);

  const status = daemon.getStatus();
  assert.equal(status.counters.signatureHits, 1);
  assert.equal(status.counters.activeBlocks, 1);
});

test("rate limits after max requests within configured window", () => {
  const daemon = new CyberTigerDaemon({
    rateLimitWindowMs: 60_000,
    rateLimitMax: 2,
    maxEvents: 1000,
  });

  const req = mockRequest({ ip: "10.0.0.10", method: "GET", url: "/api/feed/sources/status" });
  assert.equal(daemon.inspectRequest(req).allowed, true);
  assert.equal(daemon.inspectRequest(req).allowed, true);

  const third = daemon.inspectRequest(req);
  assert.equal(third.allowed, false);
  assert.equal(third.status, 429);
});

test("auth failure threshold auto-blocks IP", () => {
  const daemon = new CyberTigerDaemon({
    authFailureWindowMs: 60_000,
    authFailureThreshold: 3,
    autoBlockSeconds: 120,
    rateLimitMax: 1000,
    maxEvents: 1000,
  });
  const req = mockRequest({ ip: "10.0.0.21", method: "GET", url: "/api/feed/sources/status" });
  const inspected = daemon.inspectRequest(req);
  assert.equal(inspected.allowed, true);

  for (let i = 0; i < 3; i += 1) {
    daemon.recordResponse({
      requestId: `req-${i}`,
      ip: "10.0.0.21",
      method: "GET",
      path: "/api/feed/sources/status",
      status: 401,
    });
  }

  const later = daemon.inspectRequest(req);
  assert.equal(later.allowed, false);
  assert.equal(later.status, 429);
});

test("X-Forwarded-For is trusted only from the local proxy, and only its last hop", () => {
  const daemon = new CyberTigerDaemon({ rateLimitMax: 1000 });
  // Remote client trying to pick its own address: ignored.
  assert.equal(daemon.extractClientIp(mockRequest({ ip: "203.0.113.9", forwarded: "1.2.3.4" })), "203.0.113.9");
  // Via the local proxy: the entry the proxy appended, not the client-supplied first one.
  assert.equal(daemon.extractClientIp(mockRequest({ ip: "127.0.0.1", forwarded: "6.6.6.6, 100.64.1.5" })), "100.64.1.5");
  assert.equal(daemon.extractClientIp(mockRequest({ ip: "::ffff:127.0.0.1", forwarded: "100.64.1.7" })), "100.64.1.7");
});

test("direct local requests are never auto-blocked; proxied tailnet clients still are", () => {
  const daemon = new CyberTigerDaemon({ authFailureWindowMs: 60_000, authFailureThreshold: 3, autoBlockSeconds: 120, rateLimitMax: 1000 });
  const local = mockRequest({ ip: "127.0.0.1" });
  for (let i = 0; i < 10; i += 1) {
    const d = daemon.inspectRequest(local);
    assert.equal(d.allowed, true, `local request ${i} allowed`);
    assert.equal(d.local, true);
    daemon.recordResponse({ requestId: d.requestId, ip: d.ip, local: d.local, method: "GET", path: "/api/feed/aurora/map", status: 401 });
  }
  assert.equal(daemon.inspectRequest(local).allowed, true, "a stale local tab must not take Gauss down");

  const viaProxy = mockRequest({ ip: "127.0.0.1", forwarded: "100.64.1.5", headers: { "tailscale-user-login": "x@lightbound.uk" } });
  for (let i = 0; i < 3; i += 1) {
    const d = daemon.inspectRequest(viaProxy);
    assert.equal(d.local, false);
    daemon.recordResponse({ requestId: d.requestId, ip: d.ip, local: d.local, method: "GET", path: "/api/x", status: 401 });
  }
  assert.equal(daemon.inspectRequest(viaProxy).allowed, false, "tailnet client blocked under its own address");
  assert.equal(daemon.inspectRequest(local).allowed, true, "and that block does not affect this machine");
});
