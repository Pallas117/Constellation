import { createAuthClient } from "better-auth/react";
import { apiOrigin } from "@/lib/api/base-url";

export const authClient = createAuthClient({
  baseURL: apiOrigin(),
});

export const { signIn, signUp, signOut, useSession } = authClient;
