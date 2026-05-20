# Worktree Architecture

## Goals

- Keep the primary repo checkout stable for integration and CI checks.
- Isolate feature and hotfix work in dedicated worktrees.
- Avoid branch/worktree collisions and stale metadata.

## Topology

- Main checkout (this folder): integration context.
- Managed worktree home (default): `../.worktrees/<repo-name>`
  - Override with `GAUSS_WORKTREE_HOME` if needed.

Branch names created through the helper are normalized:
- `foo` -> `codex/foo`
- `codex/foo` -> `codex/foo`

Worktree paths are deterministic:
- `codex/solar-feed` -> `../.worktrees/<repo-name>/codex__solar-feed`

## Commands

From repository root:

```bash
npm run wt:list
npm run wt:status
npm run wt:create -- solar-feed main
npm run wt:sync
npm run wt:remove -- codex/solar-feed
npm run wt:prune
npm run wt:doctor
```

## Recommended Daily Flow

1. Keep main checkout on `main` for merges and release checks.
2. Create a per-task worktree:
   - `npm run wt:create -- <task-name> main`
3. Work and test inside that new path.
4. Merge branch, then remove worktree:
   - `npm run wt:remove -- codex/<task-name>`
5. Run periodic cleanup:
   - `npm run wt:prune`

## Safety Rules

- Never remove the primary checkout worktree.
- Prefer one branch per worktree.
- Run `npm run wt:status` before context switching.
- Run `npm run wt:sync` at session start to fetch/prune remotes.
