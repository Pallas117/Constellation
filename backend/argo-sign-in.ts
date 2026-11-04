// One Argo sign-in for the Gauss app (Josh, 4 Nov 2026): the same Cloudflare Access team that signs people into
// lightbound.uk/app/ and the staff site sits in front of the app (app.lightbound.uk, through a Cloudflare Tunnel).
// Access proves who someone is with a signed JWT in the Cf-Access-Jwt-Assertion header; this endpoint checks it with
// the website's own verifier (RS256 against the team's published keys, audience, issuer, expiry), then finds or creates
// the Gauss account for that email and starts an ordinary better-auth session. Roles, RBAC and the WebSocket checks are
// unchanged: a new account starts as "user" (the live view), and `npm run auth:set-role` still decides the rest.
//
// Never trusts a bare email header: no valid token, no session. Off unless ACCESS_TEAM_DOMAIN and ACCESS_AUD are set.
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { accessIdentity } from "../website/worker/auth.js";

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_JWKS?: string;
}

export function accessEnvFromProcess(env: NodeJS.ProcessEnv = process.env): AccessEnv {
  return {
    ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN?.trim() || undefined,
    ACCESS_AUD: env.ACCESS_AUD?.trim() || undefined,
    // Honoured by the verifier only for a *.local team domain (tests and local dev), never in production.
    ACCESS_JWKS: env.ACCESS_JWKS?.trim() || undefined,
  };
}

export const accessSignInEnabled = (env: AccessEnv): boolean => Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

/** Only same-site paths: "/operator", never "//evil.example" or "https://…". */
export function safeCallback(value: unknown): string {
  return typeof value === "string" && /^\/(?![/\\])[^\s]*$/.test(value) ? value : "/login";
}

/** The part before the @, tidied, as a starting display name ("ada.lovelace" -> "Ada Lovelace"). */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local.split(/[._-]+/).filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ") || email;
}

export function argoSignIn(env: AccessEnv = accessEnvFromProcess(), fetchImpl: typeof fetch = fetch) {
  return {
    id: "argo-sign-in",
    endpoints: {
      argoSignIn: createAuthEndpoint("/argo/sign-in", { method: "GET" }, async (ctx) => {
        const back = safeCallback(ctx.query?.callbackURL);
        const failed = `/login?error=argo`;
        if (!accessSignInEnabled(env) || !ctx.request) throw ctx.redirect(failed);
        const id = await accessIdentity(ctx.request, env, { fetchImpl });
        if (!id) throw ctx.redirect(failed);
        const adapter = ctx.context.internalAdapter;
        const found = await adapter.findUserByEmail(id.email);
        // Access checked the address (one-time code or the identity provider), so it counts as verified.
        const user = found?.user ?? (await adapter.createUser({ email: id.email, name: nameFromEmail(id.email), emailVerified: true }, ctx));
        if (!user) throw ctx.redirect(failed);
        const session = await adapter.createSession(user.id, false);
        await setSessionCookie(ctx, { session, user });
        throw ctx.redirect(back);
      }),
    },
  } satisfies BetterAuthPlugin;
}
