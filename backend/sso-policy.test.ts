import assert from "node:assert/strict";
import test from "node:test";
import { isSsoCallback, ssoEmailAllowed, ssoPolicyFromEnv, ssoSignUpAllowed } from "./sso-policy.js";

const policy = ssoPolicyFromEnv({ SSO_ALLOWED_DOMAIN: "lightbound.uk", SSO_ALLOWED_EMAILS: " Dev@Example.com ,x@y.io" });

test("domain and explicit emails are allowed, case-insensitively", () => {
  assert.equal(ssoEmailAllowed("Josh@Lightbound.UK", policy), true);
  assert.equal(ssoEmailAllowed("dev@example.com", policy), true);
  assert.equal(ssoEmailAllowed("x@y.io", policy), true);
});

test("look-alike domains and other addresses are refused", () => {
  assert.equal(ssoEmailAllowed("someone@evil-lightbound.uk", policy), false);
  assert.equal(ssoEmailAllowed("lightbound.uk@gmail.com", policy), false);
  assert.equal(ssoEmailAllowed("someone@gmail.com", policy), false);
  assert.equal(ssoEmailAllowed(null, policy), false);
});

test("sign-up needs a provider-verified email", () => {
  assert.equal(ssoSignUpAllowed({ email: "josh@lightbound.uk", emailVerified: true }, policy), true);
  assert.equal(ssoSignUpAllowed({ email: "josh@lightbound.uk", emailVerified: false }, policy), false);
  assert.equal(ssoSignUpAllowed({ email: "josh@lightbound.uk" }, policy), false);
});

test("only Google and GitHub callbacks count as SSO", () => {
  assert.equal(isSsoCallback("/callback/google"), true);
  assert.equal(isSsoCallback("/api/auth/callback/github"), true);
  assert.equal(isSsoCallback("/sign-up/email"), false);
  assert.equal(isSsoCallback(undefined), false);
});

test("defaults: lightbound.uk, no extra emails", () => {
  const d = ssoPolicyFromEnv({});
  assert.equal(d.domain, "lightbound.uk");
  assert.equal(d.emails.size, 0);
});
