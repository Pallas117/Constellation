#!/bin/bash
# Run Gauss (backend :3001, built frontend :8080) as user LaunchAgents that
# start at login and restart if they crash. Runs from a dedicated checkout so
# day-to-day development can't break the running services.
#
#   scripts/ops/gauss-services.sh install <checkout-dir>   build + write + load agents
#   scripts/ops/gauss-services.sh status                   agent state + health checks
#   scripts/ops/gauss-services.sh check                    pre-demo checklist (exit 1 if anything is off)
#   scripts/ops/gauss-services.sh tailnet on|off           share Gauss on your tailnet only (tailscale serve)
#   scripts/ops/gauss-services.sh restart                  restart services
#   scripts/ops/gauss-services.sh uninstall                unload + remove agents
#
# Agents: backend (:3001) and frontend (:8080) restart if they crash; a nightly
# learning job (03:00, or on next wake) rebuilds the nowcast dataset from the
# data collected so far and records a new model version.
# The site is built for GAUSS_PUBLIC_URL (default: this Mac's tailnet name over
# HTTP, encrypted by Tailscale; never exposed to the internet).
# Logs: ~/Library/Logs/gauss/. No sudo, user scope only. The Mac must be awake.
set -euo pipefail

AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/gauss"
UID_DOMAIN="gui/$(id -u)"
NODE="${NODE:-$(command -v node)}"
LABELS=(uk.lightbound.gauss-backend uk.lightbound.gauss-frontend uk.lightbound.gauss-learning)
SERVICES=(uk.lightbound.gauss-backend uk.lightbound.gauss-frontend)

tailnet_url() {
  local name
  name=$(tailscale status --json 2>/dev/null | python3 -Ic 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
  [ -n "$name" ] && echo "http://$name" || echo "http://127.0.0.1:8080"
}
PUBLIC_URL="${GAUSS_PUBLIC_URL:-$(tailnet_url)}"

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

plist() { # plist <label> <dir> <log> <keepalive|nightly> <arg>...
  local label=$1 dir=$2 log=$3 mode=$4; shift 4
  local schedule="  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>"
  [ "$mode" = nightly ] && schedule="  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>"
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
    <key>BETTER_AUTH_URL</key><string>$(xml "$PUBLIC_URL")</string>
    <key>MESH_STORE_PATH</key><string>$(xml "$dir/data/mesh/devices.json")</string>
    <key>COMMERCE_DB_PATH</key><string>$(xml "$dir/data/commerce/commerce.db")</string>
    <key>ALLOWED_ORIGINS</key><string>$(xml "$PUBLIC_URL,http://127.0.0.1:8080,http://localhost:8080")</string>
  </dict>
$schedule
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$log")</string>
  <key>StandardErrorPath</key><string>$(xml "$log")</string>
</dict>
</plist>
EOF
}

code() { local c; c=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null); [ "$c" = 000 ] || [ -z "$c" ] && echo down || echo "$c"; }

health() {
  printf 'backend  /health  -> %s\n' "$(code http://127.0.0.1:3001/health)"
  printf 'frontend /        -> %s\n' "$(code http://127.0.0.1:8080/)"
  [ "$PUBLIC_URL" != "http://127.0.0.1:8080" ] && printf 'tailnet  %s -> %s\n' "$PUBLIC_URL" "$(code "$PUBLIC_URL/")"
  return 0
}

