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
   - `npm run release:prepare` (recommended)
   - `npm run audit:adherence`
3. Security gates:
   - `npm run security:full`
   - `npm run check:security-compliance`
   - optional runtime RBAC check:
     - `npm run test:rbac`
4. Data/backend gates:
   - Supabase migrations are applied in the target environment.
   - backend starts and `/health` responds.
   - release preflight executes the backend and verifies `/health` in runtime.
5. CI gates:
   - `CI Tests` workflow green on release commit.
6. Secrets:
   - no secrets in tracked files.
   - keys rotated if previously exposed.
7. Release records (GAU-69):
   - `CHANGELOG.md` has a `## [X.Y.Z]` entry for the tag (`release:tag` refuses otherwise).
   - `npm run release:sbom` passes: it writes `build/sbom/` (CycloneDX SBOMs for the runtime npm
     dependencies and Gauss Argo, `THIRD_PARTY_NOTICES.md`, `licences.md`) and fails on a copyleft or
     unrecognised licence. Record a licence a person has confirmed in `scripts/release/licence-review.json`.
   - The project's own `LICENSE` is a founder decision (GAU-65); none is applied yet.

## Release Commands

```bash
# Run full release preflight
npm run release:check

# Run comprehensive release preparation (quality + security + tests)
npm run release:prepare

# Create and push an annotated tag (needs the CHANGELOG entry; runs verify and release:sbom)
npm run release:tag -- v0.1.0

# Publish the release with its SBOMs and notices attached
gh release create v0.1.0 --verify-tag --notes-from-tag build/sbom/*
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
