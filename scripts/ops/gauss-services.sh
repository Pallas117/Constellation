#!/bin/bash
# Run Gauss (backend :3001, built frontend :8080) as user LaunchAgents that
# start at login and restart if they crash. Runs from a dedicated checkout so
# day-to-day development can't break the running services.
#
#   scripts/ops/gauss-services.sh install <checkout-dir>   build + write + load agents
#   scripts/ops/gauss-services.sh status                   agent state + health checks
#   scripts/ops/gauss-services.sh check                    pre-demo checklist (exit 1 if anything is off)
#   scripts/ops/gauss-services.sh resilience               battery, memory, network and phone alerts before closing the lid (exit 1 if not)
#   scripts/ops/gauss-services.sh tailnet on|off           share Gauss on your tailnet only (tailscale serve)
#   scripts/ops/gauss-services.sh awake setup|on|off       keep running with the lid closed (setup: once, asks for sudo)
#   scripts/ops/gauss-services.sh restart                  restart services
#   scripts/ops/gauss-services.sh uninstall                unload + remove agents
#
# Agents: backend (:3001) and frontend (:8080) restart if they crash; a nightly
# learning job (03:00, or on next wake) rebuilds the nowcast dataset from the
# data collected so far and records a new model version; an awake guard keeps
# the Mac awake with the lid closed, except on battery at or below
# GAUSS_AWAKE_MIN_BATTERY% (default 10, the mesh's critical-battery level), where it
# lets the Mac sleep again. It texts the phone (via `argo notify`) at
# GAUSS_AWAKE_WARN_BATTERY% (default 20), at the floor, and when the charger can't keep up.
# The site is built for GAUSS_PUBLIC_URL (default: this Mac's tailnet name over
# HTTP, encrypted by Tailscale; never exposed to the internet).
# Logs: ~/Library/Logs/gauss/. User scope only; the one sudo step is `awake setup`,
# which allows exactly `pmset -a disablesleep 0|1` and `pmset sleepnow` without a password.
set -euo pipefail

AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/gauss"
UID_DOMAIN="gui/$(id -u)"
NODE="${NODE:-$(command -v node || true)}" # only install needs it; the guard must run without it
LABELS=(uk.lightbound.gauss-backend uk.lightbound.gauss-frontend uk.lightbound.gauss-learning uk.lightbound.gauss-awake)
SERVICES=(uk.lightbound.gauss-backend uk.lightbound.gauss-frontend)
SUDOERS=/etc/sudoers.d/gauss-awake
AWAKE_OFF="$HOME/Library/Application Support/Gauss/awake-off"
# Same floor the mesh uses for its own devices: below 10% a device is flagged
# (backend/services/device-registry.ts) and swapped out (device-swap-manager.ts).
AWAKE_MIN_BATTERY="${GAUSS_AWAKE_MIN_BATTERY:-10}"
AWAKE_WARN_BATTERY="${GAUSS_AWAKE_WARN_BATTERY:-20}" # phone warning before the floor
ARGO="${ARGO:-$HOME/.local/bin/argo}"
MEM_MIN_FREE="${GAUSS_MEM_MIN_FREE:-15}" # phone alert at or below this system-wide free %
SWAP_MAX="${GAUSS_SWAP_MAX:-90}"         # ... or at or above this swap use %

