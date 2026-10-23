# Contributing to Gauss Aurora

How the team shares work in this repository: the Gauss app (`frontend/`, `backend/`), the lightbound.uk site
(`website/`) and the Argo agent (`tools/argo/`). Work is planned in Linear (team GAU) and lands here as pull requests.

**This repository is public.** Anything pushed, including branches and PR text, can be read by anyone. Never push
secrets, `.env*` files, `.auth.db`, `data/mesh/`, customer or partner data, or internal documents. Team-only code
lives in separate private repositories; ask Josh for access.

## Set up

1. Use Node 22 (`.nvmrc`; `nvm use`). Native modules such as better-sqlite3 must be built by the Node that runs them.
2. Clone, then install from the lockfile:
   ```bash
   npm ci
   ```
3. Run the app: `npm run dev` (frontend, port 8080) and `npm run dev:proxy` (backend, port 3001).
   Accounts need `npm run auth:migrate` once; see the root `README.md`.
4. The website runs on its own: `node website/dev.mjs --offline` (see `website/README.md`).
5. Argo is a separate Go module: `cd tools/argo && go test ./...`.

## Make a change

1. Pick or create a Linear issue in team GAU. Use its branch name (Linear's "Copy git branch name", for example
   `<user>/gau-123-short-title`) so the PR links to the issue. Without an issue, use `<type>/<name>`, for example
   `fix/website-fonts`.
2. Branch from the latest `origin/main`, ideally in your own worktree, so other work in progress isn't disturbed:
   ```bash
   git fetch origin
   npm run wt:create -- <branch>
   ```
   See `docs/WORKTREE_ARCHITECTURE.md`.
3. Push early and open a **draft** PR, so nothing exists on only one machine. Keep it small and on one topic.
4. Fill in the PR template (`.github/pull_request_template.md`), including the `## Developer Score` section
   (`docs/DEVELOPER_SCORING_AND_ONBOARDING.md`).

## Test before review: GitHub Actions are off

The CI workflows are currently disabled, so a PR shows no checks. **Run the gates locally on the exact commit
you push, and paste the results into the PR** (counts, not just "passed"):

| Change touches | Run |
| --- | --- |
| anything in the app | `npm test`, `npm run quality:types` (must stay at 0 errors), `npm run build` |
| `website/` | `npm run test:website`, and `RELEASE=public npm run audit:website` for visible changes |
| `tools/argo/` | `go test ./...` and `gofmt -l .` in `tools/argo` |
| dependencies or config | `npm run security:secrets` too |

The full app gate is `npm run audit:adherence`. On a machine with 8 GB of memory, run one heavy job
(build, Playwright, full test suite) at a time.

Say what you didn't run and why. A PR that says "not tested" is fine. A PR that claims tests it didn't run is not.

## Review and merge

- Mark the PR ready when the gates pass, and ask for review.
- Josh reviews and merges pull requests from the team. Changes to sign-in, roles (RBAC), cryptography or TLS,
  secrets, security monitoring (CyberTiger), anything newly exposed to the public, or data deletion always need
  his review.
- Merge with a merge commit, never a force push, and only when the PR's head already contains the latest `main`.
  After someone else's PR merges, update yours from `main` and run the gates again.

## Rules that keep the project safe

- Never weaken TLS or certificate checks, and never put tokens or secrets in URLs, logs or commits.
- Public API routes are an explicit allowlist (`PUBLIC_READ_PATHS` in `backend/server.ts`). Don't let the UI poll a
  route the signed-in role can't use: CyberTiger counts 401/403 responses and blocks the IP.
- Public claims about Gauss must match the evidence. Don't call it compliant, certified, space-qualified or
  flight-ready, and label simulated and demonstration data as such.
- Fix lint and type findings instead of silencing them. If a fix is too big for your PR, open a Linear issue.

## More

- `README.md`: repository layout and setup
- `docs/ARCHITECTURE.md`: system architecture and data flow
- `docs/QUALITY_AND_TESTING_QUICK_REF.md` and `docs/QA_TEST_PLAN.md`: commands and test expectations
- `docs/DEVELOPER_SCORING_AND_ONBOARDING.md`: the Developer Score rubric
- `website/README.md`: the lightbound.uk site, its release modes and its deploy steps
