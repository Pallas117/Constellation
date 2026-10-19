# Worktree workflow

Several people and agents work on this repo in parallel, each in their own git worktree. This page covers where checkouts live, how to start and finish a piece of work, and the rules that keep parallel work from colliding.

## Where checkouts live

| Kind | Location | Rules |
| -- | -- | -- |
| Main checkout | the repo folder | Integration only. Don't commit here, and don't touch its uncommitted files. |
| Worktrees | `<main checkout>.worktrees/<branch>`, with `/` in the branch written as `__` | Create with `npm run wt:create`; one branch per worktree. |
| Live deploy | `<main checkout>.worktrees/live` | Detached at the deployed commit and changed only through the deploy runbook (`scripts/ops/gauss-services.sh`). Never pruned. |
| Claude desktop sessions | `<main checkout>/.claude/worktrees/<random-name>` | Created by the app, one per session, on a placeholder `claude/<name>` branch; the work branch is checked out inside. The app removes them when the session is archived. |

On the dev Mac, look paths up with `gauss-where constellation` and `gauss-where constellation-live` instead of hard-coding them. The checkout folder name contains a space, so quote every path.

## Start work

1. **Pick the Linear issue and use its branch name** (`jzwnathan/gau-<n>-…`), so the PR links to it automatically. Without an issue, use `<type>/<name>` (`fix/`, `chore/`, `docs/`, `ops/`).
2. **Create the worktree:** `npm run wt:create -- <branch>`. It fetches first and branches from `origin/main`, not from your local `main`, which may be stale. The new branch has no upstream until its first push.
3. **Install:** Node 22 (`.nvmrc`), then `npm ci`. That also builds the native MHD module.

## While you work

- **Push early and open a draft PR.** Nothing should exist only on one machine. Put `Part of GAU-<n>` (or `Fixes GAU-<n>` when the PR completes the issue) in the description. GitHub closes only the first issue in `Fixes #a, #b`, so give each issue its own keyword.
- **In a shared folder, run `git pull --ff-only` before committing.**
- **Run the local gate** before asking for review, because GitHub Actions are disabled: `npm test` and `npm run build`, plus `go test ./...` in `tools/argo` if you touched it. Put the results in the PR.
- **Keep work in progress small:** about 8 open PRs at a time. Stack PRs only when you have to, and merge stacks bottom-up. When a base merges, retarget the next PR to `main` and merge `main` into it. Don't rebase branches you've already pushed.

## Finish

- **After the PR merges, remove the worktree:** `npm run wt:remove -- <branch>`. On the dev Mac, `gauss-wt-prune --apply` removes every worktree whose PR is merged or closed, provided it's clean, fully pushed and not in use. It dry-runs without `--apply`.
- **Delete merged branches** locally and on GitHub, with the maintainer's OK.
- **Check the state:** `gauss-wt-prune --report` (dev Mac) lists every worktree with its uncommitted files, unpushed commits, how far it is behind its GitHub branch and `main`, its PR, and whether it's in use.

## Commands

| Command | What it does |
| -- | -- |
| `npm run wt:create -- <branch> [base]` | Fetch, then create `<main checkout>.worktrees/<branch>` from `origin/main` (or `base`). Reuses the branch if it already exists locally or on GitHub. |
| `npm run wt:list` | List worktrees. |
| `npm run wt:status` | Show each worktree's branch, number of changed files and upstream. |
| `npm run wt:sync` | Fetch once (worktrees share one repository), then show status. |
| `npm run wt:remove -- <branch\|path>` | Remove a worktree (refuses if it has changes). |
| `npm run wt:prune` | Drop metadata for worktrees whose folders are gone. |
| `npm run wt:doctor` | Show the repo root, worktree home and any stale metadata. |

## Safety rules

- Never remove the main checkout or the live worktree.
- One branch per worktree; git refuses to check out the same branch twice.
- No force pushes, and no `git reset --hard` on shared branches.
- Never commit build output (`build/`, `dist/`, `*.o`), `.env*`, `.auth.db` or `data/mesh/`.
