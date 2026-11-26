import assert from "node:assert/strict";
import test from "node:test";
import {
  emailSignUpAllowed,
  isEmailSignUp,
  isSsoCallback,
  signUpEmailsFromEnv,
  ssoEmailAllowed,
  ssoPolicyFromEnv,
  ssoSignUpAllowed,
} from "./sso-policy.js";

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

test("email sign-up: only invited addresses, ignoring case and surrounding whitespace", () => {
  const invited = signUpEmailsFromEnv({ SIGNUP_ALLOWED_EMAILS: " Dev@Example.com ,, x@y.io " });
  assert.equal(invited.size, 2);
  assert.equal(emailSignUpAllowed("dev@example.com", invited), true);
  assert.equal(emailSignUpAllowed("  DEV@EXAMPLE.COM ", invited), true);
  assert.equal(emailSignUpAllowed("x@y.io", invited), true);
  assert.equal(emailSignUpAllowed("dev@example.com.evil.io", invited), false);
  assert.equal(emailSignUpAllowed("other@example.com", invited), false);
  assert.equal(emailSignUpAllowed("", invited), false);
  assert.equal(emailSignUpAllowed(undefined, invited), false);
  assert.equal(emailSignUpAllowed({ toString: () => "dev@example.com" }, invited), false);
});

test("email sign-up is closed by default, and the SSO domain does not open it", () => {
  const closed = signUpEmailsFromEnv({ SSO_ALLOWED_DOMAIN: "lightbound.uk", SSO_ALLOWED_EMAILS: "dev@example.com" });
  assert.equal(closed.size, 0);
  assert.equal(emailSignUpAllowed("josh@lightbound.uk", closed), false);
  assert.equal(emailSignUpAllowed("dev@example.com", closed), false);
});

test("only the email sign-up endpoint counts as email sign-up", () => {
  assert.equal(isEmailSignUp("/sign-up/email"), true);
  assert.equal(isEmailSignUp("/api/auth/sign-up/email"), true);
  assert.equal(isEmailSignUp("/sign-in/email"), false);
  assert.equal(isEmailSignUp("/callback/google"), false);
  assert.equal(isEmailSignUp(undefined), false);
});
