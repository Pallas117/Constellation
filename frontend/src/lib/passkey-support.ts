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
