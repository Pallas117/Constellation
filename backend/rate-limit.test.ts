import assert from "node:assert/strict";
import test from "node:test";
import type { Request } from "express";
import { windowLimit } from "./rate-limit.js";

function call(limit: ReturnType<typeof windowLimit>, ip: string) {
  let status = 200;
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => void (headers[name] = value),
    status: (s: number) => ((status = s), { json: () => undefined }),
  };
  let passed = false;
  limit({ ip } as unknown as Request, res as never, () => void (passed = true));
  return { status: passed ? 200 : status, headers };
}

test("passkey limiter answers 429 with Retry-After past the limit, per client, and resets each window", () => {
  let now = 1_000_000;
  const limit = windowLimit({ windowMs: 60_000, max: 3, keyOf: (req) => req.ip ?? "", now: () => now });
  assert.deepEqual([1, 2, 3].map(() => call(limit, "100.64.0.9").status), [200, 200, 200]);
  const refused = call(limit, "100.64.0.9");
  assert.equal(refused.status, 429, "never 401/403: CyberTiger must not count it as an auth failure");
  assert.equal(refused.headers["retry-after"], "60");
  assert.equal(call(limit, "100.64.0.10").status, 200, "another client has its own window");
  now += 60_000;
  assert.equal(call(limit, "100.64.0.9").status, 200);
});

test("passkey limiter keeps memory bounded under many clients", () => {
  let now = 0;
  const limit = windowLimit({ windowMs: 60_000, max: 1, keyOf: (req) => req.ip ?? "", maxKeys: 100, now: () => now });
  for (let i = 0; i < 1000; i++) call(limit, `10.0.${i >> 8}.${i & 255}`);
  // The newest client is still tracked (its second attempt is refused); the oldest were dropped.
  assert.equal(call(limit, "10.0.3.231").status, 429);
  assert.equal(call(limit, "10.0.0.0").status, 200);
  now += 60_000;
  assert.equal(call(limit, "10.0.3.231").status, 200);
});
