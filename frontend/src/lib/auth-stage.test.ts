import { test } from "node:test";
import assert from "node:assert/strict";
import { isOverlayPath, openedOverStage, overlayState, stageFor, stageHref } from "./auth-stage";

test("normal pages have no stage", () => {
  assert.equal(stageFor("/", null), null);
  assert.equal(stageFor("/operator", { backgroundLocation: { pathname: "/", search: "" } }), null);
  assert.equal(isOverlayPath("/login"), true);
  assert.equal(isOverlayPath("/login/extra"), false);
});

test("a direct visit to /login gets the live landing page behind it", () => {
  const stage = stageFor("/login", null);
  assert.equal(stage?.pathname, "/");
  assert.equal(stage?.search, "");
  // A protected page's redirect carries `from`, not a background: still the landing page.
  assert.equal(stageFor("/login", { from: { pathname: "/operator" } })?.pathname, "/");
});

test("sign-in opened from a public page keeps that page behind it", () => {
  const stage = stageFor("/login", { backgroundLocation: { pathname: "/member", search: "?tab=events" } });
  assert.equal(stage?.pathname, "/member");
  assert.equal(stage?.search, "?tab=events");
  assert.equal(stage?.key, "auth-stage");
});

test("a protected or unknown page is never rendered as the stage", () => {
  for (const pathname of ["/operator", "/heliophysics", "/mesh", "/account/api", "//evil.example", "/login"]) {
    assert.equal(stageFor("/login", { backgroundLocation: { pathname, search: "" } })?.pathname, "/", pathname);
    assert.equal(overlayState({ pathname, search: "" }), undefined, pathname);
  }
});

test("only a plain query string is carried over", () => {
  assert.equal(stageFor("/login", { backgroundLocation: { pathname: "/", search: "?e2e=true" } })?.search, "?e2e=true");
  assert.equal(stageFor("/login", { backgroundLocation: { pathname: "/", search: "e2e" } })?.search, "");
  assert.equal(stageFor("/login", { backgroundLocation: { pathname: "/", search: "?a#b" } })?.search, "");
  assert.equal(stageFor("/login", { backgroundLocation: { pathname: "/", search: 7 } })?.search, "");
});

test("overlay state round-trips and decides how closing works", () => {
  const state = overlayState({ pathname: "/", search: "?e2e=true" });
  assert.deepEqual(state, { backgroundLocation: { pathname: "/", search: "?e2e=true" } });
  assert.equal(openedOverStage(state), true);
  assert.equal(stageHref(state), "/?e2e=true");
  assert.equal(openedOverStage(null), false);
  assert.equal(stageHref({ from: { pathname: "/operator" } }), "/");
});
