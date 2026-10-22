import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  classifyResponse,
  nextDelay,
  parseRetryAfter,
  startPolling,
  type PollOutcome,
} from "./feed-poller.ts";

const policy = { baseMs: 5_000, maxMs: 300_000 };
const noJitter = () => 0.5; // 0.8 + 0.4 * 0.5 = 1.0
const flush = () => new Promise((r) => setImmediate(r));
const res = (status: number, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
});

describe("classifyResponse", () => {
  it("maps 2xx to ok, 401/403 to unauthorized, 429 to rate-limited, rest to error", () => {
    assert.deepEqual(classifyResponse(res(200)), { kind: "ok" });
    assert.deepEqual(classifyResponse(res(401)), { kind: "unauthorized", status: 401 });
    assert.deepEqual(classifyResponse(res(403)), { kind: "unauthorized", status: 403 });
    assert.deepEqual(classifyResponse(res(429, { "Retry-After": "30" })), { kind: "rate-limited", retryAfterMs: 30_000 });
    assert.deepEqual(classifyResponse(res(404)), { kind: "error", status: 404 });
    assert.deepEqual(classifyResponse(res(503)), { kind: "error", status: 503 });
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    assert.equal(parseRetryAfter("120", now), 120_000);
    assert.equal(parseRetryAfter("Sat, 10 Oct 2026 12:01:00 GMT", now), 60_000);
    assert.equal(parseRetryAfter("Sat, 10 Oct 2026 11:00:00 GMT", now), 0);
    assert.equal(parseRetryAfter(null, now), undefined);
    assert.equal(parseRetryAfter("soon", now), undefined);
  });
});

describe("nextDelay", () => {
  it("returns the base interval after success", () => {
    assert.equal(nextDelay({ kind: "ok" }, 0, policy, noJitter), 5_000);
  });

  it("stops on unauthorized", () => {
    assert.equal(nextDelay({ kind: "unauthorized", status: 401 }, 1, policy, noJitter), null);
  });

  it("doubles on consecutive errors up to the ceiling", () => {
    const e: PollOutcome = { kind: "error" };
    assert.equal(nextDelay(e, 1, policy, noJitter), 10_000);
    assert.equal(nextDelay(e, 2, policy, noJitter), 20_000);
    assert.equal(nextDelay(e, 3, policy, noJitter), 40_000);
    assert.equal(nextDelay(e, 20, policy, noJitter), 300_000);
  });

  it("honours Retry-After when it is longer than the backoff, capped at max", () => {
    assert.equal(nextDelay({ kind: "rate-limited", retryAfterMs: 90_000 }, 1, policy, noJitter), 90_000);
    assert.equal(nextDelay({ kind: "rate-limited", retryAfterMs: 1_000 }, 1, policy, noJitter), 10_000);
    assert.equal(nextDelay({ kind: "rate-limited", retryAfterMs: 3_600_000 }, 1, policy, noJitter), 300_000);
  });

  it("keeps jitter within ±20%", () => {
    const e: PollOutcome = { kind: "error" };
    assert.equal(nextDelay(e, 1, policy, () => 0), 8_000);
    assert.equal(nextDelay(e, 1, policy, () => 1), 12_000);
  });
});

describe("startPolling", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("polls once and stops for good on 401", async () => {
    let calls = 0;
    let unauthorized: number | undefined;
    const stop = startPolling({
      poll: async () => {
        calls++;
        return { kind: "unauthorized", status: 401 };
      },
      policy,
      random: noJitter,
      onUnauthorized: (s) => (unauthorized = s),
    });
    await flush();
    mock.timers.tick(10 * 60_000);
    await flush();
    assert.equal(calls, 1, "a 401 must not be retried: CyberTiger counts them");
    assert.equal(unauthorized, 401);
    stop();
  });

  it("backs off on 429 and recovers to the base interval after success", async () => {
    const outcomes: PollOutcome[] = [
      { kind: "rate-limited" },
      { kind: "rate-limited" },
      { kind: "ok" },
      { kind: "ok" },
    ];
    const delays: (number | null)[] = [];
    let calls = 0;
    const stop = startPolling({
      poll: async () => outcomes[calls++] ?? { kind: "ok" },
      policy,
      random: noJitter,
      onSchedule: (d) => delays.push(d),
    });
    await flush();
    for (const step of [10_000, 20_000, 5_000]) {
      mock.timers.tick(step);
      await flush();
    }
    assert.deepEqual(delays, [10_000, 20_000, 5_000, 5_000]);
    assert.equal(calls, 4);
    stop();
  });

  it("never overlaps requests and stops cleanly", async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    let release: (() => void) | undefined;
    const stop = startPolling({
      poll: () =>
        new Promise<PollOutcome>((resolve) => {
          calls++;
          active++;
          maxActive = Math.max(maxActive, active);
          release = () => {
            active--;
            resolve({ kind: "ok" });
          };
        }),
      policy,
      random: noJitter,
    });
    await flush();
    mock.timers.tick(60_000); // slow request: no new timer is pending yet
    await flush();
    assert.equal(calls, 1);
    release?.();
    await flush();
    mock.timers.tick(5_000);
    await flush();
    assert.equal(calls, 2);
    assert.equal(maxActive, 1);
    stop();
    release?.();
    mock.timers.tick(60_000);
    await flush();
    assert.equal(calls, 2, "no polls after stop");
  });

  it("treats a thrown poll as an error and backs off", async () => {
    const delays: (number | null)[] = [];
    const stop = startPolling({
      poll: async () => {
        throw new TypeError("Failed to fetch");
      },
      policy,
      random: noJitter,
      onSchedule: (d) => delays.push(d),
    });
    await flush();
    mock.timers.tick(10_000);
    await flush();
    assert.deepEqual(delays, [10_000, 20_000]);
    stop();
  });
});
