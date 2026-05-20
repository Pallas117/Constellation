import { supabase } from "@/integrations/supabase/client";

export async function getAccessToken(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  } catch {
    return null;
  }
}

export async function getAuthHeaders(): Promise<HeadersInit> {
  const token = await getAccessToken();
  if (!token) {
    return {};
  }
  return {
    Authorization: `Bearer ${token}`,
  };
}
