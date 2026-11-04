# Argo: one Lightbound login

**Argo** is the one sign-in for everything Lightbound runs: the workspace on lightbound.uk (Gauss plans, Constellation
membership, Gauss for Education), the Gauss app, and the staff operations site. Decided by Josh on 4 Nov 2026:
Cloudflare Access is the login, Turnstone gets a hidden area for approved emails only, the Gauss app gets a public
address behind Access, and the login is called Argo.

Naming (Josh, 4 Nov 2026, "Argo as the login"): people sign in *with Argo*. Argo is also the name of the operators'
connectivity agent (`/argo/`, unlisted, included for operators and staff, never sold), so one name covers signing in
and keeping devices in sync. Public copy says only "Sign in with Argo"; it never describes the agent's features, and
never claims more than the sign-in does (an emailed code from Cloudflare Access, checked here).

## How it works

```
person ── Cloudflare Access (one team: emailed one-time code, optionally Google) ── signs in once per team session
   ├─ lightbound.uk/app/        Worker checks the Access JWT (website/worker/auth.js); KV account decides what shows
   ├─ app.lightbound.uk         Cloudflare Tunnel → 127.0.0.1:8080 (vite preview, /api → backend :3001)
   │                            "Continue with Argo" → /api/auth/argo/sign-in checks the same JWT with the
   │                            same verifier and starts a normal Gauss session (backend/argo-sign-in.ts)
   └─ ops site (OPS_URL)        its own Access application in the same team (private UI-UX-Gauss repo)
```

- **Who someone is** comes only from a verified Access token (RS256 against the team's published keys, audience,
  issuer, expiry). A bare email header is never trusted. There is one verifier, `website/worker/auth.js`; the
  backend imports it.
- **What they can do** stays where it was. On the site, the KV account plus `ADMIN_EMAILS`, `STAFF_EMAILS` and
  `TURNSTONE_EMAILS` decide. In the app, the `role` column decides. A first sign-in creates the app account as
  `user` (the live view); `npm run auth:set-role -- <email> <role>` still decides the rest. An existing account
  keeps its role.
- **Turnstone** stays secret. The public `/turnstone/` page is unchanged. People in `TURNSTONE_EMAILS` (a Worker
  secret, never in this repo) see a Turnstone card in their workspace. It says no more than the public page, with
  a link to `TURNSTONE_URL` (a secret, https) or the briefing call. Admins are not cleared automatically.
- **The Gauss live view is free** with the sign-in: everyone in `/app/` sees a "Live view" card once
  `GAUSS_APP_URL` is set. Paid plans see "Open the Gauss console" on the same app. Argo and the data features
  stay with the operator plans (`backend/rbac.ts` is unchanged).

## Argo signs in viewers; operators also need a passkey on the tailnet

Draft PR #230 (GAU-235, stacked on #211 and #224, not merged) hardens the operator side. Once it merges, operator and
admin API routes also require:
- a session opened with a passkey (otherwise `428 PASSKEY_REQUIRED`);
- a request from the account owner's own device on the tailnet, checked with `tailscale whois` (otherwise
  `428 TAILNET_IDENTITY`).

An Argo session (Cloudflare Access) is not a passkey session, and requests through the Cloudflare Tunnel arrive with a
public address. So on app.lightbound.uk, Argo opens the live view and other viewer pages; the operator console lives on
the private ops.lightbound.space (tailnet only; passkeys use one RP ID per backend, and #230 makes it that host).

**Open decision (Josh):** where paid operators sign in.
- (a) The console stays tailnet-only at ops.lightbound.space with passkeys, and the workspace's "Open the Gauss
  console" button points there.
- (b) A customer-facing console path is designed separately.

Until that is decided, `GAUSS_APP_URL` should be the viewer address, and the console button should not promise more
than it opens.

## Setting it up (Josh, in dashboards; nothing here is automatic)

Zero Trust (Cloudflare dashboard > Zero Trust), once:
1. Settings > Authentication: **One-time PIN** on. Add Google as a login method too if you want it.
   Settings > Custom pages > Login page: organisation name **Argo**, logo `website/public/assets/marks/argo-glyph-provisional.svg`
   (provisional), background `#050505`, so the code screen people see says Argo.
2. Access > Applications: the existing `lightbound.uk/app` application (README, "Opening accounts later").
3. Add > Self-hosted: domain `app.lightbound.uk`. Policy: Allow, Include **Everyone** (anyone with an email can
   reach the free live view; the app's roles gate the rest). Use a narrower policy, such as an email list, if
   you'd rather keep the app closed for now. Copy this application's **AUD tag**.
4. The staff site keeps its own application and its staff-only policy.

Tunnel for the app (on the Mac that runs Gauss):
1. Zero Trust > Networks > Tunnels > Create: name `gauss-app`, public hostname `app.lightbound.uk` →
   `http://127.0.0.1:8080`. Under the hostname's HTTP settings, set **HTTP Host Header** to `127.0.0.1:8080`
   (`vite preview` accepts only local and Tailscale host names).
2. Install `cloudflared` with the token the dashboard shows, as a service. Nothing listens on a public port; the
   tunnel connects out.

Gauss backend `.env` (docs/INSTALL.md lists each one):
```
ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
ACCESS_AUD=<the app.lightbound.uk application's AUD tag>
ALLOWED_ORIGINS=https://app.lightbound.uk,http://127.0.0.1:8080
BETTER_AUTH_URL=https://app.lightbound.uk
```
Then restart the backend. The login page shows **Continue with Argo** once both Access values are set.

Website Worker:
- `vars` in `wrangler.jsonc`: `GAUSS_APP_URL` = `https://app.lightbound.uk/`.
- Secrets: `npx wrangler@4 secret put TURNSTONE_EMAILS` (comma-separated), and optionally
  `npx wrangler@4 secret put TURNSTONE_URL`.
- The site's sign-in is still closed in the public release (`RELEASE: "public"`); opening it is a separate launch
  decision (README, "Opening accounts later").

## Checks before switching it on

- Local: `npm test` covers the endpoint (`backend/argo-sign-in.test.ts`: valid token; existing role kept;
  refused when there is no token, a bare email header, a forged signature, the wrong audience, the wrong issuer, an
  expired token, `alg: none`, or Access isn't configured; local keys never honoured for a real team domain;
  same-site callbacks only). `npm run test:website` covers the Turnstone and live-view cards.
- **UNVERIFIED until done once for real**: the tunnel passing `Cf-Access-Jwt-Assertion` through `vite preview` to
  the backend; CyberTiger seeing the visitor's address through the tunnel (`X-Forwarded-For` is trusted from loopback
  only); Access's team session carrying people from lightbound.uk to app.lightbound.uk without a second code.
- Seats: Zero Trust's free plan covers 50 users (`USER_CAP` on the site). Everyone who signs in to any Lightbound
  app counts once.
