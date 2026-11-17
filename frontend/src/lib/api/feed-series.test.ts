import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bucketMeans, lookbackSince, mergeSeries, pendingAfter, SERIES_WINDOW_MS } from "./feed-series.ts";

const T0 = Date.parse("2026-10-12T00:00:00Z");
const at = (offsetS: number, v = offsetS) => ({ timestamp: new Date(T0 + offsetS * 1000).toISOString(), v });
const series = (fromS: number, toS: number, stepS = 5) => {
  const out = [];
  for (let s = fromS; s <= toS; s += stepS) out.push(at(s));
  return out;
};

describe("lookbackSince", () => {
  it("backfills the whole window when nothing is held", () => {
    assert.equal(lookbackSince(null, T0), "PT86400S");
    assert.equal(lookbackSince([], T0), "PT86400S");
  });

  it("asks only for the gap since the newest point plus the margin", () => {
    assert.equal(lookbackSince([at(0)], T0 + 5_000), "PT125S");
  });

  it("grows with a gap and never exceeds the window", () => {
    assert.equal(lookbackSince([at(0)], T0 + 3_600_000), "PT3720S");
    assert.equal(lookbackSince([at(0)], T0 + 3 * SERIES_WINDOW_MS), "PT86400S");
  });

  it("keeps the margin when the client clock is behind the data", () => {
    assert.equal(lookbackSince([at(60)], T0), "PT120S");
  });
});

describe("mergeSeries", () => {
  it("returns the same array when nothing new arrived, so React skips the render", () => {
    const held = series(0, 60);
    assert.equal(mergeSeries(held, series(30, 60)), held);
    assert.equal(mergeSeries(held, []), held);
  });

  it("appends only points newer than the newest held, in order, once each", () => {
    const merged = mergeSeries(series(0, 10), [at(20), at(15), at(10, 999), at(15)]);
    assert.deepEqual(
      merged.map((p) => p.v),
      [0, 5, 10, 15, 20],
    );
  });

  it("never replaces a held point with a re-sent one", () => {
    const merged = mergeSeries([at(0, 1)], [at(0, 2), at(5, 3)]);
    assert.deepEqual(merged.map((p) => p.v), [1, 3]);
  });

  it("trims to the window and the point cap", () => {
    const merged = mergeSeries(series(0, 100, 10), [at(200)], 100_000);
    assert.equal(merged[0].v, 100);
    assert.equal(mergeSeries(null, series(0, 100, 10), SERIES_WINDOW_MS, 3).length, 3);
  });

  it("drops unparseable timestamps", () => {
    const merged = mergeSeries(null, [{ timestamp: "nope", v: 1 }, at(0)]);
    assert.deepEqual(merged.map((p) => p.v), [0]);
  });

  // GAU-150: the history panel merges (backfill still loading, no live point yet) on mount.
  it("returns an empty series when nothing is held and nothing arrives", () => {
    assert.deepEqual(mergeSeries(null, []), []);
  });

  it("returns an empty series when nothing is held and nothing valid arrives", () => {
    assert.deepEqual(mergeSeries(null, [{ timestamp: "nope", v: 1 }]), []);
  });
});

describe("bucketMeans", () => {
  it("caps a 24 h, 5 s series at the bucket limit with whole-minute buckets", () => {
    const day = series(0, 86_400 - 5);
    const { buckets, bucketMs } = bucketMeans(day, (p) => ({ v: p.v }), 720);
    assert.equal(bucketMs, 2 * 60_000);
    assert.ok(buckets.length <= 720);
    assert.equal(buckets[0].values.v, (0 + 115) / 2); // mean of 0..115 s
  });

  it("skips non-finite values without dropping the bucket", () => {
    const { buckets } = bucketMeans([at(0, 2), at(5, NaN)], (p) => ({ v: p.v }));
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].values.v, 2);
  });

  it("handles an empty series", () => {
    assert.deepEqual(bucketMeans([], () => ({})).buckets, []);
  });
});

describe("pendingAfter (GAU-208)", () => {
  it("drops pushed points a poll already holds, keeps the newer ones", () => {
    const pushed = series(0, 20);
    assert.deepEqual(pendingAfter(pushed, series(0, 10)), series(15, 20));
  });

  it("empties once the poll has caught up", () => {
    assert.deepEqual(pendingAfter(series(0, 10), series(0, 10)), []);
  });

  it("returns the same array when nothing changes, so React state stays put", () => {
    const pushed = series(15, 20);
    assert.equal(pendingAfter(pushed, series(0, 10)), pushed);
    assert.equal(pendingAfter(pushed, null), pushed);
    assert.equal(pendingAfter(pushed, []), pushed);
  });
});
