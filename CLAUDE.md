# Gauss Aurora — Claude Code notes

@AGENTS.md

## Repo facts
- Node 22 (`.nvmrc`), matching CI. Native modules (better-sqlite3) must be built with the same Node that runs them.
- Backend tests: `npm test` (node:test via tsx, writes bedrock data to a temp dir). Type check: `npm run quality:types` (strict tsc on the frontend, backend, e2e tests and scripts; keep it at 0 errors). Full gate: `npm run audit:adherence`.
- Frontend: `npm run dev` (8080), backend: `npm run dev:proxy` (3001), build: `npm run build`.
- Auth is better-auth on `.auth.db` (email/password + Google Workspace SSO when `GOOGLE_CLIENT_ID/SECRET` are set; SSO sign-ups limited to `SSO_ALLOWED_DOMAIN`). `npm run auth:migrate`, then `npm run auth:set-role -- <email> <user|staff|operator|admin>`.
- Roles (each includes the ones below): user = live visualisation; staff = + Mesh onboarding of own devices; operator = + operator console and team status; admin = + manage roles and any device. New accounts are `user`.
- Public API routes are an explicit allowlist (`PUBLIC_READ_PATHS` in backend/server.ts). Never let the UI poll a route the role can't use: CyberTiger counts 401/403s and auto-blocks the IP.
- `tools/argo/` is a standalone Go module (`go test ./...`); see its README.
- Always-on local services: `scripts/ops/gauss-services.sh install|status|restart|uninstall` runs the backend (:3001) and built frontend (:8080) as LaunchAgents from a dedicated checkout (`Gauss Aurora.worktrees/live`), logs in `~/Library/Logs/gauss/`. To deploy new code there: merge it to main, `scripts/ops/gauss-services.sh gates record <clean checkout at the sha>` (runs the five gates under the gate lock and records them by tree), then `scripts/ops/gauss-services.sh deploy <sha>`; it refuses commits not on origin/main or without a passing record unless `--emergency <reason>` (texted and recorded). `check` shows who deployed live and with which gates. It refreshes the fallback, switches live (keeping its data), and rolls back by itself if the services don't come up. Ops events (watchdog, failover, deploys, alerts, boots) are JSON lines in `~/Library/Logs/gauss/events.jsonl`: `scripts/ops/gauss-services.sh events --since 2h`.

## Working rules
- Branch from `origin/main` in your own worktree: `npm run wt:create -- <branch>`. For Linear issues use the issue's branch name (e.g. `jzwnathan/gau-6-…`) so the PR links to it; otherwise `<type>/<name>`. See `docs/WORKTREE_ARCHITECTURE.md`.
- Push early as a draft PR (nothing only on one machine); `git pull --ff-only` before committing in a shared folder; keep about 8 PRs open at most and merge stacks bottom-up.
- PR descriptions follow `.github/pull_request_template.md`, including the `### Developer Score` section CI validates.
- Never commit `.env*`, `.auth.db` or `data/mesh/`; never weaken TLS or put tokens in URLs.
