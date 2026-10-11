# Gauss Aurora — Claude Code notes

@AGENTS.md

## Repo facts
- Node 22 (`.nvmrc`), matching CI. Native modules (better-sqlite3) must be built with the same Node that runs them.
- Backend tests: `npm test` (node:test via tsx, writes bedrock data to a temp dir). Full gate: `npm run audit:adherence`.
- Frontend: `npm run dev` (8080), backend: `npm run dev:proxy` (3001), build: `npm run build`.
- Auth is better-auth on `.auth.db`: `npm run auth:migrate`, then `npm run auth:set-role -- <email> <viewer|operator|admin>`. New users are viewers.
- `tools/argo/` is a standalone Go module (`go test ./...`); see its README.

## Working rules
- Branch from `main`; for Linear issues use the issue's branch name (e.g. `jzwnathan/gau-6-…`) so the PR links to it.
- PR descriptions follow `.github/pull_request_template.md`, including the `### Developer Score` section CI validates.
- Never commit `.env*`, `.auth.db` or `data/mesh/`; never weaken TLS or put tokens in URLs.
