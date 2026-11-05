import { authClient } from "@/lib/auth-client";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

export async function getAccessToken(): Promise<string | null> {
  try {
    const sessionResp = await authClient.getSession();
    // Normalize shapes: support session, data.session, or returned directly
    const maybeSession = field(sessionResp, "session") ?? field(field(sessionResp, "data"), "session") ?? sessionResp;
    const token = field(maybeSession, "access_token") ?? field(field(maybeSession, "session"), "access_token");
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

export async function getAuthHeaders(): Promise<HeadersInit> {
  const token = await getAccessToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}
