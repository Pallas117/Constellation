import assert from "node:assert/strict";
import test from "node:test";
import { TimeIndex } from "./time-index.ts";

type P = { timestamp: string };

// The scan the index replaces (server.ts filterByLookback before the index).
const reference = (points: P[], threshold: number, limit: number) => {
  const filtered = points.filter((p) => Date.parse(p.timestamp) >= threshold);
  return filtered.slice(Math.max(0, filtered.length - limit));
};

const at = (ms: number): P => ({ timestamp: new Date(ms).toISOString() });
const T0 = Date.parse("2026-11-04T00:00:00Z");

function buffer(max: number) {
  const points: P[] = [];
  const index = new TimeIndex();
  return {
    points,
    index,
    push(p: P) {
      points.push(p);
      index.push(p.timestamp);
      if (points.length > max) {
        points.shift();
        index.shift();
      }
    },
  };
}

test("matches the full scan on an ordered buffer, including repeats, edges and limits", () => {
  const b = buffer(1000);
  for (let i = 0; i < 1500; i++) b.push(at(T0 + Math.floor(i / 3) * 5000)); // repeated times, wraps the cap
  for (const threshold of [T0 - 1, T0 + 2_500_00, T0 + 1_000_000, T0 + 2_495_000, T0 + 2_500_000, T0 + 9e9, Number.NaN]) {
    for (const limit of [0, 1, 7, 999, 1000, 17280, -3]) {
      assert.deepEqual(b.index.since(b.points, threshold, limit), reference(b.points, threshold, limit), `t=${threshold} l=${limit}`);
    }
  }
});

test("falls back to the scan while any time is out of order or unparseable, and recovers once it leaves", () => {
  const b = buffer(50);
  for (let i = 0; i < 50; i++) b.push(at(T0 + i * 1000));
  b.push(at(T0)); // goes backwards
  b.push({ timestamp: "not a time" });
  const check = () => {
    for (const threshold of [T0 - 1, T0 + 10_000, T0 + 49_000, T0 + 60_000]) {
      for (const limit of [1, 5, 100]) assert.deepEqual(b.index.since(b.points, threshold, limit), reference(b.points, threshold, limit));
    }
  };
  check();
  for (let i = 0; i < 60; i++) {
    b.push(at(T0 + 100_000 + i * 1000)); // the bad entries shift out
    check();
  }
});

test("random buffers agree with the scan", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let run = 0; run < 50; run++) {
    const b = buffer(40);
    for (let i = 0; i < 120; i++) {
      const r = rand();
      b.push(r < 0.03 ? { timestamp: "" } : at(T0 + i * 1000 - (r < 0.08 ? 30_000 : 0)));
      const threshold = T0 + Math.floor(rand() * 130_000);
      const limit = Math.floor(rand() * 50);
      assert.deepEqual(b.index.since(b.points, threshold, limit), reference(b.points, threshold, limit));
    }
  }
});
