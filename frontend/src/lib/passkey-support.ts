/**
 * Can this page sign in with a passkey? WebAuthn needs a secure context
 * (https, or http on localhost) and a page on the server's RP ID host
 * (/api/sso-options says which). Elsewhere the login page explains instead of
 * showing a button that can only fail.
 */

export type PasskeySupport =
  | { ok: true }
  | { ok: false; reason: "off" | "unsupported" | "other-host" | "insecure"; hint: string; href?: string };

export interface PasskeyEnvironment {
  /** From /api/sso-options; null when the server has passkeys off. */
  rpId: string | null;
  /** The page's URL. */
  location: { hostname: string; protocol: string; port: string; pathname: string; search: string };
  /** window.isSecureContext */
  secure: boolean;
  /** Whether the browser has WebAuthn (window.PublicKeyCredential). */
  webauthn: boolean;
}

const LOOPBACK_IPS = new Set(["127.0.0.1", "[::1]", "::1"]);

export function passkeySupport({ rpId, location, secure, webauthn }: PasskeyEnvironment): PasskeySupport {
  if (!rpId) return { ok: false, reason: "off", hint: "Passkeys aren't set up on this server yet." };
  if (!webauthn) return { ok: false, reason: "unsupported", hint: "This browser can't use passkeys." };
  const host = location.hostname.toLowerCase();
  if (host !== rpId && !host.endsWith(`.${rpId}`)) {
    if (rpId === "localhost" && LOOPBACK_IPS.has(host)) {
      const port = location.port ? `:${location.port}` : "";
      return {
        ok: false,
        reason: "other-host",
        hint: "Passkeys work at localhost, not 127.0.0.1.",
        href: `${location.protocol}//localhost${port}${location.pathname}${location.search}`,
      };
    }
    return { ok: false, reason: "other-host", hint: `Passkeys are set up for ${rpId}. Use email here.` };
  }
  if (!secure) return { ok: false, reason: "insecure", hint: "Passkeys need HTTPS; this page is plain HTTP." };
  return { ok: true };
}

/**
 * What to tell the operator when a passkey ceremony fails. The browser reports
 * a closed prompt, a timeout, "no passkey for this site on this device" and
 * "this app can't reach Touch ID" all as one NotAllowedError (SimpleWebAuthn:
 * ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY), and the plugin then says only "Auth
 * cancelled", so the message names the likely ways forward instead.
 */
export type PasskeyAction = "sign-in" | "confirm" | "add";

const ENDED_WITHOUT_A_PASSKEY = new Set([
  "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
  "ERROR_CEREMONY_ABORTED",
  "AUTH_CANCELLED",
  "REGISTRATION_CANCELLED",
]);

export function passkeyErrorMessage(error: { code?: string; message?: string } | null | undefined, action: PasskeyAction): string {
  const code = error?.code ?? "";
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") return "This device already has a passkey for this account.";
  if (ENDED_WITHOUT_A_PASSKEY.has(code)) {
    if (action === "sign-in") {
      return "No passkey was used, so nobody is signed in. No passkey on this device yet? Sign in with email below, then add one. No Touch ID prompt appeared? Open this page in Chrome or Safari.";
    }
    if (action === "confirm") return "The prompt closed before a passkey was used, so nothing was changed.";
    return "The passkey wasn't added: the prompt was closed, or this browser can't reach Touch ID. Try again, or use Chrome or Safari.";
  }
  const fallback = action === "add" ? "Could not add the passkey." : action === "confirm" ? "The passkey check failed." : "Passkey sign-in failed.";
  return error?.message?.trim() || fallback;
}
