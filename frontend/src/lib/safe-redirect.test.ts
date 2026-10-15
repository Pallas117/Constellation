import assert from "node:assert/strict";
import test from "node:test";
import { safeRedirectPath } from "./safe-redirect.ts";

const FALLBACK = "/operator";

test("keeps in-app paths, including query and hash", () => {
  assert.equal(safeRedirectPath("/protection", FALLBACK), "/protection");
  assert.equal(safeRedirectPath("/operator?e2e=true#alerts", FALLBACK), "/operator?e2e=true#alerts");
});

test("rejects protocol-relative and backslash targets (GHSA-wrjc-x8rr-h8h6)", () => {
  for (const target of ["//evil.example", "/\\evil.example", "/\\/evil.example", "/\t/evil.example", "/\n/evil.example"]) {
    assert.equal(safeRedirectPath(target, FALLBACK), FALLBACK, JSON.stringify(target));
  }
});

test("rejects absolute, scripted, relative and non-string targets", () => {
  for (const target of ["https://evil.example/operator", "javascript:alert(1)", "operator", "", undefined, null, 42]) {
    assert.equal(safeRedirectPath(target, FALLBACK), FALLBACK, String(target));
  }
});
