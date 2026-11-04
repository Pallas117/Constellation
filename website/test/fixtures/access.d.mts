// Types for access.mjs, so the Gauss backend's tests (strict TypeScript) can use the same Access stand-in.
export function makeAccess(options?: { team?: string; aud?: string; kid?: string }): Promise<{
  sign(email: string, claims?: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
  env: { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string; ACCESS_JWKS: string };
}>;