check() { # pre-demo checklist
  local fail=0 ok
  item() { if [ "$1" = ok ]; then printf '  \033[32m✓\033[0m %s\n' "$2"; else printf '  \033[31m✗\033[0m %s\n' "$2"; fail=1; fi; }
  local argo; argo=$("$HOME/.local/bin/argo" status 2>/dev/null || echo "argo missing")
  case "$argo" in "● OK MY"*|"● OK SG"*|"● WPAD_RISK MY"*|"● WPAD_RISK SG"*) ok=ok ;; *) ok=no ;; esac
  [[ "$argo" == *stale* ]] && ok=no
  item $ok "network: $argo"
  [ "$(code http://127.0.0.1:3001/health)" = 200 ] && ok=ok || ok=no; item $ok "backend up (:3001)"
  [ "$(code http://127.0.0.1:8080/)" = 200 ] && ok=ok || ok=no; item $ok "website up (:8080)"
  if [ "$PUBLIC_URL" != "http://127.0.0.1:8080" ]; then
    [ "$(code "$PUBLIC_URL/")" = 200 ] && [ "$(code "$PUBLIC_URL/api/system/connectivity")" = 200 ] && ok=ok || ok=no
    item $ok "phone/iPad demo URL: $PUBLIC_URL"
  fi
  local fresh
  fresh=$(curl -s -m 5 http://127.0.0.1:3001/api/feed/space-weather/latest | python3 -Ic 'import json,sys
from datetime import datetime, timezone
try:
  p=json.load(sys.stdin); age=(datetime.now(timezone.utc)-datetime.fromisoformat(p["timestamp"].replace("Z","+00:00"))).total_seconds()/60
  print(("ok" if not (p.get("quality") or {}).get("stale") else "no")+f" live space-weather data, {age:.0f} min old")
except Exception: print("no live space-weather data unavailable")' 2>/dev/null)
  item "${fresh%% *}" "${fresh#* }"
  local dir; dir=$(launchctl print "$UID_DOMAIN/uk.lightbound.gauss-backend" 2>/dev/null | awk -F'= ' '/working directory =/{print $2; exit}')
  local report; report=$(python3 -Ic 'import json,sys
from datetime import datetime, timezone
try:
  ds=json.load(open(sys.argv[1])); ages=[(datetime.now(timezone.utc)-datetime.fromisoformat(d["last"]["receivedAt"].replace("Z","+00:00"))).total_seconds()/60 for d in ds if d.get("last")]
  m=min(ages); print(("ok" if m<=15 else "no")+f" Argo reporting to Gauss (last {m:.0f} min ago)")
except Exception: print("no Argo has not reported to Gauss")' "$dir/data/mesh/devices.json" 2>/dev/null)
  item "${report%% *}" "${report#* }"
  local learned; learned=$(python3 -Ic 'import json,sys
try:
  ms=json.load(open(sys.argv[1])).get("models",[]); m=ms[-1]; print("ok last learning run "+m["trained_at"][:16].replace("T"," ")+f" UTC ({m[\"version\"]}, {m[\"metrics\"].get(\"samples\",0)} samples)")
except Exception: print("no no learning run recorded yet")' "$dir/ml/models/registry.json" 2>/dev/null)
  item "${learned%% *}" "${learned#* }"
  [ $fail = 0 ] && echo "Ready to demo." || echo "Not ready: fix the ✗ items above."
  return $fail
}

case "${1:-}" in
  install)
    dir="$(cd "${2:?usage: $0 install <checkout-dir>}" && pwd)"
    [ -f "$dir/backend/server.ts" ] || { echo "$dir is not a Gauss checkout" >&2; exit 1; }
    mkdir -p "$LOGS" "$dir/data/mesh" "$dir/data/commerce"
    echo "Building the frontend in $dir for $PUBLIC_URL ..."
    (cd "$dir" && VITE_HELIO_PROXY_URL="$PUBLIC_URL" "$NODE" node_modules/vite/bin/vite.js build --config frontend/vite.config.ts >/dev/null)
    plist uk.lightbound.gauss-backend "$dir" "$LOGS/backend.log" keepalive \
      "$NODE" --env-file-if-exists=.env --import tsx backend/server.ts >"$AGENTS/uk.lightbound.gauss-backend.plist"
    plist uk.lightbound.gauss-learning "$dir" "$LOGS/learning.log" nightly \
      "$(command -v python3)" -I ml/train/nightly.py --telemetry data/bedrock/telemetry.jsonl >"$AGENTS/uk.lightbound.gauss-learning.plist"
    plist uk.lightbound.gauss-frontend "$dir" "$LOGS/frontend.log" keepalive \
      "$NODE" node_modules/vite/bin/vite.js preview --config frontend/vite.config.ts --host 127.0.0.1 --port 8080 --strictPort \
      >"$AGENTS/uk.lightbound.gauss-frontend.plist"
    for l in "${LABELS[@]}"; do
      plutil -lint -s "$AGENTS/$l.plist"
      launchctl bootout "$UID_DOMAIN/$l" 2>/dev/null || true
      # bootout returns before the job is gone; bootstrapping too early fails with error 5.
      for _ in $(seq 1 20); do launchctl print "$UID_DOMAIN/$l" >/dev/null 2>&1 || break; sleep 0.5; done
      launchctl bootstrap "$UID_DOMAIN" "$AGENTS/$l.plist"
    done
    sleep 8
    health
    ;;
  check)
    check
    ;;
  tailnet)
    case "${2:-}" in
      on)
        # Tailnet only (never Funnel). The site and its API share one origin.
        tailscale serve --bg --http 80 --set-path / http://127.0.0.1:8080
        tailscale serve --bg --http 80 --set-path /api http://127.0.0.1:3001/api
        tailscale serve --bg --http 80 --set-path /ws http://127.0.0.1:3001/ws
        tailscale serve status
        ;;
      off) tailscale serve reset && echo "Gauss is no longer shared on the tailnet." ;;
      *) tailscale serve status ;;
    esac
    ;;
  status)
    for l in "${LABELS[@]}"; do
      printf '%-30s %s\n' "$l" "$(launchctl print "$UID_DOMAIN/$l" 2>/dev/null | awk -F'= ' '/^\tstate =/{s=$2} /last exit code/{e=$2} END{print (s?s:"not loaded") (e?", last exit "e:"")}')"
    done
    health
    ;;
  restart)
    for l in "${SERVICES[@]}"; do launchctl kickstart -k "$UID_DOMAIN/$l"; done
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
