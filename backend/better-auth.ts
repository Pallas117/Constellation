import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    PASSKEY_SIGN_IN_OPTIONS_PATH,
    PASSKEY_SIGN_IN_PATH,
    SESSION_IDLE_SECONDS,
    SESSION_REFRESH_SECONDS,
    USER_VERIFICATION_REQUIRED,
    passkeyConfigFrom,
    passkeyCredentialFrom,
} from "./passkey-policy.js";
import { createDeviceMemory } from "./pattern/device.js";
import { isSsoCallback, ssoEmailAllowed as policyAllows, ssoPolicyFromEnv, ssoSignUpAllowed } from "./sso-policy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize a local SQLite db for better-auth. The admin roles route reads it too.
const sqlite = new Database(path.join(__dirname, "../.auth.db"));
export const authDb = sqlite;

// The pattern once a day per passkey (backend/pattern/device.ts): read by the sign-in hook below.
export const patternDeviceMemory = createDeviceMemory(sqlite);

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

// Passkeys (GAU-235, backend/passkey-policy.ts): one RP ID per deployment,
// default localhost, so they work at http://localhost:8080 on the Mac. The
// tailnet share is plain HTTP, where browsers refuse WebAuthn.
export const passkeyConfig = passkeyConfigFrom(process.env, trustedOrigins);

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
    session: {
        expiresIn: SESSION_IDLE_SECONDS,
        updateAge: SESSION_REFRESH_SECONDS,
        additionalFields: {
            // Set only by a verified passkey sign-in (hook below); step-up reads it.
            passkeyAt: { type: "date", required: false, input: false },
            passkeyCredentialId: { type: "string", required: false, input: false },
            // Set only by drawing the operator pattern (backend/pattern/router.ts).
            patternAt: { type: "date", required: false, input: false },
            // Set when the drawing was the duress pattern (backend/pattern/sensor.ts); never shown to the session.
            duressAt: { type: "date", required: false, input: false },
        },
    },
    plugins: [
        passkey({
            rpID: passkeyConfig.rpID,
            rpName: "Gauss Aurora",
            // Pinned: without it the plugin trusts whatever Origin the request carries.
            origin: passkeyConfig.origins,
            // Discoverable (one touch, no email typed) and always verifying the person.
            authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
            // The plugin verifies with requireUserVerification: false; refuse a
            // touch that did not verify the person before anything is stored or a
            // session is created.
            registration: {
                afterVerification: ({ verification }) => {
                    if (!verification.registrationInfo?.userVerified) {
                        throw new APIError("BAD_REQUEST", { message: USER_VERIFICATION_REQUIRED });
                    }
                },
            },
            authentication: {
                afterVerification: ({ verification }) => {
                    if (!verification.authenticationInfo.userVerified) {
                        throw new APIError("UNAUTHORIZED", { message: USER_VERIFICATION_REQUIRED });
                    }
                },
            },
        }),
    ],
    hooks: {
        after: createAuthMiddleware(async (ctx) => {
            if (ctx.path === PASSKEY_SIGN_IN_OPTIONS_PATH) {
                // The plugin asks the browser for "preferred"; ask for the
                // biometric or PIN outright (the server enforces it either way).
                const options = ctx.context.returned;
                if (options && typeof options === "object" && "challenge" in options) {
                    return ctx.json({ ...options, userVerification: "required" });
                }
                return;
            }
            if (ctx.path === PASSKEY_SIGN_IN_PATH) {
                // A passkey sign-in (or step-up) replaces this browser's
                // previous session; revoke it rather than leave it valid.
                const fresh = ctx.context.newSession;
                const previous = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
                if (fresh && previous && previous !== fresh.session.token) {
                    // A step-up keeps the pattern this browser already drew for the same operator,
                    // and a duress mark with it: a fresh touch must never wash the alarm away.
                    const before = await ctx.context.internalAdapter.findSession(previous);
                    const was = before?.session as { patternAt?: unknown; duressAt?: unknown } | undefined;
                    if (before?.user.id === fresh.user.id && (was?.patternAt || was?.duressAt)) {
                        await ctx.context.internalAdapter.updateSession(fresh.session.token, {
                            ...(was?.patternAt ? { patternAt: was.patternAt } : {}),
                            ...(was?.duressAt ? { duressAt: was.duressAt } : {}),
                        } as Record<string, unknown>);
                        await ctx.context.internalAdapter.deleteSession(previous);
                        return;
                    }
                    await ctx.context.internalAdapter.deleteSession(previous);
                }
                // Coming back with the same passkey within the day: the pattern was drawn on it already.
                const credential = (fresh?.session as { passkeyCredentialId?: unknown } | undefined)?.passkeyCredentialId;
                if (fresh && typeof credential === "string" && patternDeviceMemory.fresh(fresh.user.id, credential)) {
                    await ctx.context.internalAdapter.updateSession(fresh.session.token, { patternAt: new Date() } as Record<string, unknown>);
                }
            }
        }),
    },
    databaseHooks: {
        session: {
            create: {
                before: async (session, ctx) => {
                    // Only a verified passkey sign-in marks a session; strip the
                    // fields from every other session so nothing else can set them.
                    const { passkeyAt: _at, passkeyCredentialId: _credential, patternAt: _drew, duressAt: _duress, ...rest } = session as typeof session & {
                        passkeyAt?: unknown;
                        passkeyCredentialId?: unknown;
                        patternAt?: unknown;
                        duressAt?: unknown;
                    };
                    const credentialId = ctx?.path === PASSKEY_SIGN_IN_PATH ? passkeyCredentialFrom(ctx.body) : null;
                    return { data: credentialId ? { ...rest, passkeyAt: new Date(), passkeyCredentialId: credentialId } : rest };
                },
            },
        },
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
            // When the operator pattern was set (backend/pattern/); null when there is none.
            patternSetAt: { type: "date", required: false, input: false },
        },
    },
});

