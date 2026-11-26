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

/**
 * Trimmed, lower-cased address, or null if it is not a string of printable
 * ASCII. Only ASCII is case-folded: JavaScript's toLowerCase maps e.g. the
 * Kelvin sign (U+212A) to "k", so a non-ASCII look-alike could otherwise fold
 * onto an allowed domain or invited address. Full-width "＠" (U+FF20) and other
 * look-alikes are refused the same way.
 */
function normaliseEmail(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const trimmed = email.trim();
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function ssoEmailAllowed(email: string | null | undefined, policy: SsoPolicy): boolean {
  const normalised = normaliseEmail(email);
  if (normalised === null) return false;
  return normalised.endsWith(`@${policy.domain}`) || policy.emails.has(normalised);
}

/** The SSO providers Gauss accepts accounts from (better-auth provider ids). */
const SSO_PROVIDERS: ReadonlySet<string> = new Set(["google", "github"]);

/**
 * Is this better-auth's OAuth callback for Google or GitHub?
 * better-auth hands hooks the route TEMPLATE as ctx.path ("/callback/:id",
 * better-auth 1.5.5 dist/api/to-auth-endpoints.mjs `path: endpoint.path`) and
 * the provider in ctx.params.id. A literal path (/callback/google) is also
 * accepted for callers that pass the request path.
 */
export function isSsoCallback(path: string | null | undefined, params?: unknown): boolean {
  if (typeof path !== "string") return false;
  if (/\/callback\/(google|github)$/.test(path)) return true;
  if (!/\/callback\/:id$/.test(path)) return false;
  const id = params && typeof params === "object" ? (params as Record<string, unknown>).id : undefined;
  return typeof id === "string" && SSO_PROVIDERS.has(id);
}

export function ssoSignUpAllowed(
  user: { email?: string | null; emailVerified?: boolean | null },
  policy: SsoPolicy,
): boolean {
  return user.emailVerified === true && ssoEmailAllowed(user.email, policy);
}

// Email/password sign-up is by invitation: only the exact addresses listed in
// SIGNUP_ALLOWED_EMAILS (comma list) may create an account. The default is an
// empty list, so sign-up is closed. A whole domain is deliberately not enough
// here: unlike SSO, nobody has verified that the person owns the address.
// Existing accounts and sign-in are unaffected.
// Local dev: put your own address in .env, e.g. SIGNUP_ALLOWED_EMAILS=dev@example.com

export function signUpEmailsFromEnv(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(
    (env.SIGNUP_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Path of better-auth's email/password sign-up endpoint. */
export function isEmailSignUp(path: string | null | undefined): boolean {
  return typeof path === "string" && /\/sign-up\/email$/.test(path);
}

export function emailSignUpAllowed(email: unknown, invited: ReadonlySet<string>): boolean {
  const normalised = normaliseEmail(email);
  return normalised !== null && invited.has(normalised);
}

/** The part of better-auth's endpoint context the user.create hook reads. */
export interface UserCreateContext {
  path?: string | null;
  params?: unknown;
}

/**
 * user.create is deny-by-default: a Gauss account row is written only by
 *  - a Google/GitHub OAuth callback whose provider-verified email passes the SSO policy, or
 *  - the email/password sign-up endpoint for an invited address.
 * Everything else is refused, including /sign-in/social with an idToken
 * (better-auth creates the user there, outside the callback), any route a
 * future plugin adds, and calls with no endpoint context. Admin tooling does
 * not create users (auth:set-role only UPDATEs an existing row); a new account
 * comes from an invite plus sign-up, never from a hook bypass.
 */
export function userCreateAllowed(
  user: { email?: string | null; emailVerified?: boolean | null },
  ctx: UserCreateContext | null | undefined,
  policy: SsoPolicy,
  invited: ReadonlySet<string>,
): boolean {
  if (!ctx || typeof ctx !== "object") return false;
  if (isSsoCallback(ctx.path, ctx.params)) return ssoSignUpAllowed(user, policy);
  if (isEmailSignUp(ctx.path)) return emailSignUpAllowed(user.email, invited);
  return false;
}
