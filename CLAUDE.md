# Gauss Aurora — Claude Code notes

@AGENTS.md

## Repo facts
- Node 22 (`.nvmrc`), matching CI. Native modules (better-sqlite3) must be built with the same Node that runs them.
- Backend tests: `npm test` (node:test via tsx, writes bedrock data to a temp dir). Full gate: `npm run audit:adherence`.
- Frontend: `npm run dev` (8080), backend: `npm run dev:proxy` (3001), build: `npm run build`.
- Auth is better-auth on `.auth.db` (email/password + Google Workspace SSO when `GOOGLE_CLIENT_ID/SECRET` are set; SSO sign-ups limited to `SSO_ALLOWED_DOMAIN`). `npm run auth:migrate`, then `npm run auth:set-role -- <email> <user|staff|operator|admin>`.
- Roles (each includes the ones below): user = live visualisation; staff = + Mesh onboarding of own devices; operator = + operator console and team status; admin = + manage roles and any device. New accounts are `user`.
- Public API routes are an explicit allowlist (`PUBLIC_READ_PATHS` in backend/server.ts). Never let the UI poll a route the role can't use: CyberTiger counts 401/403s and auto-blocks the IP.
- `tools/argo/` is a standalone Go module (`go test ./...`); see its README.

## Working rules
- Branch from `main`; for Linear issues use the issue's branch name (e.g. `jzwnathan/gau-6-…`) so the PR links to it.
- PR descriptions follow `.github/pull_request_template.md`, including the `### Developer Score` section CI validates.
- Never commit `.env*`, `.auth.db` or `data/mesh/`; never weaken TLS or put tokens in URLs.
