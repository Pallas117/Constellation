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
  userCreateAllowed,
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
  assert.equal(isSsoCallback("/callback/google-evil"), false);
  assert.equal(isSsoCallback("/sign-up/email"), false);
  assert.equal(isSsoCallback(undefined), false);
});

test("the route template /callback/:id counts as SSO only for google and github", () => {
  // better-auth passes hooks the template as ctx.path and the provider in params.id.
  assert.equal(isSsoCallback("/callback/:id", { id: "google" }), true);
  assert.equal(isSsoCallback("/callback/:id", { id: "github" }), true);
  assert.equal(isSsoCallback("/callback/:id", { id: "gitlab" }), false);
  assert.equal(isSsoCallback("/callback/:id", {}), false);
  assert.equal(isSsoCallback("/callback/:id", undefined), false);
  assert.equal(isSsoCallback("/callback/:id", { id: ["google"] }), false);
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

test("plus-addressing, full-width at-sign and Kelvin-sign K do not widen the invite list", () => {
  const invited = signUpEmailsFromEnv({ SIGNUP_ALLOWED_EMAILS: "invited@example.com,kim@example.com" });
  assert.equal(emailSignUpAllowed("invited+x@example.com", invited), false);
  assert.equal(emailSignUpAllowed("invited\uFF20example.com", invited), false);
  // U+212A KELVIN SIGN lower-cases to "k" in JavaScript; refused, not folded.
  assert.equal(emailSignUpAllowed("\u212Aim@example.com", invited), false);
  assert.equal(emailSignUpAllowed("invited@example.com\u200B", invited), false);
  assert.equal(emailSignUpAllowed("kim@example.com", invited), true);
});

test("plus-addressing, full-width at-sign and Kelvin-sign K do not widen the SSO list", () => {
  assert.equal(ssoEmailAllowed("dev+x@example.com", policy), false);
  assert.equal(ssoEmailAllowed("someone\uFF20lightbound.uk", policy), false);
  assert.equal(ssoEmailAllowed("someone@lightbound.u\u212A", policy), false);
  assert.equal(ssoEmailAllowed("someone@lightbound.uk", policy), true);
});

test("user.create is deny-by-default: an unknown path is refused", () => {
  const invited = signUpEmailsFromEnv({ SIGNUP_ALLOWED_EMAILS: "invited@example.com" });
  const domainUser = { email: "josh@lightbound.uk", emailVerified: true };
  const invitedUser = { email: "invited@example.com", emailVerified: false };
  // Allowed: an SSO callback passing the policy, an invited email sign-up.
  assert.equal(userCreateAllowed(domainUser, { path: "/callback/:id", params: { id: "google" } }, policy, invited), true);
  assert.equal(userCreateAllowed(invitedUser, { path: "/sign-up/email" }, policy, invited), true);
  // Refused: the right user on any other route, or with no endpoint context.
  for (const ctx of [
    { path: "/sign-in/social" }, // better-auth creates the user here when given an idToken
    { path: "/oauth2/callback/:providerId", params: { providerId: "google" } },
    { path: "/admin/create-user" },
    { path: "/callback/:id", params: { id: "gitlab" } },
    { path: undefined },
    null,
    undefined,
  ]) {
    assert.equal(userCreateAllowed(domainUser, ctx, policy, invited), false, JSON.stringify(ctx));
    assert.equal(userCreateAllowed(invitedUser, ctx, policy, invited), false, JSON.stringify(ctx));
  }
  // The allowed routes still apply their own list.
  assert.equal(userCreateAllowed({ email: "x@gmail.com", emailVerified: true }, { path: "/callback/:id", params: { id: "google" } }, policy, invited), false);
  assert.equal(userCreateAllowed({ email: "josh@lightbound.uk", emailVerified: false }, { path: "/callback/:id", params: { id: "github" } }, policy, invited), false);
  assert.equal(userCreateAllowed({ email: "josh@lightbound.uk", emailVerified: true }, { path: "/sign-up/email" }, policy, invited), false);
});
