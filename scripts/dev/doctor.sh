#!/bin/bash
# Checks a Gauss Aurora checkout for remote development and says how to fix what's
# missing. Read-only: it changes nothing.   npm run dev:doctor
# ✗ = must fix before working (exit 1), ! = optional or only needed for some work.
set -uo pipefail
cd "$(dirname "$0")/../.."

fails=0
ok() { printf '  ✓ %s\n' "$1"; }
bad() { printf '  ✗ %s\n' "$1"; [ -z "${2:-}" ] || printf '      fix: %s\n' "$2"; fails=$((fails + 1)); }
warn() { printf '  ! %s\n' "$1"; [ -z "${2:-}" ] || printf '      fix: %s\n' "$2"; }
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

echo "Toolchain"
want=$(sed -E 's/^v?([0-9]+).*/\1/' .nvmrc | head -1)
have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none)
if [ "$have" = "$want" ]; then ok "Node $(node -v) (.nvmrc wants $want)"; else bad "Node $want needed, found $have" "nvm install $want && nvm use $want"; fi
if [ ! -d node_modules ]; then
  bad "Dependencies not installed" "npm run dev:setup"
elif [ package-lock.json -nt node_modules/.package-lock.json ]; then
  bad "Dependencies older than package-lock.json" "npm ci"
else
  ok "Dependencies match package-lock.json"
fi
if [ -d node_modules ]; then
  if node -e 'require("better-sqlite3")(":memory:").close()' >/dev/null 2>&1; then ok "better-sqlite3 loads under this Node"; else bad "better-sqlite3 was built for another Node" "npm rebuild better-sqlite3"; fi
fi
if command -v go >/dev/null 2>&1; then ok "Go $(go env GOVERSION) (tools/argo)"; else warn "Go not installed: only needed for tools/argo" "https://go.dev/dl/ or brew install go"; fi

echo "GitHub"
if ! command -v gh >/dev/null 2>&1; then
  warn "GitHub CLI not installed" "https://cli.github.com/ (brew install gh)"
elif gh auth status --hostname github.com >/dev/null 2>&1; then
  ok "GitHub CLI signed in"
else
  warn "GitHub CLI not signed in" "gh auth login"
fi
if [ -n "$(git config user.email)" ]; then ok "git identity: $(git config user.name) <$(git config user.email)>"; else bad "git user.email not set" "git config --global user.name 'Your Name' && git config --global user.email you@example.com"; fi
origin=$(git remote get-url origin 2>/dev/null || true)
case "$origin" in
  *github.com[:/]Pallas117/Constellation*) ok "origin is Pallas117/Constellation" ;;
  "") warn "No origin remote" "git remote add origin https://github.com/Pallas117/Constellation.git" ;;
  *) warn "origin is $origin, not Pallas117/Constellation" ;;
esac

echo "Secrets and security"
if [ ! -f .env ]; then
  bad "No .env" "npm run dev:setup -- --env-only"
else
  mode=$(file_mode .env)
  if [ "$mode" = 600 ]; then ok ".env is private (600)"; else bad ".env is mode $mode, readable by others" "chmod 600 .env"; fi
  if grep -Eq '^DEVICE_AUTH_SECRET=.{32,}' .env; then ok "DEVICE_AUTH_SECRET set"; else warn "DEVICE_AUTH_SECRET empty: device proofs are off" "npm run dev:setup -- --env-only"; fi
fi
tracked=$(git ls-files | grep -E '(^|/)\.env(\..+)?$|(^|/)\.auth\.db|^data/mesh/' | grep -v -E '(^|/)\.env\.example$' || true)
if [ -z "$tracked" ]; then ok "No .env, .auth.db or data/mesh/ files tracked by git"; else bad "Tracked by git but must never be: $(echo "$tracked" | tr '\n' ' ')" "git rm --cached <file>, rotate anything secret in it, and tell Josh"; fi
if th=$(bash scripts/check-secrets-local.sh --check 2>&1); then
  ok "TruffleHog 3 ($th)"
else
  bad "No TruffleHog 3, which the commit hook and npm run security:secrets need: $(echo "$th" | head -1 | sed 's/^❌ //')" "brew install trufflehog, or see docs/REMOTE_DEVELOPMENT.md"
fi
hooks=$(git rev-parse --git-path hooks)
if grep -q pre-commit "$hooks/pre-commit" 2>/dev/null && grep -q pre-commit "$hooks/commit-msg" 2>/dev/null; then
  ok "Git hooks installed (secrets, never-commit files, ESLint, commit messages)"
else
  bad "Git hooks not installed" "npm run security:setup-hooks"
fi

if [ "${CODESPACES:-}" = true ]; then
  echo "Codespaces"
  if ports=$(gh codespace ports -c "${CODESPACE_NAME:-}" --json sourcePort,visibility -q '.[] | select(.visibility != "private") | "\(.sourcePort):\(.visibility)"' 2>/dev/null); then
    if [ -z "$ports" ]; then ok "All forwarded ports are private"; else bad "Forwarded ports not private: $ports" "gh codespace ports visibility <port>:private -c $CODESPACE_NAME"; fi
  else
    warn "Couldn't read port visibility; check the Ports tab: every port must be Private"
  fi
fi

echo
if [ "$fails" -eq 0 ]; then echo "Ready. Run: npm run dev:all"; else echo "$fails problem(s) to fix (✗ above)."; fi
[ "$fails" -eq 0 ]