/**
 * Adds missing better-auth tables and columns (the passkey table, the session
 * passkey fields). Additive only, safe to re-run; the backend calls it before
 * it listens so a deploy never serves code ahead of its auth schema.
 */
export async function ensureAuthSchema(): Promise<string[]> {
    const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(auth.options);
    const changes = [
        ...toBeCreated.map((table) => `created ${table.table}`),
        ...toBeAdded.map((table) => `added columns to ${table.table}`),
    ];
    if (changes.length > 0) await runMigrations();
    return changes;
}

/** Marks a session as having drawn the operator pattern (backend/pattern/router.ts); null clears it. */
export async function markSessionPattern(sessionToken: string, at: Date | null): Promise<void> {
    const { internalAdapter } = await auth.$context;
    await internalAdapter.updateSession(sessionToken, { patternAt: at } as Record<string, unknown>);
}

/** Marks a session as signed in under duress (backend/pattern/sensor.ts). */
export async function markSessionDuress(sessionToken: string, at: Date): Promise<void> {
    const { internalAdapter } = await auth.$context;
    await internalAdapter.updateSession(sessionToken, { duressAt: at } as Record<string, unknown>);
}

/** Records on the user when their operator pattern was set, or null after it is cleared. */
export async function markUserPattern(userId: string, setAt: Date | null): Promise<void> {
    const { internalAdapter } = await auth.$context;
    await internalAdapter.updateUser(userId, { patternSetAt: setAt } as Record<string, unknown>);
}

/** The secret better-auth signs sessions with; the pattern pepper is derived from it. */
export async function authSecret(): Promise<string> {
    return (await auth.$context).secret;
}

/** The public key of the user's newest passkey (base64), or null. */
export function newestPasskeyKey(userId: string): string | null {
    try {
        const row = sqlite
            .prepare<[string], { publicKey: string }>("SELECT publicKey FROM passkey WHERE userId = ? ORDER BY createdAt DESC LIMIT 1")
            .get(userId);
        return row?.publicKey ?? null;
    } catch {
        return null; // before ensureAuthSchema has made the passkey table
    }
}
