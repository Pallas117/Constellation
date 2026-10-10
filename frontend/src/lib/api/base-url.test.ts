import assert from "node:assert/strict";
import test from "node:test";
import { resolveApiBase } from "./base-url.ts";

test("same-origin sentinel", () => {
  assert.deepEqual(resolveApiBase("same-origin"), { kind: "same-origin" });
  assert.deepEqual(resolveApiBase("  same-origin "), { kind: "same-origin" });
});

test("unset or empty falls back to the dev backend", () => {
  assert.deepEqual(resolveApiBase(undefined), { kind: "absolute", url: "http://127.0.0.1:3001" });
  assert.deepEqual(resolveApiBase(""), { kind: "absolute", url: "http://127.0.0.1:3001" });
});

test("absolute URLs are kept without a trailing slash", () => {
  assert.deepEqual(resolveApiBase("http://judith.tail4f9ebe.ts.net/"), {
    kind: "absolute",
    url: "http://judith.tail4f9ebe.ts.net",
  });
});
