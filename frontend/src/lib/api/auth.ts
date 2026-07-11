import { authClient } from "@/lib/auth-client";

export async function getAccessToken(): Promise<string | null> {
  try {
    const sessionResp = await authClient.getSession();
    // Normalize shapes: support session, data.session, or returned directly
    const maybeSession = (sessionResp as any)?.session ?? (sessionResp as any)?.data?.session ?? sessionResp;
    const token = maybeSession?.access_token ?? maybeSession?.access_token ?? maybeSession?.session?.access_token ?? null;
    return token ?? null;
  } catch {
    return null;
  }
}

export async function getAuthHeaders(): Promise<HeadersInit> {
  const token = await getAccessToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}
