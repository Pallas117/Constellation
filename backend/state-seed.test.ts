import assert from "node:assert/strict";
import test from "node:test";
import { getCanonicalFeed, pushCanonical, seedCanonical } from "./state.js";
import type { CanonicalSpaceWeatherPoint } from "./types.js";

const p = (i: number) => ({ timestamp: new Date(Date.UTC(2026, 9, 12, 0, 0, i)).toISOString() }) as CanonicalSpaceWeatherPoint;

test("restart reload fills an empty buffer once, in order, and never duplicates (GAU-117)", () => {
  assert.equal(seedCanonical([p(1), p(2), p(3)]), 3);
  assert.deepEqual(getCanonicalFeed().map((x) => x.timestamp), [p(1), p(2), p(3)].map((x) => x.timestamp));
  pushCanonical(p(4));
  assert.equal(seedCanonical([p(9)]), 0, "a non-empty buffer is left alone");
  assert.equal(getCanonicalFeed().length, 4);
});