tailnet_url() {
  local name
  name=$(tailscale status --json 2>/dev/null | python3 -Ic 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
  [ -n "$name" ] && echo "http://$name" || echo "http://127.0.0.1:8080"
}
PUBLIC_URL="${GAUSS_PUBLIC_URL:-$(tailnet_url)}"

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

plist() { # plist <label> <dir> <log> <keepalive|nightly|minutely> <arg>...
  local label=$1 dir=$2 log=$3 mode=$4; shift 4
  local schedule="  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>"
  [ "$mode" = nightly ] && schedule="  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>"
  [ "$mode" = minutely ] && schedule="  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>"
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
    <key>GAUSS_PUBLIC_URL</key><string>$(xml "$PUBLIC_URL")</string>
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

# Lid-closed awake. A closed lid sleeps a Mac whatever apps assert; only
# `pmset disablesleep` (root) stops it, so `awake setup` allows that one command.
sleep_disabled() { pmset -g | awk '$1=="SleepDisabled"{v=$2} END{print v+0}'; }
lid_closed() { [[ "$(ioreg -r -k AppleClamshellState -d 1)" == *'"AppleClamshellState" = Yes'* ]]; }

awake_set() { # awake_set 0|1 <reason>
  [ "$(sleep_disabled)" = "$1" ] && return 0
  if ! { [ -f "$SUDOERS" ] && sudo -n /usr/bin/pmset -a disablesleep "$1"; }; then
    echo "Can't change sleep: run '$0 awake setup' once." >&2; return 1
  fi
  echo "$(date '+%F %T') lid-closed awake $([ "$1" = 1 ] && echo on || echo off): $2"
}

# Phone alerts go through Argo's iMessage channel (masked, queued while
# offline, rate-limited per key); silently skipped if Argo isn't installed.
phone() { [ -x "$ARGO" ] && "$ARGO" notify "$@" >/dev/null 2>&1 || true; }

battery_alerts() { # battery_alerts <pmset batt output> <pct>
  local batt=$1 pct=$2
  [ -n "$pct" ] || return 0
  if [ "$(sleep_disabled)" = 1 ] && [ ! -f "$SUDOERS" ]; then
    phone -key awake-unguarded -every 6h "Gauss: no battery cutoff" \
      "Sleep is disabled but the awake guard isn't set up, so nothing stops the battery running flat (${pct}%). Run: gauss-services.sh awake setup"
  fi
  if [[ "$batt" == *"'AC Power'"* ]]; then
    if [ "$pct" -le "$AWAKE_WARN_BATTERY" ] && [[ "$batt" == *"discharging"* || "$batt" == *"not charging"* ]]; then
      phone -key charger-weak -every 1h "Gauss: charger can't keep up" \
        "Battery ${pct}% and not gaining on AC. Use a 30W+ USB-C charger or ease the load."
    fi
  elif [ "$pct" -le "$AWAKE_MIN_BATTERY" ]; then
    phone -key battery-critical -every 30m "Gauss: battery ${pct}%" \
      "At the ${AWAKE_MIN_BATTERY}% floor: letting the Mac sleep. Plug in to keep background work running."
  elif [ "$pct" -le "$AWAKE_WARN_BATTERY" ]; then
    phone -key battery-low -every 30m "Gauss: battery ${pct}%" \
      "On battery. The Mac sleeps at ${AWAKE_MIN_BATTERY}% and background work pauses; plug in soon."
  fi
}

# Memory: an 8 GB Mac running Gauss, Claude sessions and builds can run out
# and macOS then kills or freezes background work. "free" is macOS's own
# system-wide free percentage; swap is how much of the swap file is in use.
memory_stats() { # prints "<free%> <swap used%>"
  local free swap
  free=$(memory_pressure -Q 2>/dev/null | awk -F': ' '/free percentage/{gsub(/%/,"",$2); print $2+0}' || true)
  swap=$(sysctl -n vm.swapusage 2>/dev/null | awk '{t=$3; u=$6; gsub(/M/,"",t); gsub(/M/,"",u); print (t>0 ? int(u*100/t) : 0)}' || true)
  echo "${free:-100} ${swap:-0}"
}
top_memory() { ps -Acmo rss=,comm= 2>/dev/null | awk 'NR==1{printf "%s %.1f GB", $2, $1/1048576}'; }

memory_alerts() { # memory_alerts <free%> <swap used%>
  local free=$1 swap=$2
  if [ "$free" -le "$MEM_MIN_FREE" ]; then
    phone -key memory-low -every 30m "Gauss: memory ${free}% free" \
      "Background work may be killed. Biggest: $(top_memory). Close apps or stop a build."
  fi
  if [ "$swap" -ge "$SWAP_MAX" ]; then
    phone -key swap-high -every 1h "Gauss: swap ${swap}% used" \
      "The Mac is short of memory and slowing down. Biggest: $(top_memory)."
  fi
}

awake_guard() { # run every minute by the awake agent
  local batt pct
  batt=$(pmset -g batt); pct=$(grep -Eo '[0-9]+%' <<<"$batt" | head -1 | tr -d % || true)
  battery_alerts "$batt" "$pct"
  local free swap; read -r free swap < <(memory_stats)
  memory_alerts "$free" "$swap"
  [ -f "$SUDOERS" ] || return 0 # not set up; status and check say so
  if [ -f "$AWAKE_OFF" ]; then
    awake_set 0 "turned off"
  elif [[ "$batt" == *"'AC Power'"* ]] || [ -z "$pct" ]; then
    awake_set 1 "on AC power"
  elif [ "$pct" -gt "$AWAKE_MIN_BATTERY" ]; then
    awake_set 1 "battery ${pct}%"
  elif [ "$(sleep_disabled)" = 1 ]; then
    awake_set 0 "battery ${pct}% <= ${AWAKE_MIN_BATTERY}%"
    # Already shut in a bag: sleep now rather than run the battery flat.
    lid_closed && sudo -n /usr/bin/pmset sleepnow >/dev/null || true
  fi
  return 0
}

awake_state() { # "ok|no <description>" for status and check
  if [ -f "$AWAKE_OFF" ]; then echo "no lid-closed awake turned off ('$0 awake on' to resume)"
  elif [ ! -f "$SUDOERS" ]; then echo "no lid-closed awake not set up ('$0 awake setup', once)"
  elif ! launchctl print "$UID_DOMAIN/uk.lightbound.gauss-awake" >/dev/null 2>&1; then echo "no lid-closed awake guard not installed ('$0 install <checkout-dir>')"
  elif [ "$(sleep_disabled)" = 1 ]; then echo "ok stays awake with the lid closed (sleeps on battery at ${AWAKE_MIN_BATTERY}%)"
  else echo "no battery at or below ${AWAKE_MIN_BATTERY}%: the Mac sleeps when the lid closes; plug in"
  fi
}

awake_setup() { # one-time sudo: allow exactly the three pmset commands the guard uses
  local tmp; tmp=$(mktemp)
  printf '%s ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset sleepnow\n' "$(id -un)" >"$tmp"
  echo "Installing $SUDOERS (sudo asks for your password once):"; cat "$tmp"
  if sudo /usr/sbin/visudo -cqf "$tmp" && sudo /usr/bin/install -m 0440 -o root -g wheel "$tmp" "$SUDOERS"; then
    rm -f "$tmp"; awake_guard; awake_state | cut -d' ' -f2-
  else
    rm -f "$tmp"; echo "Not installed." >&2; return 1
  fi
}

health() {
  printf 'backend  /health  -> %s\n' "$(code http://127.0.0.1:3001/health)"
  printf 'frontend /        -> %s\n' "$(code http://127.0.0.1:8080/)"
  [ "$PUBLIC_URL" != "http://127.0.0.1:8080" ] && printf 'tailnet  %s -> %s\n' "$PUBLIC_URL" "$(code "$PUBLIC_URL/")"
  return 0
}

# item ok|no <text>: one checklist line; a "no" sets the caller's $fail.
item() { if [ "$1" = ok ]; then printf '  \033[32m✓\033[0m %s\n' "$2"; else printf '  \033[31m✗\033[0m %s\n' "$2"; fail=1; fi; }

network_item() {
  local argo ok; argo=$("$ARGO" status 2>/dev/null || echo "argo missing")
  case "$argo" in "● OK MY"*|"● OK SG"*|"● WPAD_RISK MY"*|"● WPAD_RISK SG"*) ok=ok ;; *) ok=no ;; esac
  [[ "$argo" == *stale* ]] && ok=no
  item $ok "network: $argo"
}

