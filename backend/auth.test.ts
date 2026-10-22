import assert from "node:assert/strict";
import test from "node:test";
import { roleFromUser, roleSatisfies } from "./auth.js";

test("users without a stored role are viewers, not admins", () => {
  assert.equal(roleFromUser({}), "user");
  assert.equal(roleFromUser(null), "user");
  assert.equal(roleFromUser({ role: "superuser" }), "user");
});

test("stored roles are honoured case-insensitively", () => {
  assert.equal(roleFromUser({ role: "operator" }), "operator");
  assert.equal(roleFromUser({ role: "ADMIN" }), "admin");
});

test("a user cannot satisfy an operator gate", () => {
  assert.equal(roleSatisfies(roleFromUser({}), "operator"), false);
  assert.equal(roleSatisfies(roleFromUser({ role: "operator" }), "operator"), true);
});

test("roles rank user < staff < operator < admin, and legacy 'viewer' means user", () => {
  assert.equal(roleFromUser({ role: "viewer" }), "user");
  assert.equal(roleFromUser({ role: "staff" }), "staff");
  assert.equal(roleSatisfies("staff", "user"), true);
  assert.equal(roleSatisfies("staff", "operator"), false);
  assert.equal(roleSatisfies("operator", "staff"), true);
  assert.equal(roleSatisfies("admin", "operator"), true);
});

test("Google SSO only creates accounts on the Workspace domain", async () => {
  const { ssoEmailAllowed, ssoAllowedDomain } = await import("./better-auth.js");
  assert.equal(ssoAllowedDomain, process.env.SSO_ALLOWED_DOMAIN ?? "lightbound.uk");
  assert.equal(ssoEmailAllowed(`josh@${ssoAllowedDomain}`), true);
  assert.equal(ssoEmailAllowed(`JOSH@${ssoAllowedDomain.toUpperCase()}`), true);
  assert.equal(ssoEmailAllowed("attacker@gmail.com"), false);
  assert.equal(ssoEmailAllowed(`x@evil-${ssoAllowedDomain}`), false);
  assert.equal(ssoEmailAllowed(`x@${ssoAllowedDomain}.evil.com`), false);
  assert.equal(ssoEmailAllowed(null), false);
});
