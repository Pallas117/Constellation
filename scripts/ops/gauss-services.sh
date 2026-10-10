#!/bin/bash
# Run Gauss (backend :3001, built frontend :8080) as user LaunchAgents that
# start at login and restart if they crash. Runs from a dedicated checkout so
# day-to-day development can't break the running services.
#
#   scripts/ops/gauss-services.sh install <checkout-dir>   build + write + load agents
#   scripts/ops/gauss-services.sh status                   agent state + health checks
#   scripts/ops/gauss-services.sh restart                  restart both
#   scripts/ops/gauss-services.sh uninstall                unload + remove agents
#
# Logs: ~/Library/Logs/gauss/{backend,frontend}.log. No sudo, user scope only.
# The Mac must be awake for services to answer; sleep pauses them like any app.
set -euo pipefail

AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/gauss"
UID_DOMAIN="gui/$(id -u)"
NODE="${NODE:-$(command -v node)}"
LABELS=(uk.lightbound.gauss-backend uk.lightbound.gauss-frontend)

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

plist() { # plist <label> <dir> <log> <arg>...
  local label=$1 dir=$2 log=$3; shift 3
  local args="" a
  for a in "$@"; do args+="    <string>$(xml "$a")</string>"$'\n'; done
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>WorkingDirectory</key><string>$(xml "$dir")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$(dirname "$NODE")"):/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>BETTER_AUTH_URL</key><string>http://127.0.0.1:3001</string>
    <key>MESH_STORE_PATH</key><string>$(xml "$dir/data/mesh/devices.json")</string>
    <key>COMMERCE_DB_PATH</key><string>$(xml "$dir/data/commerce/commerce.db")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$log")</string>
  <key>StandardErrorPath</key><string>$(xml "$log")</string>
</dict>
</plist>
EOF
}

health() {
  printf 'backend  /health  -> %s\n' "$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:3001/health || echo down)"
  printf 'frontend /        -> %s\n' "$(curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:8080/ || echo down)"
}

case "${1:-}" in
  install)
    dir="$(cd "${2:?usage: $0 install <checkout-dir>}" && pwd)"
    [ -f "$dir/backend/server.ts" ] || { echo "$dir is not a Gauss checkout" >&2; exit 1; }
    mkdir -p "$LOGS" "$dir/data/mesh" "$dir/data/commerce"
    echo "Building the frontend in $dir ..."
    (cd "$dir" && "$NODE" node_modules/vite/bin/vite.js build --config frontend/vite.config.ts >/dev/null)
    plist uk.lightbound.gauss-backend "$dir" "$LOGS/backend.log" \
      "$NODE" --env-file-if-exists=.env --import tsx backend/server.ts >"$AGENTS/uk.lightbound.gauss-backend.plist"
    plist uk.lightbound.gauss-frontend "$dir" "$LOGS/frontend.log" \
      "$NODE" node_modules/vite/bin/vite.js preview --config frontend/vite.config.ts --host 127.0.0.1 --port 8080 --strictPort \
      >"$AGENTS/uk.lightbound.gauss-frontend.plist"
    for l in "${LABELS[@]}"; do
      plutil -lint -s "$AGENTS/$l.plist"
      launchctl bootout "$UID_DOMAIN/$l" 2>/dev/null || true
      launchctl bootstrap "$UID_DOMAIN" "$AGENTS/$l.plist"
    done
    sleep 8
    health
    ;;
  status)
    for l in "${LABELS[@]}"; do
      printf '%-30s %s\n' "$l" "$(launchctl print "$UID_DOMAIN/$l" 2>/dev/null | awk -F'= ' '/^\tstate =/{s=$2} /last exit code/{e=$2} END{print (s?s:"not loaded") (e?", last exit "e:"")}')"
    done
    health
    ;;
  restart)
    for l in "${LABELS[@]}"; do launchctl kickstart -k "$UID_DOMAIN/$l"; done
    sleep 8
    health
    ;;
  uninstall)
    for l in "${LABELS[@]}"; do
      launchctl bootout "$UID_DOMAIN/$l" 2>/dev/null || true
      rm -f "$AGENTS/$l.plist"
    done
    echo "Gauss services removed. Logs kept in $LOGS."
    ;;
  *)
    sed -n '2,12p' "$0"
    exit 2
    ;;
esac