resilience() { # can background work survive the lid closed, the battery, memory and the network?
  local fail=0 ok batt pct free swap
  batt=$(pmset -g batt); pct=$(grep -Eo '[0-9]+%' <<<"$batt" | head -1 | tr -d % || true)
  if [[ "$batt" == *"'AC Power'"* ]]; then
    local note=""
    if [ "${pct:-100}" -gt "$AWAKE_WARN_BATTERY" ]; then ok=ok
    elif [[ "$batt" == *discharging* || "$batt" == *"not charging"* ]]; then ok=no note=", not gaining: use a 30W+ charger"
    else ok=no note=", charging but too low to unplug yet"
    fi
    item $ok "battery ${pct:-?}% on AC$note"
  else
    [ "${pct:-0}" -gt "$AWAKE_WARN_BATTERY" ] && ok=ok || ok=no
    item $ok "battery ${pct:-?}% on battery (sleeps at ${AWAKE_MIN_BATTERY}%)"
  fi
  local awake; awake=$(awake_state); item "${awake%% *}" "lid closed: ${awake#* }"
  read -r free swap < <(memory_stats)
  [ "$free" -gt "$MEM_MIN_FREE" ] && [ "$swap" -lt "$SWAP_MAX" ] && ok=ok || ok=no
  item $ok "memory ${free}% free, swap ${swap}% used$([ $ok = no ] && echo "; biggest: $(top_memory)")"
  network_item
  local heal="$HOME/.local/share/mesh-heal/state"
  [ -n "$(find "$heal" -mmin -5 2>/dev/null)" ] && ok=ok || ok=no
  item $ok "tailnet self-heal (mesh-heal) $([ $ok = ok ] && echo "checked in the last 5 min" || echo "not running: launchctl kickstart $UID_DOMAIN/uk.lightbound.mesh-heal")"
  local usage; usage=$("$ARGO" notify 2>&1 || true) # no args: a new argo prints notify's own usage
  if [[ "$usage" != *"argo notify ["* ]]; then
    item no "phone alerts: argo is too old for 'argo notify' (rebuild: cd tools/argo && go build -trimpath -o ~/.local/bin/argo .)"
  elif ! python3 -Ic 'import json,os,sys; sys.exit(not json.load(open(os.path.expanduser("~/.config/argo/config.json"))).get("phone_to"))' 2>/dev/null; then
    item no "phone alerts: no phone set (argo phone <+60... or Apple ID email>)"
  else
    item ok "phone alerts: iMessage via argo notify"
  fi
  grep -q claude-phone-hook "$HOME/.claude/settings.json" 2>/dev/null && ok=ok || ok=no
  item $ok "Claude Code prompts forwarded to the phone$([ $ok = no ] && echo " (Notification hook missing)")"
  [ $fail = 0 ] && echo "Resilient: safe to close the lid and go." || echo "Not resilient yet: fix the ✗ items above."
  return $fail
}

