#!/bin/bash
# Local secret detection script
# Run: bash scripts/check-secrets-local.sh

set -e

echo "🔍 Scanning for secrets locally..."

# Install TruffleHog if not available
if ! command -v trufflehog &> /dev/null; then
  echo "Installing TruffleHog..."
  pip install trufflehog
fi

# Scan current directory for secrets
echo "Running TruffleHog scan..."
trufflehog filesystem . \
  --json \
  --only-verified \
  --fail \
  --entropy false \
  2>/dev/null || {
  exit_code=$?
  if [ $exit_code -eq 1 ]; then
    echo "⚠️  Secrets detected! Review and remediate before committing."
    exit 1
  fi
}

echo "✅ No verified secrets found"

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
  if git diff --cached | grep -q "$pattern"; then
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
