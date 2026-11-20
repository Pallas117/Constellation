/**
 * Operator passkeys (GAU-235): WebAuthn through better-auth's passkey plugin
 * with user verification required, so every sign-in and every step-up takes
 * the device's own check (Touch ID, Face ID, a fingerprint, or the device PIN
 * or passcode it falls back to). The biometric never leaves the device: the
 * server stores a credential ID and a public key, and each sign-in signs a
 * fresh server challenge. Not post-quantum: passkeys use ECDSA P-256 or
 * Ed25519. Docs: docs/OPERATOR_PASSKEYS.md.
 */

/** better-auth paths (relative to /api/auth) the hooks in better-auth.ts act on. */
export const PASSKEY_SIGN_IN_PATH = "/passkey/verify-authentication";
export const PASSKEY_SIGN_IN_OPTIONS_PATH = "/passkey/generate-authenticate-options";

/** How recent the last passkey touch must be for an admin action (step-up). */
export const STEP_UP_MAX_AGE_MS = 5 * 60_000;

/**
 * Server-side idle limit: a session nobody uses for this long expires. Sliding,
 * refreshed at most every SESSION_REFRESH_SECONDS. The console also signs
 * operators out after a few idle minutes (frontend/src/lib/idle.ts).
 */
export const SESSION_IDLE_SECONDS = 12 * 60 * 60;
export const SESSION_REFRESH_SECONDS = 15 * 60;

export const USER_VERIFICATION_REQUIRED =
  "This passkey did not verify you (Touch ID, Face ID, fingerprint or device PIN). Use one that does.";

export interface PasskeyConfig {
  /** WebAuthn relying party ID: the site's host name, e.g. "localhost". */
  rpID: string;
  /** Page origins allowed to run passkey ceremonies. Empty means passkeys are off. */
  origins: string[];
  /** Configured origins that cannot use this RP ID (insecure, or another host). */
  rejected: string[];
}

/**
 * WebAuthn runs only in a secure context (https, or http on localhost), and
 * the RP ID must be the page's host or a parent domain of it. Anything else
 * would fail in the browser; dropping it here keeps the server from accepting
 * a ceremony for an origin it never meant to serve.
 */
export function passkeyOriginAllowed(origin: string, rpID: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false; // no path, query, trailing slash or credentials
  const host = url.hostname;
  const secure = url.protocol === "https:" || (url.protocol === "http:" && host === "localhost");
  return secure && (host === rpID || host.endsWith(`.${rpID}`));
}

/**
 * PASSKEY_RP_ID (default "localhost") and PASSKEY_ORIGINS (default: the CORS
 * origins), filtered to the origins that can use that RP ID. One RP ID per
 * deployment: a passkey made at localhost does not work at another host name.
 */
export function passkeyConfigFrom(env: Record<string, string | undefined>, trustedOrigins: readonly string[]): PasskeyConfig {
  const rpID = (env.PASSKEY_RP_ID ?? "").trim().toLowerCase() || "localhost";
  const candidates = env.PASSKEY_ORIGINS?.trim() ? env.PASSKEY_ORIGINS.split(",") : trustedOrigins;
  const origins: string[] = [];
  const rejected: string[] = [];
  for (const raw of candidates) {
    const origin = raw.trim();
    if (!origin) continue;
    (passkeyOriginAllowed(origin, rpID) ? origins : rejected).push(origin);
  }
  return { rpID, origins: [...new Set(origins)], rejected };
}

/** The credential ID a passkey sign-in verified: the plugin looks the passkey up by `response.id`. */
export function passkeyCredentialFrom(body: unknown): string | null {
  const response = (body as { response?: unknown } | null | undefined)?.response;
  const id = (response as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" && id.length > 0 && id.length <= 1024 ? id : null;
}

/** Epoch milliseconds from a stored date (Date, ISO string or number), or null. */
export function toMillis(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** True when the session was opened by a passkey touch within the step-up window. */
export function stepUpFresh(passkeyAt: number | null | undefined, now = Date.now(), maxAgeMs = STEP_UP_MAX_AGE_MS): boolean {
  if (typeof passkeyAt !== "number") return false;
  const age = now - passkeyAt;
  return age >= -30_000 && age <= maxAgeMs; // 30 s of clock skew between rows and this process
}
