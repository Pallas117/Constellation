import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_HELIO_PROXY_URL || "http://127.0.0.1:3001",
});

export const { signIn, signUp, signOut, useSession } = authClient;
