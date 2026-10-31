#!/bin/bash
# Tests for the remote-development scripts: the secret scan fails closed (never
# "clean" without scanning), dev:setup's .env, and dev:doctor's never-commit check.
# Each runs in a throwaway git repo with TruffleHog stubbed, so nothing touches
# this checkout.   bash scripts/dev/dev-tools.test.sh      (npm run test:ops)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
pass=0; failed=0

expect() { # NAME CONDITION...
  local name=$1; shift
  if "$@"; then pass=$((pass + 1)); else failed=$((failed + 1)); echo "FAIL: $name"; fi
}

# A scratch repo with copies of the scripts under test.
R="$T/repo"; mkdir -p "$R/scripts/dev" "$T/bin"
cp "$ROOT/scripts/check-secrets-local.sh" "$R/scripts/"
cp "$ROOT/scripts/dev/setup.sh" "$ROOT/scripts/dev/doctor.sh" "$R/scripts/dev/"
cd "$R" || exit 1
git init -q . && git config user.email t@example.com && git config user.name t
printf '.env\n' >.gitignore
echo tracked >a.txt && echo untracked >b.txt && echo 'SECRET=x' >.env
git add .gitignore a.txt && git commit -qm init

# TruffleHog stubs: $1 is the version line ("" = TruffleHog 2's usage error), $2 the scan's exit code.
th() {
  printf '#!/bin/bash\nif [ "$1" = --version ]; then [ -n "%s" ] || { echo "usage: trufflehog [-h] [--json]" >&2; exit 2; }; echo "%s"; exit 0; fi\necho "$@" >"%s/args"\nexit %s\n' \
    "$1" "$1" "$T" "$2" >"$T/bin/th"
  chmod +x "$T/bin/th"
}
scan() { TRUFFLEHOG="$T/bin/th" bash scripts/check-secrets-local.sh "$@" >"$T/out" 2>&1; }

th "trufflehog 3.99.2" 0; scan; rc=$?
expect "clean scan exits 0" [ "$rc" = 0 ]
expect "scans tracked and untracked files" grep -q 'a.txt.*b.txt\|b.txt.*a.txt' "$T/args"
expect "skips ignored .env" bash -c "! grep -q '\.env' '$T/args'"
th "trufflehog 3.99.2" 183; scan; expect "secrets found exits 1" [ $? = 1 ]
th "trufflehog 3.99.2" 1; scan; expect "scanner error exits 2, not clean" [ $? = 2 ]
th "" 2; scan; expect "TruffleHog 2 is refused" [ $? = 2 ]
expect "says why" grep -q 'not TruffleHog 3' "$T/out"
TRUFFLEHOG="$T/missing" bash scripts/check-secrets-local.sh >/dev/null 2>&1; expect "missing TruffleHog exits 2" [ $? = 2 ]
th "trufflehog 3.99.2" 0; : >"$T/args"; scan a.txt .env; expect "scans the files it's given" grep -q 'a.txt .env' "$T/args"
th "trufflehog 3.99.2" 0; scan --check; expect "--check only checks the version" [ $? = 0 ]

# dev:setup --env-only, in a codespace
printf 'ALLOWED_ORIGINS=http://localhost:8080\nDEVICE_AUTH_SECRET=\nBETTER_AUTH_URL=http://127.0.0.1:3001\n' >.env.example
rm -f .env
cs() { CODESPACES=true CODESPACE_NAME=demo-x GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN=app.github.dev VITE_HELIO_PROXY_URL=same-origin \
  bash scripts/dev/setup.sh --env-only >/dev/null 2>&1; }
cs; expect "setup --env-only succeeds" [ $? = 0 ]
mode=$(stat -c %a .env 2>/dev/null || stat -f %Lp .env)
expect ".env is 600" [ "$mode" = 600 ]
expect "device secret is 64 hex" grep -Eq '^DEVICE_AUTH_SECRET=[0-9a-f]{64}$' .env
expect "auth secret is 64 hex" grep -Eq '^BETTER_AUTH_SECRET=[0-9a-f]{64}$' .env
expect "auth URL is the codespace origin" grep -qx 'BETTER_AUTH_URL=https://demo-x-8080.app.github.dev' .env
expect "origins add the codespace" grep -qx 'ALLOWED_ORIGINS=http://localhost:8080,https://demo-x-8080.app.github.dev,http://127.0.0.1:8080' .env
before=$(cat .env); cs
expect "re-running changes nothing" [ "$before" = "$(cat .env)" ]
rm .env; bash scripts/dev/setup.sh --env-only >/dev/null 2>&1
expect "own machine keeps the API URL" grep -qx 'BETTER_AUTH_URL=http://127.0.0.1:3001' .env

# dev:doctor flags a tracked .env
git add -f .env >/dev/null 2>&1
bash scripts/dev/doctor.sh >"$T/out" 2>&1; rc=$?
expect "doctor fails when .env is tracked" [ "$rc" = 1 ]
expect "doctor names it" grep -q '✗ Tracked by git but must never be: .env' "$T/out"

echo "dev-tools: $pass passed, $failed failed"
[ "$failed" -eq 0 ]
