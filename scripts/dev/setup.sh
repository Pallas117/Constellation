#!/bin/bash
# One command to make a Gauss Aurora checkout ready to run: in GitHub Codespaces,
# the dev container (.devcontainer/) or on your own Mac or Linux machine. Safe to re-run.
#   npm run dev:setup                 dependencies, .env, sign-in database, git hooks
#   npm run dev:setup -- --no-hooks   all of that except the git hooks
#   npm run dev:setup -- --env-only   only create or update .env
# Then: npm run dev:doctor, and npm run dev:all. See docs/REMOTE_DEVELOPMENT.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

HOOKS=1 ENV_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --no-hooks) HOOKS=0 ;;
    --env-only) ENV_ONLY=1 ;;
    -h | --help) sed -n '2,7p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$*"; }

get_env() { sed -n "s/^$1=//p" .env | tail -1; }
set_env() { # KEY VALUE: replace KEY's line in .env where it is, or add it at the end
  local tmp; tmp=$(mktemp)
  awk -v k="$1" -v v="$2" 'index($0, k "=") == 1 { if (!done) print k "=" v; done = 1; next }
    { print } END { if (!done) print k "=" v }' .env >"$tmp"
  cat "$tmp" >.env # rewrite in place, so .env keeps mode 0600
  rm -f "$tmp"
}

# The origin the browser opens the app on. Codespaces forwards port 8080 as
# https://<codespace>-8080.app.github.dev (private: only you can open it).
page_origin() {
  if [ "${CODESPACES:-}" = true ] && [ -n "${CODESPACE_NAME:-}" ]; then
    echo "https://${CODESPACE_NAME}-8080.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
  else
    echo "http://127.0.0.1:8080"
  fi
}

make_env() {
  step ".env (local settings and dev-only secrets; never committed)"
  if [ ! -f .env ]; then
    (umask 077 && cp .env.example .env)
    echo "Created .env from .env.example"
  fi
  chmod 600 .env
  # Made once per machine, for development only. Never copy them anywhere else.
  [ -n "$(get_env DEVICE_AUTH_SECRET)" ] || { set_env DEVICE_AUTH_SECRET "$(openssl rand -hex 32)"; echo "Set a new DEVICE_AUTH_SECRET"; }
  [ -n "$(get_env BETTER_AUTH_SECRET)" ] || { set_env BETTER_AUTH_SECRET "$(openssl rand -hex 32)"; echo "Set a new BETTER_AUTH_SECRET"; }

  # Sign-in and CORS accept only these origins (ALLOWED_ORIGINS, backend/better-auth.ts).
  local origin cur o
  origin=$(page_origin)
  cur=$(get_env ALLOWED_ORIGINS)
  for o in "$origin" http://127.0.0.1:8080 http://localhost:8080; do
    case ",$cur," in *",$o,"*) ;; *) cur="${cur:+$cur,}$o" ;; esac
  done
  set_env ALLOWED_ORIGINS "$cur"
  # In the dev container the browser reaches the API through the app's origin
  # (VITE_HELIO_PROXY_URL=same-origin; Vite forwards /api to :3001).
  if [ "${VITE_HELIO_PROXY_URL:-}" = same-origin ]; then
    case "$(get_env BETTER_AUTH_URL)" in "" | http://127.0.0.1:3001) set_env BETTER_AUTH_URL "$origin" ;; esac
  fi
  echo "App origin: $origin"
}

if [ "$ENV_ONLY" = 1 ]; then
  make_env
  exit 0
fi

step "Node"
want=$(sed -E 's/^v?([0-9]+).*/\1/' .nvmrc | head -1)
have=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none)
if [ "$have" != "$want" ]; then
  echo "Node $want is needed (.nvmrc); this shell has ${have}. Run: nvm install $want && nvm use $want" >&2
  exit 1
fi
echo "Node $(node -v)"

step "Dependencies"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm ci
else
  echo "Up to date with package-lock.json"
fi
# Native modules must be built by the Node that runs them.
node -e 'require("better-sqlite3")(":memory:").close()' 2>/dev/null || npm rebuild better-sqlite3

make_env

step "Sign-in database (.auth.db)"
npm run -s auth:migrate

if [ "$HOOKS" = 1 ]; then
  step "Git hooks"
  bash scripts/setup-pre-commit.sh
fi

step "Done"
cat <<EOF
Next:
  npm run dev:doctor   check this setup
  npm run dev:all      app on port 8080, API on 3001 ($(page_origin))
Sign up in the app, then give your local account a role: npm run auth:set-role -- <email> admin
EOF
