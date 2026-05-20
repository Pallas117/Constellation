import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "express";
import { CyberTigerDaemon } from "./daemon.js";

function mockRequest(input: {
  method?: string;
  url?: string;
  ip?: string;
  forwarded?: string;
}): Request {
  return {
    method: input.method ?? "GET",
    originalUrl: input.url ?? "/api/feed/sources/status",
    url: input.url ?? "/api/feed/sources/status",
    headers: input.forwarded ? { "x-forwarded-for": input.forwarded } : {},
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
