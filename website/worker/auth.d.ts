// Types for auth.js, so the Gauss backend (strict TypeScript) can reuse the one Access verifier instead of keeping a
// second copy of the crypto (docs/CRYPTO_INVENTORY.md lists it once).
export interface AccessVerifierEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_JWKS?: string;
}

export function accessIdentity(
  request: { headers: { get(name: string): string | null } },
  env: AccessVerifierEnv,
  options?: { fetchImpl?: typeof fetch; now?: number },
): Promise<{ email: string } | null>;

export function isAdmin(env: { ADMIN_EMAILS?: string }, email: string | null | undefined): boolean;
export function isStaff(env: { ADMIN_EMAILS?: string; STAFF_EMAILS?: string }, email: string | null | undefined): boolean;
export function isCleared(env: { TURNSTONE_EMAILS?: string }, email: string | null | undefined): boolean;
