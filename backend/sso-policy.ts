// Who may create an account through single sign-on (Google, GitHub).
// Enforced server-side in the better-auth user.create hook; the login page
// only hints at it.
//
// - The provider must report the email as verified (GitHub lets people add
//   addresses they don't own until they verify them).
// - The email must be on SSO_ALLOWED_DOMAIN, or listed in SSO_ALLOWED_EMAILS
//   (for teammates whose GitHub uses a personal address).
// Existing accounts are unaffected: signing in with a provider whose verified
// email matches an existing user links to that user instead of creating one.

export interface SsoPolicy {
  domain: string;
  emails: ReadonlySet<string>;
}

export function ssoPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SsoPolicy {
  return {
    domain: (env.SSO_ALLOWED_DOMAIN ?? "lightbound.uk").trim().toLowerCase(),
    emails: new Set(
      (env.SSO_ALLOWED_EMAILS ?? "")
        .split(",")
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}

export function ssoEmailAllowed(email: string | null | undefined, policy: SsoPolicy): boolean {
  if (typeof email !== "string") return false;
  const normalised = email.trim().toLowerCase();
  return normalised.endsWith(`@${policy.domain}`) || policy.emails.has(normalised);
}

/** Paths of better-auth's OAuth callbacks, e.g. /callback/google. */
export function isSsoCallback(path: string | null | undefined): boolean {
  return typeof path === "string" && /\/callback\/(google|github)\b/.test(path);
}

export function ssoSignUpAllowed(
  user: { email?: string | null; emailVerified?: boolean | null },
  policy: SsoPolicy,
): boolean {
  return user.emailVerified === true && ssoEmailAllowed(user.email, policy);
}
