# Security Automation Quick Reference

## Setup (One-Time)
```bash
# Install pre-commit hooks
bash scripts/setup-pre-commit.sh

# Verify setup
pre-commit run --all-files
```

## Before Every Commit
```bash
# Run locally (skipped if pre-commit hooks installed)
npm run security:secrets
```

## Before Submitting PR
```bash
# Full security & compliance check
npm run security:full

# Or individually:
npm run lint                     # Type checking
npm run security:audit          # Dependency audit
npm run security:secrets        # Secret scan
npm run check:security-compliance # Compliance check
```

## Common Commands

### Dependency Management
| Command | Purpose |
|---------|---------|
| `npm audit` | Show all vulnerabilities |
| `npm audit --audit-level=moderate` | Show moderate+ only |
| `npm audit fix` | Auto-fix fixable vulnerabilities |
| `npm audit fix --force` | Force-upgrade (use cautiously!) |

### Secret Detection
| Command | Purpose |
|---------|---------|
| `npm run security:secrets` | Manual secret scan |
| `bash scripts/check-secrets-local.sh` | Alternative scan method |
| `pre-commit run --all-files` | Run all pre-commit hooks |

### Compliance
| Command | Purpose |
|---------|---------|
| `npm run check:security-compliance` | Validate security settings |
| `npm run test:rbac` | Test RBAC access (requires Supabase) |
| `npm run audit:adherence` | Full code adherence audit |

### Release
| Command | Purpose |
|---------|---------|
| `git tag v1.0.0` | Create release tag |
| `git push origin v1.0.0` | Push tag (triggers release workflow) |
| Check GitHub Release | Signed artifacts appear here |

## GitHub Actions Status

### Running Now
- [x] security-scan.yml — Every push + nightly
- [x] compliance-gate.yml — Every PR + push to main
- [x] code-signing.yml — On release tag

### View Results
- **GitHub.com** → Your repo → Actions tab
- **Commits** → Green ✅ / Red ❌ status indicator
- **Pull Requests** → Compliance comments on each PR

## If Something Breaks

### Dependabot PR fails tests
→ Comment `@dependabot rebase` to update

### Secret detected in commit
```bash
git reset HEAD~1 --soft
# Remove secret and commit again
```

### Compliance check fails PR
```bash
npm run check:security-compliance  # See what's wrong
# Fix the issue
git push
```

### Pre-commit hook blocking commit
```bash
# Run hook to see error
pre-commit run --all-files

# Fix issue and try again
git commit -am "fix: security issue"
```

## Automation Schedule

| Check | Frequency | Time |
|-------|-----------|------|
| Dependabot updates | Weekly | Mon 3 AM UTC |
| Secret scan | Nightly | Daily 2 AM UTC |
| CodeQL analysis | Every commit | - |
| SBOM generation | Daily (main only) | Every push |
| Compliance gate | Every PR + main push | Real-time |
| Release signing | On version tag | Real-time |

## Required for Production

✅ All compliance checks pass
✅ No high/critical vulnerabilities
✅ RBAC tests pass
✅ Security headers configured
✅ No secrets in git history
✅ SBOM generated & signed
✅ Release artifacts signed with Cosign

