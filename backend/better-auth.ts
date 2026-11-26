import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import Database from "better-sqlite3";
import { authDbPath } from "./auth-db.js";
import {
    emailSignUpAllowed,
    isEmailSignUp,
    isSsoCallback,
    signUpEmailsFromEnv,
    ssoEmailAllowed as policyAllows,
    ssoPolicyFromEnv,
    ssoSignUpAllowed,
} from "./sso-policy.js";

// Initialize a local SQLite db for better-auth (.auth.db; tests use a throwaway file)
const sqlite = new Database(authDbPath());

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
// Email/password sign-up is invite-only: SIGNUP_ALLOWED_EMAILS (backend/sso-policy.ts).
const invitedEmails = signUpEmailsFromEnv();

/** SSO may only create accounts for the allowed domain or listed emails (enforced here, not just hinted). */
export function ssoEmailAllowed(email: string | null | undefined): boolean {
    return policyAllows(email, ssoPolicy);
}

// The client address better-auth rate-limits by. server.ts sets this header on
// every /api/auth request from CyberTiger's extractClientIp (which only trusts
// X-Forwarded-For from a loopback proxy) and overwrites any value a client sent.
export const CLIENT_IP_HEADER = "x-gauss-client-ip";

export const auth = betterAuth({
    database: sqlite,
    trustedOrigins,
    // better-auth only rate-limits by default when NODE_ENV=production, and the
    // LaunchAgents don't set it; the auth routes are also mounted before
    // CyberTiger. So always on, with tight limits on credential endpoints.
    rateLimit: {
        enabled: true,
        storage: "memory",
        window: 60,
        max: 100,
        customRules: {
            "/sign-in/email": { window: 60, max: 5 },
            "/sign-up/email": { window: 60, max: 5 },
            "/request-password-reset": { window: 300, max: 3 },
            "/reset-password": { window: 300, max: 5 },
        },
    },
    advanced: {
        ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
    },
    emailAndPassword: {  
        enabled: true
    },
    hooks: {
        // Invite-only sign-up: refuse an address that is not on the list before
        // the endpoint runs, so nothing is created. The same answer for every
        // refused address; the address itself is neither echoed nor logged.
        before: createAuthMiddleware(async (ctx) => {
            if (isEmailSignUp(ctx.path) && !emailSignUpAllowed(ctx.body?.email, invitedEmails)) {
                throw new APIError("FORBIDDEN", { message: "Sign-up is by invitation only." });
            }
        }),
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
                    // sign-up is invite-only (checked again here, where the row is
                    // written) and starts as "user".
                    if (isSsoCallback(ctx?.path) && !ssoSignUpAllowed(user, ssoPolicy)) {
                        return false;
                    }
                    if (isEmailSignUp(ctx?.path) && !emailSignUpAllowed(user.email, invitedEmails)) {
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
