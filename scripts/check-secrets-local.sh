#!/bin/bash
# Local secret detection script
# Run: bash scripts/check-secrets-local.sh
#
# Needs TruffleHog v3 (brew install trufflehog). The PyPI "trufflehog" is the
# old v2 tool: it rejects these flags, and an earlier version of this script
# read that error as "no secrets found". Any failure to scan now fails.

set -euo pipefail

echo "🔍 Scanning for secrets locally..."

version=$(trufflehog --version 2>&1 | head -1 || true)
if [[ ! "$version" =~ trufflehog\ 3\. ]]; then
  echo "❌ TruffleHog v3 is required (found: ${version:-none}). Install it: brew install trufflehog" >&2
  exit 2
fi

# Skip installed and generated trees; scan everything else in the checkout.
exclude=$(mktemp)
trap 'rm -f "$exclude"' EXIT
printf '%s\n' '(^|/)node_modules/' '(^|/)\.git/' '(^|/)dist/' '(^|/)coverage/' '(^|/)test-results/' >"$exclude"

echo "Running TruffleHog scan..."
rc=0
trufflehog filesystem . --only-verified --fail --no-update --exclude-paths "$exclude" || rc=$?
case $rc in
  0) echo "✅ No verified secrets found" ;;
  183)
    echo "⚠️  Verified secrets detected! Review and remediate before committing." >&2
    exit 1
    ;;
  *)
    echo "❌ TruffleHog failed (exit $rc): the scan did not complete." >&2
    exit 2
    ;;
esac

# Check for common secret patterns
echo ""
echo "Checking for common secret patterns..."

patterns=(
  "SUPABASE_SERVICE_ROLE_KEY="
  "GITHUB_TOKEN="
  "API_KEY="
  "SECRET_KEY="
  "PRIVATE_KEY="
  "PASSWORD="
  "passwd"
)

found_patterns=0
for pattern in "${patterns[@]}"; do
  # Added lines only: removing a secret must not fail the check.
  if git diff --cached | grep -E '^\+' | grep -q -- "$pattern"; then
    echo "⚠️  Potential secret pattern found: $pattern"
    found_patterns=$((found_patterns + 1))
  fi
done

if [ $found_patterns -gt 0 ]; then
  echo "❌ Found $found_patterns potential secrets in staged changes"
  exit 1
fi

echo "✅ No secret patterns detected"
echo ""
echo "✨ Secret scan passed!"
