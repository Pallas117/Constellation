#!/bin/bash
# Local secret scan with TruffleHog 3. GitHub Actions are off, so this and the
# git hooks are the secret check before review.
#   npm run security:secrets         scan every file git would commit (tracked + untracked, not ignored)
#   bash scripts/check-secrets-local.sh FILE...   scan those files (the pre-commit hook does this)
#   bash scripts/check-secrets-local.sh --check   only check that TruffleHog 3 is installed
# Exit 0 = clean, 1 = secrets found, 2 = the scan could not run. It never reports
# "clean" without scanning.
#
# Needs TruffleHog 3: `brew install trufflehog`, or the dev container (.devcontainer/).
# `pip install trufflehog` is TruffleHog 2, a different tool without the `filesystem`
# command, so it is refused. TRUFFLEHOG=/path/to/trufflehog picks a specific binary.
set -uo pipefail

TH="${TRUFFLEHOG:-trufflehog}"
cd "$(git rev-parse --show-toplevel)" || exit 2

if ! command -v "$TH" >/dev/null 2>&1; then
  echo "❌ TruffleHog 3 is not installed: brew install trufflehog (see docs/REMOTE_DEVELOPMENT.md)." >&2
  exit 2
fi
version=$("$TH" --version 2>&1 | head -1)
if ! [[ "$version" =~ ^trufflehog\ 3\. ]]; then
  echo "❌ $(command -v "$TH") is not TruffleHog 3 (it says: ${version:-nothing})." >&2
  echo "   The pip package is TruffleHog 2. Install TruffleHog 3 (brew install trufflehog) and put it first on PATH," >&2
  echo "   or run with TRUFFLEHOG=/path/to/trufflehog." >&2
  exit 2
fi
if [ "${1:-}" = --check ]; then # only check that TruffleHog 3 is installed
  echo "$version"
  exit 0
fi

files=()
if [ $# -gt 0 ]; then
  for f in "$@"; do [ -f "$f" ] && files+=("$f"); done
else
  while IFS= read -r -d '' f; do
    [ -f "$f" ] && files+=("$f")
  done < <(git ls-files -z --cached --others --exclude-standard)
fi
if [ ${#files[@]} -eq 0 ]; then
  echo "✅ No files to scan"
  exit 0
fi

# --results=verified,unknown: report secrets that work, and ones TruffleHog couldn't
# check (offline, provider error). --fail: exit 183 when it reports any.
"$TH" filesystem --results=verified,unknown --fail --no-update "${files[@]}"
rc=$?
case $rc in
  0) echo "✅ No secrets found in ${#files[@]} file(s) ($version)" ;;
  183) echo "❌ Secrets found (above). Remove them, rotate any real one, and tell Josh before pushing." >&2; exit 1 ;;
  *) echo "❌ TruffleHog failed (exit $rc), so nothing was checked." >&2; exit 2 ;;
esac