check() { # pre-demo checklist
  local fail=0 ok
  network_item
  [ "$(code http://127.0.0.1:3001/health)" = 200 ] && ok=ok || ok=no; item $ok "backend up (:3001)"
  [ "$(code http://127.0.0.1:8080/)" = 200 ] && ok=ok || ok=no; item $ok "website up (:8080)"
  if [ "$PUBLIC_URL" != "http://127.0.0.1:8080" ]; then
    # This Mac can't open its own tailnet share (macOS Tailscale doesn't loop it
    # back), so verify the parts it can: sharing configured, and the website and
    # API accept the tailnet hostname. Open the URL on a phone to confirm the last hop.
    local host="${PUBLIC_URL#http://}"
    if tailscale serve status 2>/dev/null | grep -q "/api proxy http://127.0.0.1:3001/api" \
      && [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "Host: $host" http://127.0.0.1:8080/)" = 200 ] \
      && [ "$(curl -s -o /dev/null -m 5 -w '%{http_code}' -H "Host: $host" http://127.0.0.1:3001/api/system/connectivity)" = 200 ]; then
      ok=ok
    else
      ok=no
    fi
    item $ok "shared on your tailnet: $PUBLIC_URL (open it on your phone to confirm)"
  fi
  local fresh
  fresh=$(curl -s -m 5 http://127.0.0.1:3001/api/feed/space-weather/latest | python3 -Ic '
import json, sys
try:
    q = json.load(sys.stdin).get("quality") or {}
    tier = q.get("tier", 3)
    label = {0: "live", 1: "ageing (last measurement 10-15 min old)"}.get(tier, "stale (no measurement in 15 min; just restarted?)")
    print(("ok" if tier == 0 else "no") + " space-weather data: " + label)
except Exception:
    print("no space-weather data unavailable")
' 2>/dev/null || echo "no space-weather data unavailable")
  item "${fresh%% *}" "${fresh#* }"
  local dir; dir=$(launchctl print "$UID_DOMAIN/uk.lightbound.gauss-backend" 2>/dev/null | awk -F'= ' '/working directory =/{print $2; exit}')
  local report; report=$(python3 -Ic '
import json, sys
from datetime import datetime, timezone
try:
    ds = json.load(open(sys.argv[1]))
    ages = [(datetime.now(timezone.utc) - datetime.fromisoformat(d["last"]["receivedAt"].replace("Z", "+00:00"))).total_seconds() / 60 for d in ds if d.get("last")]
    m = min(ages)
    print(("ok" if m <= 15 else "no") + " Argo reporting to Gauss (last %.0f min ago)" % m)
except Exception:
    print("no Argo has not reported to Gauss")
' "$dir/data/mesh/devices.json" 2>/dev/null || echo "no Argo has not reported to Gauss")
  item "${report%% *}" "${report#* }"
  local learned; learned=$(python3 -Ic '
import json, sys
try:
    m = json.load(open(sys.argv[1]))["models"][-1]
    print("ok last learning run %s UTC (%s, %s samples)" % (m["trained_at"][:16].replace("T", " "), m["version"], m.get("metrics", {}).get("samples", 0)))
except Exception:
    print("no no learning run recorded yet (runs nightly at 03:00)")
' "$dir/ml/models/registry.json" 2>/dev/null || echo "no no learning run recorded yet")
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
    plist uk.lightbound.gauss-awake "$dir" "$LOGS/awake.log" minutely \
      /bin/bash "$dir/scripts/ops/gauss-services.sh" awake guard >"$AGENTS/uk.lightbound.gauss-awake.plist"
    for l in "${LABELS[@]}"; do
      plutil -lint -s "$AGENTS/$l.plist"
      launchctl bootout "$UID_DOMAIN/$l" 2>/dev/null || true
      # bootout returns before the job is gone; bootstrapping too early fails with error 5.
      for _ in $(seq 1 20); do launchctl print "$UID_DOMAIN/$l" >/dev/null 2>&1 || break; sleep 0.5; done
      launchctl bootstrap "$UID_DOMAIN" "$AGENTS/$l.plist"
    done
    sleep 8
    health
    [ -f "$SUDOERS" ] || echo "To keep Gauss running with the lid closed, run once: $0 awake setup"
    ;;
  check)
    check
    ;;
  resilience)
    resilience
    ;;
  awake)
    case "${2:-}" in
      setup) awake_setup ;;
      guard) awake_guard ;;
      on) rm -f "$AWAKE_OFF"; awake_guard; awake_state | cut -d' ' -f2- ;;
      off) mkdir -p "$(dirname "$AWAKE_OFF")"; touch "$AWAKE_OFF"; awake_set 0 "turned off" || true; awake_state | cut -d' ' -f2- ;;
      *) awake_state | cut -d' ' -f2- ;;
    esac
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
    printf 'awake    %s\n' "$(awake_state | cut -d' ' -f2-)"
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
    [ -f "$SUDOERS" ] && { awake_set 0 "uninstalled" || true; echo "To drop the sleep rule too: sudo rm $SUDOERS"; }
    echo "Gauss services removed. Logs kept in $LOGS."
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 2
    ;;
esac
