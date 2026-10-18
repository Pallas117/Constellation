import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSsoCallback, ssoEmailAllowed as policyAllows, ssoPolicyFromEnv, ssoSignUpAllowed } from "./sso-policy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize a local SQLite db for better-auth
const sqlite = new Database(path.join(__dirname, "../.auth.db"));

// Same origin list CORS uses; without it better-auth rejects every sign-in
// from the frontend with "Invalid origin".
const trustedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:8080,http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:8080")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

// Single sign-on. Each provider is enabled only when both of its credentials
// are set (server .env); the login page hides its button otherwise. Callback
// URLs to register with the provider:
//   Google: <BETTER_AUTH_URL>/api/auth/callback/google
//   GitHub: <BETTER_AUTH_URL>/api/auth/callback/github
// Who may create an account through SSO: backend/sso-policy.ts.
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
const githubClientId = process.env.GITHUB_CLIENT_ID?.trim();
const githubClientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
export const ssoGoogleEnabled = Boolean(googleClientId && googleClientSecret);
export const ssoGithubEnabled = Boolean(githubClientId && githubClientSecret);
const ssoPolicy = ssoPolicyFromEnv();
export const ssoAllowedDomain = ssoPolicy.domain;

/** SSO may only create accounts for the allowed domain or listed emails (enforced here, not just hinted). */
export function ssoEmailAllowed(email: string | null | undefined): boolean {
    return policyAllows(email, ssoPolicy);
}

export const auth = betterAuth({
    database: sqlite,
    trustedOrigins,
    emailAndPassword: {  
        enabled: true
    },
    socialProviders: {
        ...(ssoGoogleEnabled
            ? {
                  google: {
                      clientId: googleClientId!,
                      clientSecret: googleClientSecret!,
                      prompt: "select_account" as const,
                  },
              }
            : {}),
        ...(ssoGithubEnabled
            ? {
                  github: {
                      clientId: githubClientId!,
                      clientSecret: githubClientSecret!,
                  },
              }
            : {}),
    },
    databaseHooks: {
        user: {
            create: {
                before: async (user, ctx) => {
                    // New accounts from Google or GitHub need a provider-verified email
                    // on the allowed domain (or SSO_ALLOWED_EMAILS). Email/password
                    // sign-up stays open and starts as "user".
                    if (isSsoCallback(ctx?.path) && !ssoSignUpAllowed(user, ssoPolicy)) {
                        return false;
                    }
                    return { data: user };
                },
            },
        },
    },
    user: {
        additionalFields: {
            // input: false stops users choosing their own role at sign-up.
            // Change it with `npm run auth:set-role -- <email> <role>`.
            role: { type: "string", required: false, defaultValue: "user", input: false },
        },
    },
});
