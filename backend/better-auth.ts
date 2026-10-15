import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

// Google Workspace SSO. Enabled only when both credentials are set (server
// .env); the login page hides the button otherwise. Redirect URI to register
// in Google Cloud: <BETTER_AUTH_URL>/api/auth/callback/google
const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
export const ssoGoogleEnabled = Boolean(googleClientId && googleClientSecret);
export const ssoAllowedDomain = (process.env.SSO_ALLOWED_DOMAIN ?? "lightbound.uk").trim().toLowerCase();

/** SSO may only create accounts for the Workspace domain (enforced here, not just hinted to Google). */
export function ssoEmailAllowed(email: string | null | undefined): boolean {
    return typeof email === "string" && email.toLowerCase().endsWith(`@${ssoAllowedDomain}`);
}

export const auth = betterAuth({
    database: sqlite,
    trustedOrigins,
    emailAndPassword: {  
        enabled: true
    },
    socialProviders: ssoGoogleEnabled
        ? {
              google: {
                  clientId: googleClientId!,
                  clientSecret: googleClientSecret!,
                  prompt: "select_account",
              },
          }
        : {},
    databaseHooks: {
        user: {
            create: {
                before: async (user, ctx) => {
                    // New accounts from Google must be on the Workspace domain.
                    // Email/password sign-up stays open and starts as "user".
                    if (ctx?.path?.includes("/callback/google") && !ssoEmailAllowed(user.email)) {
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
