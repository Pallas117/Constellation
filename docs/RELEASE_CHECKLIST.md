# Release Checklist

## Versioning Strategy

Use semantic versioning with `vX.Y.Z` tags:

- `major` (`X`): breaking API/schema changes.
- `minor` (`Y`): backward-compatible feature additions.
- `patch` (`Z`): backward-compatible fixes/hardening.

Pre-release builds:

- `vX.Y.Z-rc.N` for release candidates.

## Pre-Release Gates

1. Branch state:
   - release from `main`.
   - working tree clean (no unstaged/untracked release artifacts).
2. Quality gates:
   - `npm run audit:adherence`
3. Security gates:
   - `npm run check:security-compliance`
   - optional runtime RBAC check:
     - `npm run test:rbac`
4. Data/backend gates:
   - Supabase migrations are applied in target environment.
   - backend starts and `/health` responds.
5. CI gates:
   - `CI Tests` workflow green on release commit.
6. Secrets:
   - no secrets in tracked files.
   - keys rotated if previously exposed.

## Release Commands

```bash
# Run full release preflight
npm run release:check

# Create and push an annotated tag
npm run release:tag -- v0.1.0
```

## Post-Release Verification

1. Confirm tag published on origin:
   - `git ls-remote --tags origin | tail`
2. Re-run smoke checks in deployed environment:
   - backend `/health`
   - protected endpoint authorization checks
3. Record release notes:
   - scope
   - migration impact
   - rollback notes
