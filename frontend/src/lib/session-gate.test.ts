import assert from "node:assert/strict";
import test from "node:test";
import { gatedPath, showSessionWait, markSessionEnded, resetSessionEnded, signedInFor, subscribeSessionEnded, endedSessionKey } from "./session-gate";

const before = { user: { id: "u1" }, session: { id: "s1" } };
const after = { user: { id: "u1" }, session: { id: "s2" } };

test("after sign-out no role-gated route is requested, even while the session atom still holds the user", () => {
  resetSessionEnded();
  assert.equal(gatedPath("/api/swx/structures", signedInFor(before)), "/api/swx/structures");
  let woke = 0;
  const off = subscribeSessionEnded(() => woke++);
  markSessionEnded(before);
  markSessionEnded(before);
  off();
  assert.equal(woke, 1, "listeners are told once");
  assert.equal(signedInFor(before, endedSessionKey()), false);
  for (const path of ["/api/swx/structures", "/api/mesh/onboarding", "/api/mesh/devices", "/api/feed/space-objects", "/api/rag/status"]) {
    assert.equal(gatedPath(path, signedInFor(before, endedSessionKey())), null, path);
  }
});

test("a new sign-in is not held back by the old marker, and no user means signed out", () => {
  resetSessionEnded();
  markSessionEnded(before);
  assert.equal(signedInFor(after, endedSessionKey()), true);
  assert.equal(signedInFor(null, endedSessionKey()), false);
  assert.equal(signedInFor({ user: null }, null), false);
  resetSessionEnded();
});

test("a protected page waits for the first session answer only, so a refetch can't remount a wizard", () => {
  assert.equal(showSessionWait(true, false), true);
  assert.equal(showSessionWait(false, false), false);
  assert.equal(showSessionWait(true, true), false, "background refetch keeps the page mounted");
});
