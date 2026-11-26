import assert from "node:assert/strict";
import test from "node:test";
import { authRequired, roleFromUser, roleSatisfies } from "./auth.js";

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

test("the admin-for-everyone dev bypass fails closed: honoured only when NODE_ENV is development or test (FM-25)", () => {
  const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;
  // Sign-in is required by default, whatever NODE_ENV says.
  assert.equal(authRequired(env({})), true);
  assert.equal(authRequired(env({ AUTH_REQUIRED: "true" })), true);
  assert.equal(authRequired(env({ AUTH_REQUIRED: "yes", NODE_ENV: "development" })), true, "only the word false asks for the bypass");
  // Asked for, but not an explicit development or test run: ignored. Unset is how the LaunchAgents run live.
  for (const nodeEnv of [undefined, "", "production", "PRODUCTION", "prod", "staging", "dev", " "]) {
    const vars: Record<string, string> = { AUTH_REQUIRED: "false" };
    if (nodeEnv !== undefined) vars.NODE_ENV = nodeEnv;
    assert.equal(authRequired(env(vars)), true, `NODE_ENV=${JSON.stringify(nodeEnv)} must keep sign-in required`);
  }
  // Explicit development or test runs may use it (any case, surrounding spaces ignored).
  for (const nodeEnv of ["development", "test", "Development", " test "])
    assert.equal(authRequired(env({ AUTH_REQUIRED: "FALSE", NODE_ENV: nodeEnv })), false, `NODE_ENV=${nodeEnv}`);
});
