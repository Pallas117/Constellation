import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { apiOrigin } from "@/lib/api/base-url";
import { passkeyErrorMessage, type PasskeyAction } from "@/lib/passkey-support";

export const authClient = createAuthClient({
  baseURL: apiOrigin(),
  // Passkeys (GAU-235): sign-in, step-up and registration with Touch ID, Face ID or a fingerprint.
  plugins: [passkeyClient()],
});

export const { signIn, signOut, useSession } = authClient;

/** The credential a passkey session was opened with (backend/better-auth.ts sets it; the client's types don't declare it). */
export function passkeyCredentialOf(session: unknown): string | null {
  const value = (session as { passkeyCredentialId?: unknown } | null | undefined)?.passkeyCredentialId;
  return typeof value === "string" && value ? value : null;
}

/**
 * One passkey touch: the browser asks for Touch ID, Face ID or a fingerprint
 * and the server opens a fresh session (sign-in, or step-up when already
 * signed in). Resolves to the signed-in user, or an error message to show.
 */
export async function passkeyTouch(
  action: Exclude<PasskeyAction, "add"> = "sign-in",
): Promise<{ userId: string; user: unknown; session: unknown } | { error: string }> {
  const result = await authClient.signIn.passkey();
  if (result.error || !result.data) return { error: passkeyErrorMessage(result.error as { code?: string; message?: string } | null, action) };
  const { user, session } = result.data as { user?: { id?: string }; session?: unknown };
  return user?.id ? { userId: user.id, user, session } : { error: passkeyErrorMessage(null, action) };
}
