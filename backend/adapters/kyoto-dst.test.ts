import assert from "node:assert/strict";
import test from "node:test";
import { DST_MAX_AGE_MS, fetchKyotoDst, freshDst, getKyotoDstStatus, pickLatestDst } from "./kyoto-dst.js";

const now = Date.parse("2026-10-12T09:48:00Z");
const feed = [
  { time_tag: "2026-10-12T07:00:00", dst: -37 },
  { time_tag: "2026-10-12T09:00:00", dst: -31 },
  { time_tag: "2026-10-12T08:00:00", dst: -34 },
  { time_tag: "2026-10-12T10:00:00", dst: "" }, // not yet published
  { time_tag: "bad", dst: -5 },
];

async function withFeed<T>(status: number, body: unknown, fn: () => Promise<T>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("Kyoto Dst: newest valid hour, read as UTC; blanks and bad times skipped (GAU-116)", () => {
  assert.deepEqual(pickLatestDst(feed), { dst: -31, timestamp: "2026-10-12T09:00:00.000Z" });
  assert.equal(pickLatestDst([]), null);
  assert.equal(pickLatestDst({}), null);
  assert.equal(pickLatestDst([{ time_tag: "2026-10-12T09:00:00", dst: 99999 }]), null, "fill value");
});

test("Kyoto Dst: used only while under 2 h old, then the model takes over (GAU-116)", () => {
  const r = pickLatestDst(feed)!;
  assert.equal(freshDst(r, now), -31);
  assert.equal(freshDst(r, Date.parse(r.timestamp) + DST_MAX_AGE_MS + 1), undefined);
  assert.equal(freshDst(null, now), undefined);
});

test("Kyoto Dst: status from the data time; failures keep the last real time, no URL (GAU-116)", async () => {
  await withFeed(200, feed, () => fetchKyotoDst(now));
  let s = getKyotoDstStatus();
  assert.equal(s.healthy, true);
  assert.equal(s.lastSeen, "2026-10-12T09:00:00.000Z");
  assert.equal(s.latencySeconds, 48 * 60);
  assert.equal(await withFeed(503, {}, () => fetchKyotoDst(now)), null);
  s = getKyotoDstStatus();
  assert.equal(s.healthy, false);
  assert.equal(s.lastSeen, "2026-10-12T09:00:00.000Z");
  assert.ok(!s.message?.includes("https://"));
});
