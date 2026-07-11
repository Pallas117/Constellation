# Security & Compliance Automation Setup

This document outlines the security automation infrastructure for Gauss Aurora, implemented across 4 key pillars:

1. **Dependency Vulnerability Scanning** (Dependabot + npm audit)
2. **Secret Detection & Rotation** (TruffleHog + pre-commit hooks)
3. **Code Signing & Release Artifacts** (Cosign + SLSA provenance)
4. **Security Compliance Gating** (Automated RBAC + headers validation)

---

## 1. Dependency Vulnerability Scanning

### What It Does
- **Dependabot** automatically checks npm dependencies for known vulnerabilities weekly
- **npm audit** runs in CI on every commit, failing if high/critical vulnerabilities found
- **SBOM** (Software Bill of Materials) generated and published to GitHub Dependency Graph

### Files
- `.github/dependabot.yml` — Dependabot configuration
- `.github/workflows/security-scan.yml` — Automated npm audit + SBOM generation

### How to Use

#### Enable Dependabot on GitHub
1. Go to repository Settings → Code Security & Analysis
2. Enable "Dependabot version updates" (usually auto-enabled)
3. Dependabot will create PRs automatically on Mondays at 3 AM UTC

#### Run Locally
```bash
npm audit                          # Show all vulnerabilities
npm audit --audit-level=moderate   # Show moderate+ vulnerabilities (CI default)
npm audit fix                      # Auto-fix fixable vulnerabilities
npm audit fix --force              # Force-upgrade to fix (may break compat)
```

#### Review Dependabot PRs
- Dependabot creates separate PRs for each dependency
- Review the security advisory link before merging
- Tests must pass in CI before merging

#### Schedule (Customizable in .github/dependabot.yml)
- **npm dependencies**: Weekly on Mondays at 3 AM UTC
- **GitHub Actions**: Weekly on Mondays at 4 AM UTC
- Limit: 5 open PRs for npm, 3 for actions (prevents PR spam)

---

## 2. Secret Detection & Rotation

### What It Does
- **TruffleHog** scans every commit for API keys, tokens, credentials
- **detect-secrets** provides entropy-based secret detection with allowlist
- **Pre-commit hooks** prevent accidental secret commits locally
- **GitHub Actions** run nightly secret scans on all code

### Files
- `.github/workflows/security-scan.yml` — TruffleHog + detect-secrets CI
- `.pre-commit-config.yaml` — Local pre-commit hook configuration
- `.secrets.baseline` — detect-secrets baseline (list of known secrets to ignore)
- `scripts/check-secrets-local.sh` — Manual secret check script
- `scripts/setup-pre-commit.sh` — Pre-commit installation helper

### How to Use

#### Setup Local Pre-Commit Hooks (Recommended)
```bash
# One-time setup
bash scripts/setup-pre-commit.sh

# This installs git hooks that run before commit/push
# Checks for secrets automatically
```

#### Manual Secret Scanning
```bash
# Check for secrets locally before pushing
bash scripts/check-secrets-local.sh

# Or using npm
npm run security:secrets
```

#### Run TruffleHog Directly
```bash
# Install TruffleHog
pip install trufflehog

# Scan current directory
trufflehog filesystem . --json --only-verified

# Scan git history for the last 10 commits
trufflehog git . --since-commit HEAD~10
```

#### What Triggers Secret Scans
- **Local (Pre-commit)**: Every `git commit` if hooks installed
- **CI (GitHub Actions)**: Every push + pull request + nightly at 2 AM UTC
- **Manual**: Run `bash scripts/check-secrets-local.sh` anytime

#### If a Secret Is Detected
1. **Immediately revoke the secret** (rotate the API key/token)
2. **Clean git history**:
   ```bash
   # Remove from last commit
   git reset HEAD~1 --soft
   git add -p  # Stage only safe changes
   git commit -m "Remove secrets"
   
   # If already pushed, rotate the secret and create new commit
   git commit --allow-empty -m "chore: rotate secrets after exposure"
   ```
3. **Update .secrets.baseline** if this is a false positive:
   ```bash
   detect-secrets scan --baseline .secrets.baseline
   ```

#### Common Secret Patterns Detected
- AWS Access Keys, Azure credentials, GCP keys
- GitHub tokens, NPM tokens, PyPI tokens
- Database passwords, API keys, JWT tokens
- Private keys, certificates, encryption keys

---

## 3. Code Signing & Release Artifacts

### What It Does
- **Cosign** cryptographically signs release artifacts (SBOM, checksums)
- **SLSA v1.0 provenance** generated automatically on release
- **Checksums** created for integrity verification
- **Release notes** auto-generated from commit history

### Files
- `.github/workflows/code-signing.yml` — Signing & release automation

