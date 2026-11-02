import assert from "node:assert/strict";
import test from "node:test";
import { queryLimit } from "./query-limit.js";

test("?limit= is clamped to 1..max, and junk falls back to the default instead of lifting the cap", () => {
  assert.equal(queryLimit(undefined, 200, 2000), 200);
  assert.equal(queryLimit("50", 200, 2000), 50);
  assert.equal(queryLimit("99999", 200, 2000), 2000);
  assert.equal(queryLimit("0", 200, 2000), 1);
  assert.equal(queryLimit("-5", 200, 2000), 1);
  assert.equal(queryLimit("abc", 200, 2000), 200);
  assert.equal(queryLimit(["1", "2"], 200, 2000), 200);
  assert.equal(queryLimit("12.7", 200, 2000), 12);
});