### How to Use

#### Create a Signed Release
1. **Tag a version** (triggers release workflow):
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. **GitHub Actions automatically**:
   - Builds the project
   - Generates SBOM (CycloneDX format)
   - Creates checksums for all artifacts
   - Signs with Cosign (keyless signing via GitHub OIDC)
   - Creates GitHub Release with signed artifacts

3. **Verify released artifacts**:
   ```bash
   # Download from release page
   wget https://github.com/YOUR_ORG/gauss-aurora/releases/download/v1.0.0/sbom.json
   wget https://github.com/YOUR_ORG/gauss-aurora/releases/download/v1.0.0/sbom.json.sig
   
   # Verify signature (requires Cosign installed)
   cosign verify-blob --signature sbom.json.sig sbom.json
   
   # Verify checksums
   wget https://github.com/YOUR_ORG/gauss-aurora/releases/download/v1.0.0/checksums.txt
   sha256sum -c checksums.txt
   ```

#### Install Cosign Locally (Optional)
```bash
# macOS
brew install cosign

# Linux
wget https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
chmod +x cosign-linux-amd64
sudo mv cosign-linux-amd64 /usr/local/bin/cosign
```

#### Versioning Strategy
Use semantic versioning:
- **Major (X)**: Breaking API changes → `v2.0.0`
- **Minor (Y)**: New backward-compatible features → `v1.1.0`
- **Patch (Z)**: Bug fixes → `v1.0.1`
- **Pre-release**: `v1.0.0-rc.1` (won't be marked as latest)

#### Release Checklist
1. Ensure all tests pass: `npm run lint && npm test`
2. Run security audit: `npm run security:full`
3. Update version in `package.json`
4. Create annotated tag: `git tag -a v1.0.0 -m "Release 1.0.0"`
5. Push tag: `git push origin v1.0.0`
6. GitHub Actions creates release with signed artifacts

---

## 4. Security Compliance Gating

### What It Does
- **Security Compliance Check**: Validates CORS, rate limiting, auth enforcement
- **RBAC Smoke Tests**: Tests viewer/operator/admin role access flows
- **Headers Validation**: Ensures security headers configured
- **Rate Limiting Validation**: Verifies rate limit config exists
- **Auto-comments PRs** with compliance status

### Files
- `.github/workflows/compliance-gate.yml` — Compliance checks on every PR
- `backend/scripts/security-compliance-check.ts` — Compliance validation logic
- `backend/scripts/rbac-smoke.ts` — RBAC role tests

### How to Use

#### Local Compliance Check
```bash
npm run check:security-compliance

# Output shows:
# ✅ CORS configured
# ✅ Rate limiting enabled
# ✅ Auth required
# ✅ Headers configured
# ...
```

#### RBAC Smoke Tests (Requires Supabase)
```bash
npm run test:rbac

# Tests:
# - Viewer can read public data ✅
# - Operator can manage APIs ✅
# - Admin can manage users ✅
# - Unauthorized blocked ✅
```

#### What Triggers Compliance Gate
- Every **pull request** (comment added with results)
- Every **push to main** (blocks merge if failed)
- Manual trigger: GitHub Actions → Compliance & Security Gate → Run workflow

#### PR Comments
When you open a PR, compliance automation will comment:
```
✅ Security Compliance: PASSED
Run `npm run check:security-compliance` locally to debug.

✅ RBAC Tests: PASSED
```

If any check fails:
```
❌ Security Compliance: REVIEW REQUIRED
Run `npm run check:security-compliance` locally to debug.
```

#### What's Checked
1. **X-Content-Type-Options**: `nosniff` header set
2. **X-Frame-Options**: `DENY` header set
3. **Referrer-Policy**: Configured
4. **Rate Limiting**: Window and max configured
5. **Auth Enforcement**: AUTH_REQUIRED=true
6. **RBAC Roles**: viewer/operator/admin functional

#### Manual Compliance Audit
```bash
npm run audit:adherence

# Full code audit checking:
# - TypeScript strict mode
# - Security headers
# - RBAC implementation
# - Crypto best practices
# - Error handling
```

---

## GitHub Actions Workflows

### Workflow Triggers

#### 1. **security-scan.yml** (Dependency + Secret Scanning)
- **Triggers**: Every push, every PR, nightly at 2 AM
- **Jobs**:
  - `secret-scanning`: TruffleHog scan (all commits)
  - `dependency-audit`: npm audit (fails on high/critical)
  - `codeql`: GitHub CodeQL for code vulnerabilities
  - `sbom`: Generate CycloneDX SBOM (only on main branch)
- **Artifacts**: SBOM JSON file (90-day retention)

#### 2. **compliance-gate.yml** (Security Compliance)
- **Triggers**: Every PR, every push to main
- **Jobs**:
  - `security-compliance`: Run compliance check script
  - `rbac-smoke-test`: RBAC role tests
  - `headers-validation`: Check security headers in code
  - `rate-limit-config`: Verify rate limiting configured
  - `status-check`: Aggregate all results
- **PR Comments**: Compliance status on every PR

#### 3. **code-signing.yml** (Release Signing)
- **Triggers**: On git tag push (v*), manual dispatch
- **Jobs**:
  - `sign-release`: Build, sign artifacts with Cosign
  - `slsa-provenance`: Generate SLSA v1.0 provenance
  - `publish-sbom`: Publish SBOM to GitHub
- **Outputs**: Signed artifacts on GitHub Release page

---

## Common Tasks

### Check Security Status
```bash
# Run all security checks locally
npm run security:full

# Individual checks:
npm run lint                           # TypeScript type check
npm run security:audit                 # npm audit
npm run security:secrets               # TruffleHog scan
npm run check:security-compliance      # Compliance check
npm run test:rbac                      # RBAC tests
```

### Review Dependabot PR
1. Click notification or check Pull Requests tab
2. Read the security advisory (link in PR description)
3. Check if tests pass
4. Merge if safe, or request Dependabot to update

### Rotate a Compromised Secret
```bash
# 1. Revoke the old secret in the service
# 2. Create new secret in service
# 3. Update local .env
export NEW_API_KEY="xxx"

# 4. Verify no staging changes contain old secret
npm run security:secrets

# 5. Commit the new secret (safely)
git add .env
git commit -m "chore: rotate API key after security review"
git push
```

### Fix a Failed PR Compliance Check
```bash
# 1. Run locally to see specific issues
npm run check:security-compliance

# 2. Fix any issues in code/config
# 3. Re-run to verify
npm run check:security-compliance

# 4. Push fix
git commit -am "fix: security compliance issues"
git push
```

### Create a Signed Release
```bash
# 1. Ensure all checks pass
npm run lint
npm run test
npm run security:full

# 2. Tag the release
git tag v1.0.0
git push origin v1.0.0

# 3. GitHub Actions automatically:
#    - Builds project
#    - Generates SBOM
#    - Signs artifacts
#    - Creates GitHub Release

# 4. Verify artifacts (GitHub Release page shows signed artifacts)
```

---

## Environment Variables

No new environment variables needed. Uses existing:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `AUTH_REQUIRED`
- `CYBERTIGER_ENABLED`

GitHub Actions uses:
- `COSIGN_EXPERIMENTAL=1` (keyless signing, auto-set)

---

## Troubleshooting

### Pre-commit hook won't install
```bash
# Ensure Python 3 is installed
python3 --version

# Re-run setup
bash scripts/setup-pre-commit.sh
```

### TruffleHog finds false positives
1. Review the secret carefully
2. If it's a placeholder/example, add to `.secrets.baseline`:
   ```bash
   detect-secrets scan --baseline .secrets.baseline
   git add .secrets.baseline
   git commit -m "chore: update secrets baseline"
   ```

### Dependabot PR fails tests
1. Check if dependency upgrade broke something
2. Comment `@dependabot rebase` to update
3. Or manually fix in PR, commit, and push

### Cosign verification fails
```bash
# Ensure Cosign is installed and PATH is correct
cosign version

# Re-download artifacts from GitHub Release page
# Verify you're using the correct v1 binary
```

### npm audit still shows vulnerabilities after fix
```bash
# Update package-lock.json
npm ci

# Re-run audit
npm audit

# If still failing, may need manual remediation
npm audit fix --force  # Use cautiously!
```

---

## Monitoring & Alerts

### GitHub Notifications
- ✅ All workflows show in "Actions" tab
- ✅ Failing workflows show as "red X" on commits
- ✅ Dependabot PRs email you automatically
- ✅ PR comments show compliance status

### Email Alerts
Set up in GitHub Settings → Notifications:
- ✅ "Dependabot alerts"
- ✅ "Security vulnerability alerts"
- ✅ "Workflow run failures"

### Manual Checks
```bash
# Weekly audit
npm run security:full

# Before every commit
npm run security:secrets

# Before PR submission
npm run lint && npm run security:full
```

---

## References

- [GitHub Dependabot Docs](https://docs.github.com/en/code-security/dependabot)
- [TruffleHog GitHub](https://github.com/trufflesecurity/trufflehog)
- [detect-secrets GitHub](https://github.com/Yelp/detect-secrets)
- [Cosign Documentation](https://docs.sigstore.dev/cosign/overview)
- [SLSA Framework](https://slsa.dev/)
- [GitHub CodeQL](https://codeql.github.com/)

