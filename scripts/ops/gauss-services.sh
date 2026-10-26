#!/bin/bash
# Run Gauss (backend :3001, built frontend :8080) as user LaunchAgents that
# start at login and restart if they crash. Runs from a dedicated checkout so
# day-to-day development can't break the running services.
#
#   scripts/ops/gauss-services.sh install <checkout-dir>   build + write + load agents
#   scripts/ops/gauss-services.sh status                   agent state + health checks
#   scripts/ops/gauss-services.sh check                    pre-demo checklist (exit 1 if anything is off)
#   scripts/ops/gauss-services.sh resilience               battery, memory, network and phone alerts before closing the lid (exit 1 if not)
#   scripts/ops/gauss-services.sh balance [--dry-run]      shed optional load now when memory, battery or disk run short (the guard runs it every minute)
#   scripts/ops/gauss-services.sh tailnet on|off           share Gauss on your tailnet only (tailscale serve)
#   scripts/ops/gauss-services.sh awake setup|on|off       keep running with the lid closed (setup: once, asks for sudo)
#   scripts/ops/gauss-services.sh restart                  restart services
#   scripts/ops/gauss-services.sh uninstall                unload + remove agents
#   scripts/ops/gauss-services.sh dev <checkout-dir>        run a dev/R&D checkout beside live (:3101 API, :5174 site)
#   scripts/ops/gauss-services.sh fallback prepare <dir> [sha]|on|off|status   cold-standby last-known-good build
#   scripts/ops/gauss-services.sh deploy <commit> [fallback-dir]   switch live to <commit>; rolls back by itself if it doesn't come up
#   scripts/ops/gauss-services.sh events [--since 2h] [--json]     timeline: watchdog, failover, deploys, alerts, boots (events.jsonl)
#
# Three layers (GAU-158): dev (any other checkout, foreground, own ports and data,
# never the live API), production (this install), and fallback: a built, not running,
# checkout of the last known-good commit. When the guard has used all its restarts on
# a service this hour and it is still down, it swaps the live agents for the fallback's
# on the same ports and URLs (live data, live .env) and texts the phone. Back with
# `fallback off`. `deploy` refreshes the fallback from what is running before it
# switches, so the standby is always the previous version (by hand:
# `fallback prepare <dir>`, default sha: the live checkout's HEAD).
#
# deploy (run the gates on the commit first): refuses under memory pressure or over
# local code changes in live (live's data files are kept), refreshes the fallback,
# checks out the commit, runs npm ci only if package-lock.json changed, reinstalls and
# waits for what a deploy can break (backend, site, site -> API, same-origin build).
# If that doesn't come up it puts the previous commit back; if that fails too it
# switches to the fallback. Either way it texts the phone. The guard leaves the
# services alone while a deploy runs.
#
# Agents: backend (:3001) and frontend (:8080) restart if they crash; a nightly
# learning job (03:00, or on next wake) rebuilds the nowcast dataset from the
# data collected so far and records a new model version; an awake guard keeps
# the Mac awake with the lid closed, except on battery at or below
# GAUSS_AWAKE_MIN_BATTERY% (default 10, the mesh's critical-battery level), where it
# lets the Mac sleep again. It texts the phone (via `argo notify`) at
# GAUSS_AWAKE_WARN_BATTERY% (default 20), at the floor, and when the charger can't keep up.
# The site is shared at GAUSS_PUBLIC_URL (default: this Mac's tailnet name over
# HTTP, encrypted by Tailscale; never exposed to the internet). It is built with a
# same-origin API (/api, /ws), so the one build works at http://127.0.0.1:8080 on
# this Mac and at the tailnet name: vite preview and tailscale serve both forward
# /api and /ws to the backend.
# Logs: ~/Library/Logs/gauss/. User scope only; the one sudo step is `awake setup`,
# which allows exactly `pmset -a disablesleep 0|1` and `pmset sleepnow` without a password.
set -euo pipefail

AGENTS="$HOME/Library/LaunchAgents"
LOGS="$HOME/Library/Logs/gauss"
UID_DOMAIN="gui/$(id -u)"
NODE="${NODE:-$(command -v node || true)}" # only install needs it; the guard must run without it
LABELS=(uk.lightbound.gauss-backend uk.lightbound.gauss-frontend uk.lightbound.gauss-learning uk.lightbound.gauss-awake)
SERVICES=(uk.lightbound.gauss-backend uk.lightbound.gauss-frontend)
SUDOERS="${GAUSS_SUDOERS:-/etc/sudoers.d/gauss-awake}" # override only in tests
AWAKE_OFF="$HOME/Library/Application Support/Gauss/awake-off"
# Same floor the mesh uses for its own devices: below 10% a device is flagged
# (backend/services/device-registry.ts) and swapped out (device-swap-manager.ts).
AWAKE_MIN_BATTERY="${GAUSS_AWAKE_MIN_BATTERY:-10}"
AWAKE_WARN_BATTERY="${GAUSS_AWAKE_WARN_BATTERY:-20}" # phone warning before the floor
ARGO="${ARGO:-$HOME/.local/bin/argo}"
# Memory uses the kernel's pressure level (kern.memorystatus_vm_pressure_level: 1 normal, 2 warn,
# 4 critical) and swap in GB; see memory_stats for why not "free %" or swap "% used".
MEM_ALERT_LEVEL="${GAUSS_MEM_ALERT_LEVEL:-4}" # phone alert at or above this pressure level
MEM_SHED_LEVEL="${GAUSS_MEM_SHED_LEVEL:-2}"   # balance sheds optional load at or above this level
SWAP_MAX_GB="${GAUSS_SWAP_MAX_GB:-4}"         # ... or at or above this many GB of swap in use
DISK_MIN_GB="${GAUSS_DISK_MIN_GB:-8}"   # ... or below this many GB free on the boot volume
WATCH_DIR="$HOME/Library/Application Support/Gauss"
GUARD_HEARTBEAT="$WATCH_DIR/guard.heartbeat" # Argo restarts the guard if this goes stale
WATCH_KICKS="$WATCH_DIR/watch-kicks"         # "<label> <epoch>" per watchdog restart
WATCH_MAX_KICKS=3
DEPLOY_LOCK="$WATCH_DIR/deploying" # held by deploy; the guard leaves the services alone meanwhile
DEPLOY_WAIT="${GAUSS_DEPLOY_WAIT:-90}" # seconds a deploy waits for the services to come up
# balance: safe, reversible load shedding (GAU-126). GAUSS_BALANCE=0 turns it off.
BALANCE="${GAUSS_BALANCE:-1}"
LOCAL_CODER="${GAUSS_LOCAL_CODER:-$HOME/.local/bin/local-coder}"   # optional on-device model server
LOCAL_CODER_PORT="${LOCAL_CODER_PORT:-8089}"   # local-coder's server; Gauss's memory answer model (:3032, opt-in since GAU-184) is never shed
CLEANUP_STAMP="$WATCH_DIR/balance-cleanup"     # balance runs disk-cleanup at most hourly
DISK_CLEANUP="${GAUSS_DISK_CLEANUP:-$HOME/.local/bin/disk-cleanup}" # allowlisted cache cleanup
LEARNING_PAUSED="$WATCH_DIR/learning-paused"      # ml/train/nightly.py skips while this exists
LOWPOWER_BY_BALANCE="$WATCH_DIR/lowpower-by-balance" # only undo Low Power Mode that balance set

tailnet_url() {
  local name
  name=$(tailscale status --json 2>/dev/null | python3 -Ic 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
  [ -n "$name" ] && echo "http://$name" || echo "http://127.0.0.1:8080"
}
PUBLIC_URL="${GAUSS_PUBLIC_URL:-$(tailnet_url)}"
# Where sign-in providers send the browser back to (<AUTH_URL>/api/auth/callback/...).
# Must be reachable from the browser doing the sign-in: http://localhost:8080 for
# demos on this Mac (this Mac can't open its own tailnet name, and Google only
# allows http:// for localhost). Defaults to the tailnet URL.
AUTH_URL="${GAUSS_AUTH_URL:-$PUBLIC_URL}"

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

plist() { # plist <label> <dir> <log> <keepalive|nightly|minutely> <arg>...; PLIST_DATA=<dir> overrides <dir>/data
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
    <key>BETTER_AUTH_URL</key><string>$(xml "$AUTH_URL")</string>
    <key>MESH_STORE_PATH</key><string>$(xml "${PLIST_DATA:-$dir/data}/mesh/devices.json")</string>
    <key>COMMERCE_DB_PATH</key><string>$(xml "${PLIST_DATA:-$dir/data}/commerce/commerce.db")</string>
${PLIST_DATA:+    <key>GAUSS_BEDROCK_DIR</key><string>$(xml "$PLIST_DATA/bedrock")</string>
}    <key>ALLOWED_ORIGINS</key><string>$(xml "$PUBLIC_URL,$AUTH_URL,http://127.0.0.1:8080,http://localhost:8080")</string>
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
# Every call is `phone -key K -every N <title> <message>`; a new alert is also an event.
phone() {
  [ "${1:-}" = -key ] && alert_event "${2:-}" "${4:-1h}" "${5:-}" "${6:-}"
  [ -x "$ARGO" ] && "$ARGO" notify "$@" >/dev/null 2>&1 || true
}

# Events (GAU-164): one JSON object per line in events.jsonl, so the timeline before a crash
# is one file instead of four free-text logs. Every line carries the SHAs live and the
# fallback were on and the memory and power state at that moment. deploy.ts writes the same
# format. Rotated by size, one old file kept.
EVENTS="${GAUSS_EVENTS_LOG:-$LOGS/events.jsonl}"
EVENTS_MAX_KB="${GAUSS_EVENTS_MAX_KB:-5120}"
BOOT_STATE="$WATCH_DIR/boottime"
MEMORY_TSV="${MEM_GUARD_LOG:-$LOGS/memory.tsv}"       # written by ~/.local/bin/mem-guard, not this repo
MEM_GUARD="${GAUSS_MEM_GUARD:-$HOME/.local/bin/mem-guard}"
DIAG_DIRS="${GAUSS_DIAG_DIRS:-/Library/Logs/DiagnosticReports:$HOME/Library/Logs/DiagnosticReports}"

# Reasons are free text (alert bodies, paths, git output): drop credentials in URLs, query
# strings and token=/secret=/password=/key= values before they reach a log.
redact() {
  sed -E -e 's#(://)[^/@ ]+@#\1#g' -e 's#(https?://[^ ?"]*)\?[^ "]*#\1?<redacted>#g' \
    -e 's#([A-Za-z_]*([Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Kk][Ee][Yy]))=[^ &"]+#\1=<redacted>#g'
}
json_str() { # json_str <text>: a JSON string literal (redacted; control characters other than \t \n \r dropped)
  local s; s=$(printf '%s' "$1" | redact | LC_ALL=C tr -d '\000-\010\013\014\016-\037')
  s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//$'\t'/\\t}; s=${s//$'\r'/\\r}; s=${s//$'\n'/\\n}
  printf '"%s"' "$s"
}
json_num() { [[ "${1:-}" =~ ^-?[0-9]+$ ]] && printf '%s' "$1" || printf null; }
json_opt() { [ -n "${1:-}" ] && json_str "$1" || printf null; }

event() { # event <event> <label> <reason> [key=text | key:=json]...: append one line; never fails the caller
  local name=$1 label=$2 reason=$3; shift 3
  local live sha="" fb="" level swap _ batt pct ac=false kv key extra=""
  live=$(live_dir 2>/dev/null) && [ -d "$live" ] && sha=$(git -C "$live" rev-parse HEAD 2>/dev/null) || true
  ready_record && fb=$READY_SHA || true
  read -r level swap _ < <(memory_stats)
  batt=$(pmset -g batt 2>/dev/null || true); pct=$(grep -Eo '[0-9]+%' <<<"$batt" | head -1 | tr -d % || true)
  [[ "$batt" == *"'AC Power'"* ]] && ac=true
  for kv in "$@"; do
    key=${kv%%=*}
    if [[ "$key" == *: ]]; then extra+=",$(json_str "${key%:}"):${kv#*=}"; else extra+=",$(json_str "$key"):$(json_str "${kv#*=}")"; fi
  done
  local line; line=$(printf '{"ts":"%s","host":%s,"event":%s,"label":%s,"reason":%s,"live_sha":%s,"fallback_sha":%s,"pressure":%s,"swap_mb":%s,"battery":%s,"on_ac":%s%s}' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_str "$(hostname -s 2>/dev/null || true)")" "$(json_str "$name")" "$(json_str "$label")" \
    "$(json_str "$reason")" "$(json_opt "$sha")" "$(json_opt "$fb")" "$(json_num "$level")" "$(json_num "$swap")" "$(json_num "$pct")" "$ac" "$extra")
  mkdir -p "$(dirname "$EVENTS")" 2>/dev/null || return 0
  if [ $(( $(stat -f %z "$EVENTS" 2>/dev/null || echo 0) / 1024 )) -ge "$EVENTS_MAX_KB" ]; then mv -f "$EVENTS" "$EVENTS.1" 2>/dev/null || true; fi
  printf '%s\n' "$line" >>"$EVENTS" 2>/dev/null || true
  return 0
}

# The guard re-sends an alert every minute while it holds and argo rate-limits the texts;
# log it as an event once per key per its own interval, not every minute.
alert_event() { # alert_event <key> <every: 30m|1h> <title> <message>
  local stamp="$WATCH_DIR/alerts/$1" mins
  case "$2" in *m) mins=${2%m} ;; *h) mins=$(( ${2%h} * 60 )) ;; *) mins=60 ;; esac
  [[ "$mins" =~ ^[0-9]+$ ]] || mins=60
  [ -n "$(find "$stamp" -mmin -"$mins" 2>/dev/null)" ] && return 0
  mkdir -p "$WATCH_DIR/alerts" 2>/dev/null && touch "$stamp" 2>/dev/null || true
  event alert "$1" "$3: $4"
}

boot_epoch() { sysctl -n kern.boottime 2>/dev/null | sed -nE 's/^[{] sec = ([0-9]+),.*/\1/p'; }
iso_utc() { date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }

# Boot breadcrumb. The 2026-10-21 reset left no panic report, an empty unified log and nothing
# in `last`. So on the first guard run after kern.boottime changes, record what we still know:
# the last signs of life (the guard's minutely heartbeat, the last event, the last memory.tsv
# row), any panic or JetsamEvent report since the previous boot, and pmset's shutdown cause.
boot_check() {
  local now prev; now=$(boot_epoch); [ -n "$now" ] || return 0
  prev=$(cat "$BOOT_STATE" 2>/dev/null || true)
  [ "$now" = "$prev" ] && return 0
  mkdir -p "$WATCH_DIR" && echo "$now" >"$BOOT_STATE"
  [[ "$prev" =~ ^[0-9]+$ ]] || return 0 # first run ever: nothing to compare with
  # Runs before watch_peers touches the heartbeat, so its mtime is the last minute the old boot was alive.
  local seen="" seen_hm="?" last_ev="" mem="" mem_level="" mem_swap="" reports="" cause="" ref d f
  if [ -e "$GUARD_HEARTBEAT" ]; then seen=$(iso_utc "$(stat -f %m "$GUARD_HEARTBEAT")"); seen_hm=$(date -r "$(stat -f %m "$GUARD_HEARTBEAT")" +%H:%M); fi
  last_ev=$(tail -1 "$EVENTS" 2>/dev/null | sed -nE 's/^[{]"ts":"([^"]+)".*/\1/p' || true)
  mem=$(tail -1 "$MEMORY_TSV" 2>/dev/null | grep -v '^ts' || true)
  if [ -n "$mem" ]; then
    mem_level=$(cut -f2 <<<"$mem"); mem_swap=$(cut -f9 <<<"$mem")
    mem="$(cut -f1 <<<"$mem") pressure $(pressure_name "$mem_level"), swap ${mem_swap} GB"
  fi
  ref=$(mktemp) && touch -t "$(date -r "$prev" +%Y%m%d%H%M.%S)" "$ref"
  local IFS=:
  for d in $DIAG_DIRS; do
    for f in $(find "$d" -maxdepth 1 \( -name '*.panic' -o -name 'JetsamEvent*' \) -newer "$ref" 2>/dev/null | tr '\n' ':'); do
      reports+="${reports:+ }${f##*/}"
    done
  done
  unset IFS; rm -f "$ref"
  cause=$(pmset -g log 2>/dev/null | grep 'Shutdown Cause' | tail -1 | sed -nE 's/.*Cause: *(-?[0-9]+).*/\1/p' || true)
  local summary="restarted at ~$(date -r "$now" +%H:%M) (last seen ${seen_hm}"
  [ -n "$mem_level" ] && summary+=", pressure $(pressure_name "$mem_level"), swap ${mem_swap} GB"
  summary+="; reports: ${reports:-none}; shutdown cause: ${cause:-unknown})"
  event boot "" "$summary" prev_boot="$(iso_utc "$prev")" boot="$(iso_utc "$now")" last_seen="$seen" \
    last_event="$last_ev" last_memory="$mem" reports="$reports" shutdown_cause="$cause"
  phone -key boot -every 10m "Gauss: $(hostname -s 2>/dev/null || echo Mac) $summary" \
    "If nobody restarted it, the timeline is in: gauss-services.sh events --since 6h"
}

# memory.tsv is sampled every 10 min by gauss-tpm-watch. While memory is short, sample it every
# minute as well, so the minutes before a crash are on record. mem-guard lives outside this repo.
memory_sample() { # memory_sample <pressure level> <swap MB>
  { [ "$1" -ge "$MEM_SHED_LEVEL" ] || swap_high "$2"; } || return 0
  [ -x "$MEM_GUARD" ] && [ -z "$(find "$MEMORY_TSV" -mmin -1 2>/dev/null)" ] || return 0
  "$MEM_GUARD" sample >/dev/null 2>&1 || true
}

events_show() { # events [--since 30m|2h|1d] [--json]: timeline from events.jsonl (and its rotated file)
  local since=24h json=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --since) since=${2:-24h}; shift ;;
      --json) json=1 ;;
      "") ;;
      *) echo "usage: $0 events [--since 30m|2h|1d] [--json]" >&2; return 2 ;;
    esac
    shift
  done
  [[ "$since" =~ ^[0-9]+[mhd]$ ]] || { echo "--since takes e.g. 30m, 2h or 1d" >&2; return 2; }
  python3 -Ic '
import json, sys
from datetime import datetime, timedelta, timezone
n, unit = int(sys.argv[1][:-1]), sys.argv[1][-1]
cut = datetime.now(timezone.utc) - timedelta(minutes=n * {"m": 1, "h": 60, "d": 1440}[unit])
raw, bad, shown = sys.argv[2] == "1", 0, 0
for path in sys.argv[3:]:
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
    except OSError:
        continue
    for line in lines:
        try:
            e = json.loads(line)
            ts = datetime.strptime(e["ts"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        except Exception:
            bad += 1
            continue
        if ts < cut:
            continue
        shown += 1
        if raw:
            print(line)
            continue
        sha = lambda k: (e.get(k) or "-")[:7]
        lvl = {1: "normal", 2: "warn", 4: "critical"}.get(e.get("pressure"), "?")
        swap = "%.1f GB" % (e["swap_mb"] / 1024) if isinstance(e.get("swap_mb"), (int, float)) else "?"
        power = "%s%% %s" % (e.get("battery", "?"), "AC" if e.get("on_ac") else "battery") if e.get("battery") is not None else ("AC" if e.get("on_ac") else "?")
        print("%s  %-17s %-28s %s  [live %s, fallback %s | %s, swap %s | %s]" % (
            ts.astimezone().strftime("%m-%d %H:%M:%S"), e.get("event", "?"), e.get("label") or "-",
            e.get("reason", ""), sha("live_sha"), sha("fallback_sha"), lvl, swap, power))
if not raw and not shown:
    print("no events in the last %s" % sys.argv[1])
if bad:
    print("(%d unreadable lines skipped)" % bad, file=sys.stderr)
' "$since" "$json" "$EVENTS.1" "$EVENTS"
}

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
memory_stats() { # prints "<kernel pressure level> <swap used MB> <free%>"
  # Decide on the kernel's level, never on memory_pressure's "free percentage": it counts
  # compressible memory as free and read 40-56% on the dev Mac while the kernel said warn. Swap
  # "% used" is no better: macOS adds swap files on demand, so 2.7 of 3 GB (89%) was a steady state.
  # free% is only shown.
  local level swap free
  level=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null || true)
  swap=$(sysctl -n vm.swapusage 2>/dev/null | awk '{u=$6; gsub(/M/,"",u); print int(u)}' || true)
  free=$(memory_pressure -Q 2>/dev/null | awk -F': ' '/free percentage/{gsub(/%/,"",$2); print $2+0}' || true)
  echo "${level:-1} ${swap:-0} ${free:-100}"
}
pressure_name() { case "$1" in 1) echo normal ;; 2) echo warn ;; 4) echo critical ;; *) echo "level $1" ;; esac; }
gb() { awk -v m="$1" 'BEGIN{printf "%.1f", m/1024}'; } # MB -> "x.y"
swap_high() { [ "$1" -ge $((SWAP_MAX_GB * 1024)) ]; }  # swap_high <swap MB>
# Disk: swap files live on the boot volume, so a near-full disk turns memory
# pressure into killed apps and failed builds (seen: 5 GB free with 5 GB swap).
disk_free_gb() { df -g / 2>/dev/null | awk 'NR==2{print $4+0}'; }
disk_alerts() { # disk_alerts <free GB>
  [ "${1:-999}" -lt "$DISK_MIN_GB" ] && phone -key disk-low -every 6h "Gauss: disk ${1} GB free" \
    "Swap and builds need room; below ${DISK_MIN_GB} GB macOS may kill apps. Clear caches or old builds."
  return 0
}
top_memory() { ps -Acmo rss=,comm= 2>/dev/null | awk 'NR==1{printf "%s %.1f GB", $2, $1/1048576}'; }

memory_alerts() { # memory_alerts <pressure level> <swap used MB>
  local level=$1 swap=$2
  if [ "$level" -ge "$MEM_ALERT_LEVEL" ]; then
    phone -key memory-low -every 30m "Gauss: memory pressure $(pressure_name "$level")" \
      "Background work may be killed. Biggest: $(top_memory). Close apps or stop a build."
  fi
  if swap_high "$swap"; then
    phone -key swap-high -every 1h "Gauss: swap $(gb "$swap") GB" \
      "The Mac is short of memory and slowing down, and swap fills the disk. Biggest: $(top_memory)."
  fi
}

# Redundancy: this guard and Argo watch each other. The guard touches a
# heartbeat Argo checks (tools/argo/watch.go); the guard restarts Argo and
# mesh-heal when theirs go stale, and the services after two failed health
# checks in a row. At most WATCH_MAX_KICKS restarts per job per hour, then
# it only alerts: something that dies on start needs a human.
mtime_age_min() { local m; m=$(stat -f %m "$1" 2>/dev/null) || { echo 99999; return; }; echo $(( ($(date +%s) - m) / 60 )); }
loaded() { launchctl print "$UID_DOMAIN/$1" >/dev/null 2>&1; }

recent_kicks() { { awk -v l="$1" -v n="$(date +%s)" '$1==l && n-$2<3600' "$WATCH_KICKS" 2>/dev/null || true; } | wc -l | tr -d ' '; }

kick() { # kick <label> <reason>: rate-limited launchctl kickstart, logged and alerted
  local label=$1 reason=$2 now; now=$(date +%s)
  local recent; recent=$(recent_kicks "$label")
  if [ "$recent" -ge "$WATCH_MAX_KICKS" ]; then
    phone -key "watch-$label" -every 1h "Gauss: $label keeps failing" "$reason after $recent restarts this hour. Check its log."
    return 0
  fi
  echo "$label $now" >>"$WATCH_KICKS"
  awk -v n="$now" 'n-$2<86400' "$WATCH_KICKS" >"$WATCH_KICKS.tmp" 2>/dev/null && mv "$WATCH_KICKS.tmp" "$WATCH_KICKS"
  if launchctl kickstart -k "$UID_DOMAIN/$label" >/dev/null 2>&1; then
    echo "$(date '+%F %T') watchdog restarted $label: $reason"
    event watchdog_kick "$label" "$reason"
  else
    phone -key "watch-$label" -every 1h "Gauss: can't restart $label" "$reason; launchctl kickstart failed."
  fi
}

watch_peers() {
  mkdir -p "$(dirname "$GUARD_HEARTBEAT")"; touch "$GUARD_HEARTBEAT"
  local age
  # Argo only rewrites state.json on a full probe (~5 min), so allow 15.
  if loaded uk.lightbound.argo && [ ! -e "$HOME/.local/state/argo/disabled" ]; then
    age=$(mtime_age_min "$HOME/.local/state/argo/state.json")
    [ "$age" -gt 15 ] && kick uk.lightbound.argo "no Argo check for ${age} min"
  fi
  if loaded uk.lightbound.mesh-heal; then
    age=$(mtime_age_min "$HOME/.local/share/mesh-heal/state")
    [ "$age" -gt 10 ] && kick uk.lightbound.mesh-heal "no mesh-heal check for ${age} min"
  fi
  # A deploy restarts them on purpose and rolls back by itself. A lock left by a
  # deploy that died stops counting after 30 min.
  if [ -d "$DEPLOY_LOCK" ] && [ "$(mtime_age_min "$DEPLOY_LOCK")" -lt 30 ]; then return 0; fi
  local svc url strikes prefix=uk.lightbound.gauss
  fallback_active && prefix=uk.lightbound.gauss-fallback
  for svc in backend:http://127.0.0.1:3001/health frontend:http://127.0.0.1:8080/; do
    url=${svc#*:}; svc=$prefix-${svc%%:*}
    loaded "$svc" || continue
    strikes="$WATCH_DIR/$svc.strikes"
    if [ "$(code "$url")" = 200 ]; then rm -f "$strikes"; continue; fi
    echo x >>"$strikes"
    [ "$(wc -l <"$strikes" | tr -d ' ')" -ge 2 ] || continue
    rm -f "$strikes"
    # Out of restarts and still down: serve the last known-good build instead of nothing.
    if [ "$prefix" = uk.lightbound.gauss ] && [ "$(recent_kicks "$svc")" -ge "$WATCH_MAX_KICKS" ] && fallback_ready; then
      fallback_on "${svc#uk.lightbound.gauss-} still down after $WATCH_MAX_KICKS restarts this hour" || true
      break
    fi
    kick "$svc" "health check failed twice"
  done
  return 0
}

# Agents are swapped with bootout + bootstrap. bootout returns before the job is
# gone, and bootstrapping too early fails with error 5, so wait for it.
unload() { launchctl bootout "$UID_DOMAIN/$1" 2>/dev/null || true; local _; for _ in $(seq 1 20); do loaded "$1" || break; sleep 0.5; done; }
reload() { unload "$1"; launchctl bootstrap "$UID_DOMAIN" "$2"; } # reload <label> <plist>

# Fallback: a cold standby (built, not loaded, so it costs disk, not memory). Its
# plists live in FALLBACK_STATE, not LaunchAgents, so a reboot always brings up live.
FALLBACK_STATE="$WATCH_DIR/fallback"
FALLBACK_LABELS=(uk.lightbound.gauss-fallback-backend uk.lightbound.gauss-fallback-frontend)
live_dir() { plutil -extract WorkingDirectory raw -o - "$AGENTS/uk.lightbound.gauss-backend.plist" 2>/dev/null; }
# ready holds "<sha> <dir> <epoch>". The dir may contain spaces (this repo lives in
# "Gauss Aurora.worktrees"), so sha is the first word, epoch the last, dir the rest:
# `read -r sha dir _` would cut it at the first space.
ready_record() { # sets READY_SHA READY_DIR READY_AT; 1 if there is no valid record
  local line; IFS= read -r line 2>/dev/null <"$FALLBACK_STATE/ready" || return 1
  READY_SHA=${line%% *}; READY_AT=${line##* }; READY_DIR=${line#* }; READY_DIR=${READY_DIR% *}
  [[ "$READY_SHA" =~ ^[0-9a-f]{7,40}$ && "$READY_AT" =~ ^[0-9]+$ && -n "$READY_DIR" && "$READY_DIR" != "$line" ]]
}
fallback_ready() { # a valid record, both plists and a built site
  ready_record || return 1
  [ -f "$FALLBACK_STATE/${FALLBACK_LABELS[0]}.plist" ] && [ -f "$FALLBACK_STATE/${FALLBACK_LABELS[1]}.plist" ] && [ -f "$READY_DIR/frontend/dist/index.html" ]
}
fallback_active() { loaded "${FALLBACK_LABELS[0]}"; }

fallback_on() { # fallback_on <reason>: swap live for the fallback on the same ports
  fallback_ready || { echo "No fallback prepared: $0 fallback prepare <dir>" >&2; return 1; }
  local sha=$READY_SHA dir=$READY_DIR l
  for l in "${SERVICES[@]}"; do unload "$l"; done
  for l in "${FALLBACK_LABELS[@]}"; do reload "$l" "$FALLBACK_STATE/$l.plist"; done
  echo "$(date '+%F %T') $1" >"$FALLBACK_STATE/active"
  echo "$(date '+%F %T') failover to fallback ${sha:0:7} ($dir): $1"
  event failover fallback "$1" to="$sha"
  phone -key fallback -every 1h "Gauss: on fallback" \
    "$1. Serving last known-good ${sha:0:7} on the same URLs. Fix live, then: gauss-services.sh fallback off"
}

fallback_off() { # back to live; the guard gets a fresh set of restarts for it
  local l; for l in "${FALLBACK_LABELS[@]}"; do unload "$l"; done
  for l in "${SERVICES[@]}"; do
    rm -f "$WATCH_DIR/$l.strikes"
    reload "$l" "$AGENTS/$l.plist"
  done
  [ -f "$WATCH_KICKS" ] && { grep -Ev '^uk\.lightbound\.gauss-(backend|frontend) ' "$WATCH_KICKS" >"$WATCH_KICKS.tmp" || true; mv "$WATCH_KICKS.tmp" "$WATCH_KICKS"; }
  rm -f "$FALLBACK_STATE/active"
  event failback fallback "back on live"
  echo "Back on live. If it fails again, the guard fails over again after $WATCH_MAX_KICKS restarts."
}

fallback_state() { # "ok|no <description>" for status and check
  if fallback_active; then echo "no serving from fallback since $(cut -d' ' -f1-2 "$FALLBACK_STATE/active" 2>/dev/null): fix live, then '$0 fallback off'"
  elif fallback_ready; then echo "ok fallback ready: ${READY_SHA:0:7}, prepared $(date -r "$READY_AT" '+%F %H:%M') (cold standby)"
  else echo "ok fallback: none prepared (warning: '$0 fallback prepare <dir>' before the next deploy)"
  fi
}

fallback_prepare() { # fallback_prepare <dir> [sha]: check out, install, build, write plists; never loads them
  local live dir sha level _
  live=$(live_dir) && [ -d "$live" ] || { echo "No live install ($AGENTS/uk.lightbound.gauss-backend.plist): run install first" >&2; return 1; }
  fallback_active && { echo "The fallback is serving now; '$0 fallback off' before preparing a new one." >&2; return 1; }
  dir=${1:?usage: $0 fallback prepare <dir> [sha]}
  sha=$(git -C "$live" rev-parse --verify "${2:-HEAD}^{commit}") || return 1
  read -r level _ < <(memory_stats)
  if [ "$level" -ge "$MEM_SHED_LEVEL" ]; then
    echo "Memory pressure is $(pressure_name "$level"): not installing now (npm ci was killed under pressure on 2026-10-19). Retry when normal." >&2; return 1
  fi
  if [ -e "$dir" ]; then
    dir=$(cd "$dir" && pwd)
    local prev=""; ready_record && prev=$READY_DIR
    # Only ever re-point a directory this command made: never someone's working checkout.
    [ "$dir" = "$prev" ] || { echo "$dir exists and is not the current fallback; pick a new path." >&2; return 1; }
    git -C "$dir" checkout -q --detach "$sha" || return 1
  else
    git -C "$live" worktree add -q --detach "$dir" "$sha" || return 1; dir=$(cd "$dir" && pwd)
  fi
  # Explicit returns throughout: deploy calls this in a condition, where set -e is off.
  [ "$dir" != "$live" ] || { echo "The fallback must not be the live checkout." >&2; return 1; }
  local lock; lock=$(shasum "$dir/package-lock.json" | cut -d' ' -f1) || return 1
  if [ "$(cat "$dir/node_modules/.gauss-lock" 2>/dev/null)" != "$lock" ]; then
    echo "Installing dependencies in $dir ..."
    (cd "$dir" && PATH="$(dirname "$NODE"):$PATH" npm ci --no-audit --no-fund >/dev/null) || return 1
    echo "$lock" >"$dir/node_modules/.gauss-lock"
  fi
  echo "Building the fallback site (same-origin API) ..."
  (cd "$dir" && VITE_HELIO_PROXY_URL=same-origin "$NODE" node_modules/vite/bin/vite.js build --config frontend/vite.config.ts >/dev/null) || return 1
  mkdir -p "$FALLBACK_STATE" "$LOGS"
  # Same ports, live data and live .env (read in place, never copied): only one of the
  # two ever runs, and devices, accounts and telemetry carry over in both directions.
  PLIST_DATA="$live/data" plist "${FALLBACK_LABELS[0]}" "$dir" "$LOGS/fallback-backend.log" keepalive \
    "$NODE" --env-file-if-exists="$live/.env" --import tsx backend/server.ts >"$FALLBACK_STATE/${FALLBACK_LABELS[0]}.plist"
  PLIST_DATA="$live/data" plist "${FALLBACK_LABELS[1]}" "$dir" "$LOGS/fallback-frontend.log" keepalive \
    "$NODE" node_modules/vite/bin/vite.js preview --config frontend/vite.config.ts --host 127.0.0.1 --port 8080 --strictPort \
    >"$FALLBACK_STATE/${FALLBACK_LABELS[1]}.plist"
  plutil -lint -s "$FALLBACK_STATE/${FALLBACK_LABELS[0]}.plist" "$FALLBACK_STATE/${FALLBACK_LABELS[1]}.plist" || return 1
  echo "$sha $dir $(date +%s)" >"$FALLBACK_STATE/ready"
  event fallback_prepared "${sha:0:7}" "fallback prepared at $dir"
  echo "Fallback ready: ${sha:0:7} at $dir (cold: not running, no memory used)."
}

install_agents() { # install_agents <checkout-dir>: build the site, write and (re)load the agents
  local dir=$1 l
  [ -f "$dir/backend/server.ts" ] || { echo "$dir is not a Gauss checkout" >&2; return 1; }
  mkdir -p "$LOGS" "$dir/data/mesh" "$dir/data/commerce"
  echo "Building the frontend in $dir (same-origin API) ..."
  (cd "$dir" && VITE_HELIO_PROXY_URL=same-origin "$NODE" node_modules/vite/bin/vite.js build --config frontend/vite.config.ts >/dev/null) || return 1
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
    plutil -lint -s "$AGENTS/$l.plist" || return 1
    reload "$l" "$AGENTS/$l.plist" || return 1
  done
}

# What a deploy can break, and so what decides a rollback. The rest of `check`
# (network, space weather, memory service, Argo) can be off for reasons a rollback
# wouldn't fix, so it is reported after a deploy, never acted on.
deploy_ready() { # deploy_ready <dir> <seconds>: poll until the services answer, or give up
  local dir=$1 waited=0
  until [ "$(code http://127.0.0.1:3001/health)" = 200 ] && [ "$(code http://127.0.0.1:8080/)" = 200 ] \
    && [ "$(code http://127.0.0.1:8080/api/system/connectivity)" = 200 ] \
    && ! grep -rqs 'ts\.net' "$dir/frontend/dist/assets"; do
    [ "$waited" -ge "$2" ] && return 1
    sleep 3; waited=$((waited + 3)); touch "$DEPLOY_LOCK" 2>/dev/null || true
  done
}

switch_live() { # switch_live <dir> <from sha> <to sha>: check out, npm ci if the lockfile changed, reinstall
  git -C "$1" checkout -q --detach "$3" || return 1
  if [ ! -d "$1/node_modules" ] || ! git -C "$1" diff --quiet "$2" "$3" -- package-lock.json; then
    echo "package-lock.json changed: installing dependencies in $1 ..."
    (cd "$1" && PATH="$(dirname "$NODE"):$PATH" npm ci --no-audit --no-fund >/dev/null) || return 1
  fi
  install_agents "$1"
}

deploy() { # deploy <commit> [fallback-dir]
  local live sha prev level fbdir=${2:-} _
  live=$(live_dir) && [ -d "$live" ] || { echo "No live install ($AGENTS/uk.lightbound.gauss-backend.plist): run install first" >&2; return 1; }
  fallback_active && { echo "The fallback is serving now: fix live and '$0 fallback off' before deploying." >&2; return 1; }
  git -C "$live" fetch -q origin 2>/dev/null || echo "(git fetch failed; using the commits already in $live)"
  sha=$(git -C "$live" rev-parse -q --verify "${1:?usage: $0 deploy <commit> [fallback-dir]}^{commit}") \
    || { echo "Unknown commit '$1' in $live." >&2; return 1; }
  prev=$(git -C "$live" rev-parse HEAD) || return 1
  [ "$sha" != "$prev" ] || { echo "Live is already at ${sha:0:7}."; return 0; }
  read -r level _ < <(memory_stats)
  if [ "$level" -ge "$MEM_SHED_LEVEL" ]; then
    echo "Memory pressure is $(pressure_name "$level"): not deploying now (npm ci and the build need headroom). Retry when normal." >&2; return 1
  fi
  # Live's data files (telemetry, models) change in place and carry over; code must not.
  local dirty; dirty=$(git -C "$live" status --porcelain --untracked-files=no | cut -c4- | grep -Ev '^(data|ml/models)/' || true)
  [ -z "$dirty" ] || { printf 'Live has local code changes; not deploying over them:\n%s\n' "$dirty" >&2; return 1; }
  mkdir -p "$WATCH_DIR" "$LOGS"
  if ! mkdir "$DEPLOY_LOCK" 2>/dev/null; then
    [ "$(mtime_age_min "$DEPLOY_LOCK")" -ge 30 ] || { echo "Another deploy is running ($DEPLOY_LOCK)." >&2; return 1; }
    touch "$DEPLOY_LOCK" # left by a deploy that died
  fi
  trap 'rmdir "$DEPLOY_LOCK" 2>/dev/null || true' EXIT

  # The standby becomes what runs now, if it is healthy: never swap a good fallback for a broken live.
  [ -z "$fbdir" ] && ready_record && fbdir=$READY_DIR
  if [ -z "$fbdir" ]; then
    echo "warning: no fallback to refresh (pass a path: $0 deploy <commit> <fallback-dir>); rollback to ${prev:0:7} still works."
  elif ready_record && [ "$READY_SHA" = "$prev" ] && [ "$READY_DIR" = "$(cd "$fbdir" 2>/dev/null && pwd)" ]; then
    echo "Fallback already at ${prev:0:7}."
  elif deploy_ready "$live" 0; then
    fallback_prepare "$fbdir" "$prev" || { echo "Couldn't refresh the fallback; not deploying." >&2; return 1; }
  else
    local kept=${READY_SHA:-none}
    echo "Live isn't healthy now, so the fallback stays at ${kept:0:7} rather than becoming ${prev:0:7}."
  fi

  echo "Deploying ${prev:0:7} -> ${sha:0:7} in $live ..."
  git -C "$live" checkout -q --detach "$sha" \
    || { echo "Checkout refused (a local data file conflicts with ${sha:0:7}?): nothing changed." >&2; return 1; }
  if switch_live "$live" "$prev" "$sha" && deploy_ready "$live" "$DEPLOY_WAIT"; then
    echo "$(date '+%F %T') deployed ${sha:0:7} (was ${prev:0:7})" >>"$LOGS/deploy.log"
    event deploy "${sha:0:7}" "deployed ${sha:0:7} (was ${prev:0:7})" from="$prev" to="$sha" result=ok
    echo "Deployed ${sha:0:7}. Full checklist (for information; only the services decide a rollback):"
    check || true
    return 0
  fi
  echo "${sha:0:7} didn't come up within ${DEPLOY_WAIT}s: rolling back to ${prev:0:7} ..." >&2
  event deploy "${sha:0:7}" "${sha:0:7} didn't come up within ${DEPLOY_WAIT}s" from="$prev" to="$sha" result=failed
  if switch_live "$live" "$sha" "$prev" && deploy_ready "$live" "$DEPLOY_WAIT"; then
    echo "$(date '+%F %T') ${sha:0:7} failed, rolled back to ${prev:0:7}" >>"$LOGS/deploy.log"
    event rollback "${prev:0:7}" "${sha:0:7} failed, rolled back to ${prev:0:7}" from="$sha" to="$prev" result=ok
    phone -key deploy -every 10m "Gauss: deploy rolled back" \
      "${sha:0:7} didn't come up; live is back on ${prev:0:7}. Logs: ~/Library/Logs/gauss/backend.log"
    echo "Rolled back: live is on ${prev:0:7} again." >&2
    return 1
  fi
  echo "$(date '+%F %T') ${sha:0:7} failed and rollback to ${prev:0:7} failed" >>"$LOGS/deploy.log"
  event rollback "${prev:0:7}" "${sha:0:7} failed and rollback to ${prev:0:7} failed" from="$sha" to="$prev" result=failed
  fallback_on "deploy of ${sha:0:7} failed and rolling back to ${prev:0:7} failed too" \
    || phone -key deploy -every 10m "Gauss: down after a deploy" "${sha:0:7} failed, rollback failed and there is no fallback. Needs a person."
  return 1
}

# Dev / R&D: any checkout but live or fallback, in the foreground, on its own ports
# and its own data/, with its site's /api pointed at its own backend. Explicit env
# beats the checkout's .env (node --env-file never overrides), so a copied .env with
# live paths or PROXY_PORT=3001 can't reach production.
dev_run() { # dev_run <checkout-dir>
  local dir live fdir level _
  dir=$(cd "${1:?usage: $0 dev <checkout-dir>}" && pwd)
  [ -f "$dir/backend/server.ts" ] || { echo "$dir is not a Gauss checkout" >&2; return 1; }
  live=$(live_dir || true); fdir=""; ready_record && fdir=$READY_DIR
  if [ "$dir" = "${live:-}" ] || [ "$dir" = "${fdir:-}" ]; then
    echo "$dir is the $([ "$dir" = "${live:-}" ] && echo live || echo fallback) checkout; develop in another worktree." >&2; return 1
  fi
  read -r level _ < <(memory_stats)
  if [ "$level" -ge "$MEM_SHED_LEVEL" ]; then
    echo "Memory pressure is $(pressure_name "$level"): a dev server now risks the live services. Close something first." >&2; return 1
  fi
  local api="${GAUSS_DEV_API_PORT:-3101}" web="${GAUSS_DEV_WEB_PORT:-5174}"
  [ "$api" != 3001 ] && [ "$web" != 8080 ] || { echo "Ports 3001 and 8080 belong to live." >&2; return 1; }
  [ "$(code "http://127.0.0.1:$api/health")" = down ] || { echo "Port $api is in use (another dev server?)." >&2; return 1; }
  [ -d "$dir/node_modules" ] || { echo "No node_modules in $dir: run npm ci there first." >&2; return 1; }
  [ "${GAUSS_DEV_DRY:-0}" = 1 ] && { echo "dev ok: $dir site http://127.0.0.1:$web api :$api"; return 0; }
  local origin="http://127.0.0.1:$web"; mkdir -p "$dir/data/mesh" "$dir/data/commerce"
  cd "$dir"
  env PROXY_PORT="$api" GAUSS_PUBLIC_URL="$origin" BETTER_AUTH_URL="$origin" ALLOWED_ORIGINS="$origin,http://localhost:$web" \
    GAUSS_BEDROCK_DIR="$dir/data/bedrock" MESH_STORE_PATH="$dir/data/mesh/devices.json" COMMERCE_DB_PATH="$dir/data/commerce/commerce.db" \
    "$NODE" --env-file-if-exists=.env --import tsx backend/server.ts &
  local pid=$!; trap "kill $pid 2>/dev/null || true" EXIT INT TERM
  echo "Dev: site $origin, API http://127.0.0.1:$api (live stays on :8080/:3001). Ctrl-C stops both."
  GAUSS_DEV_WEB_PORT="$web" GAUSS_API_TARGET="http://127.0.0.1:$api" VITE_HELIO_PROXY_URL=same-origin \
    "$NODE" node_modules/vite/bin/vite.js --config frontend/vite.config.ts
}

awake_guard() { # run every minute by the awake agent
  boot_check || true # first, before watch_peers refreshes the heartbeat it reads
  watch_peers
  local batt pct
  batt=$(pmset -g batt); pct=$(grep -Eo '[0-9]+%' <<<"$batt" | head -1 | tr -d % || true)
  battery_alerts "$batt" "$pct"
  local level swap free; read -r level swap free < <(memory_stats)
  memory_alerts "$level" "$swap"
  memory_sample "$level" "$swap"
  disk_alerts "$(disk_free_gb)"
  balance || true
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

lowpower_on() { pmset -g 2>/dev/null | awk '$1=="lowpowermode"{v=$2} END{print v+0}'; }

# balance: when memory, battery or disk run short, shed *optional* load. Every action is safe to
# repeat and is undone automatically when conditions recover. It never touches the live
# backend/frontend, other people's processes or user files:
#   memory short or battery low  -> stop the local model server (local-coder; restarts on demand)
#   battery low on battery power  -> pause nightly learning; Low Power Mode if `awake setup` allowed it
#   back on AC (or battery > warn+10%) -> resume learning; undo Low Power Mode that balance set
#   disk below DISK_MIN_GB        -> allowlisted disk-cleanup (rebuildable caches only)
cleanup_due() { [ ! -f "$CLEANUP_STAMP" ] || [ -n "$(find "$CLEANUP_STAMP" -mmin +59 2>/dev/null)" ]; }

balance() { # balance [--dry-run]
  local dry=0; [ "${1:-}" = --dry-run ] && dry=1
  if [ "$BALANCE" = 0 ]; then [ $dry = 1 ] && echo "balance is off (GAUSS_BALANCE=0)"; return 0; fi
  local batt pct on_battery=0 level swap free disk mem_short=0 batt_low=0 recovered=0
  batt=$(pmset -g batt); pct=$(grep -Eo '[0-9]+%' <<<"$batt" | head -1 | tr -d % || true)
  [[ "$batt" != *"'AC Power'"* ]] && [ -n "$pct" ] && on_battery=1
  read -r level swap free < <(memory_stats); disk=$(disk_free_gb)
  { [ "$level" -ge "$MEM_SHED_LEVEL" ] || swap_high "$swap"; } && mem_short=1
  [ $on_battery = 1 ] && [ "$pct" -le "$AWAKE_WARN_BATTERY" ] && batt_low=1
  { [ $on_battery = 0 ] || [ "${pct:-0}" -gt $((AWAKE_WARN_BATTERY + 10)) ]; } && recovered=1
  local notify=() quiet=()
  act() { if [ $dry = 1 ]; then echo "would: $*"; else "$@" >/dev/null 2>&1 || true; fi; }

  # Only local-coder's own server, by its port. Gauss's memory answer model is also an
  # mlx_lm.server (same model, :3032, kept alive by launchd); matching it by name restarted it
  # every minute on 2026-10-19.
  local coder="mlx_lm.server.*--port $LOCAL_CODER_PORT"
  if { [ $mem_short = 1 ] || [ $batt_low = 1 ]; } && pgrep -f "$coder" >/dev/null 2>&1; then
    act pkill -f "$coder"; notify+=("stopped the local model server")
  fi
  if [ $batt_low = 1 ]; then
    if [ ! -f "$LEARNING_PAUSED" ]; then act mkdir -p "$WATCH_DIR"; act touch "$LEARNING_PAUSED"; quiet+=("paused nightly learning"); fi
    if [ "$(lowpower_on)" = 0 ] && sudo -n -l /usr/bin/pmset -a lowpowermode 1 >/dev/null 2>&1; then
      act sudo -n /usr/bin/pmset -a lowpowermode 1; act touch "$LOWPOWER_BY_BALANCE"; notify+=("Low Power Mode on")
    fi
  elif [ $recovered = 1 ]; then
    if [ -f "$LEARNING_PAUSED" ]; then act rm -f "$LEARNING_PAUSED"; quiet+=("resumed nightly learning"); fi
    if [ -f "$LOWPOWER_BY_BALANCE" ]; then
      act sudo -n /usr/bin/pmset -a lowpowermode 0; act rm -f "$LOWPOWER_BY_BALANCE"; notify+=("Low Power Mode off")
    fi
  fi
  # At most hourly, and claimed only when it freed space: with nothing left to clear it ran,
  # and reported "cleared", every minute.
  if [ "$disk" -lt "$DISK_MIN_GB" ] && [ -x "$DISK_CLEANUP" ] && cleanup_due; then
    act mkdir -p "$WATCH_DIR"; act touch "$CLEANUP_STAMP"
    act "$DISK_CLEANUP" --apply --if-below "$DISK_MIN_GB"
    if [ $dry = 0 ]; then
      local after; after=$(disk_free_gb)
      [ "${after:-0}" -gt "$disk" ] && notify+=("cleared rebuildable caches (${disk} to ${after} GB free)")
    fi
  fi

  # ${a[@]+"${a[@]}"}: empty arrays are "unbound" under set -u in macOS's bash 3.2
  local all=(${notify[@]+"${notify[@]}"} ${quiet[@]+"${quiet[@]}"}) state="battery ${pct:-?}%$([ $on_battery = 1 ] && echo ' on battery'), memory $(pressure_name "$level") (${free}% free), swap $(gb "$swap") GB, disk ${disk} GB"
  [ ${#all[@]} = 0 ] && { [ $dry = 1 ] && echo "balanced: nothing to do ($state)"; return 0; }
  local summary; summary=$(IFS=';'; echo "${all[*]}" | sed 's/;/; /g')
  if [ $dry = 1 ]; then echo "would report: $summary ($state)"; return 0; fi
  mkdir -p "$LOGS"; echo "$(date '+%F %T') balance: $summary ($state)" >>"$LOGS/balance.log"
  event balance "" "$summary ($state)"
  if [ ${#notify[@]} -gt 0 ]; then
    local extra=""; [ $mem_short = 1 ] && extra=" Biggest: $(top_memory)."
    phone -key balance -every 1h "Gauss: rebalanced" "$(IFS=';'; echo "${notify[*]}" | sed 's/;/; /g') ($state).$extra"
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

awake_setup() { # one-time sudo: allow exactly the pmset commands the guard and balance use
  local tmp; tmp=$(mktemp)
  printf '%s ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1, /usr/bin/pmset sleepnow, /usr/bin/pmset -a lowpowermode 0, /usr/bin/pmset -a lowpowermode 1\n' "$(id -un)" >"$tmp"
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
  # WPAD_RISK and WIFI_RISK are Argo's warnings: the network works, so they don't fail the check,
  # but the line says what to look at.
  local note=""
  case "$argo" in
    "● OK MY"*|"● OK SG"*) ok=ok ;;
    "● WPAD_RISK MY"*|"● WPAD_RISK SG"*|"● WIFI_RISK MY"*|"● WIFI_RISK SG"*) ok=ok; note=" (warning: \`argo doctor\` says what to change)" ;;
    *) ok=no ;;
  esac
  [[ "$argo" == *stale* ]] && ok=no
  item $ok "network: $argo$note"
}

resilience() { # can background work survive the lid closed, the battery, memory and the network?
  local fail=0 ok batt pct level swap free
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
  read -r level swap free < <(memory_stats)
  [ "$level" -lt "$MEM_ALERT_LEVEL" ] && ! swap_high "$swap" && ok=ok || ok=no
  item $ok "memory pressure $(pressure_name "$level"), swap $(gb "$swap") GB$([ $ok = no ] && echo "; biggest: $(top_memory)")"
  local disk; disk=$(disk_free_gb)
  [ "${disk:-0}" -ge "$DISK_MIN_GB" ] && ok=ok || ok=no
  item $ok "disk ${disk:-?} GB free$([ $ok = no ] && echo " (need ${DISK_MIN_GB}+ for swap and builds)")"
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
  # The path a browser on this Mac takes: page origin -> preview proxy -> backend.
  [ "$(code http://127.0.0.1:8080/api/system/connectivity)" = 200 ] && ok=ok || ok=no
  item $ok "website reaches the API through its own origin (:8080/api)"
  # A build that hardcodes another API origin breaks on this Mac (no tailnet loopback).
  if grep -rqs "ts\.net" "$(launchctl print "$UID_DOMAIN/uk.lightbound.gauss-frontend" 2>/dev/null | awk -F'= ' '/working directory =/{print $2; exit}')/frontend/dist/assets" 2>/dev/null; then
    item no "frontend build is same-origin (it hardcodes an API host: reinstall)"
  else
    item ok "frontend build is same-origin"
  fi
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
    gate = "gate passed" if (m.get("gate") or {}).get("passed") else "gate FAILED" if m.get("gate") else "no gate"
    print("ok last learning run %s UTC (%s, %s, %s)" % (m["trained_at"][:16].replace("T", " "), m["version"], gate, m.get("status", "?")))
except Exception:
    print("no no learning run recorded yet (runs nightly at 03:00)")
' "$dir/ml/models/registry.json" 2>/dev/null || echo "no no learning run recorded yet")
  item "${learned%% *}" "${learned#* }"
  # Memory service (gauss-brain, LaunchAgents from its scripts/memory-services.sh).
  # The backend reads GAUSS_MEMORY_URL from its checkout's .env (e.g. :3022 for the operator instance);
  # probe the same address. Only that one key is read from .env, never the rest of the file.
  local memory_url="${GAUSS_MEMORY_URL:-}"
  [ -z "$memory_url" ] && [ -f "$dir/.env" ] && memory_url=$(sed -n 's/^GAUSS_MEMORY_URL=//p' "$dir/.env" | tail -1)
  memory_url="${memory_url:-http://127.0.0.1:3002}"
  local memory; memory=$({ curl -s -m 5 "$memory_url/api/memory/status" || true; } | python3 -Ic '
import json, sys
try:
    s = json.load(sys.stdin)
    print(("ok" if s.get("ok") and s.get("documents", 0) > 0 else "no") + " memory service (%s): %s documents, %s passages" % (sys.argv[1], s.get("documents", 0), s.get("chunks", 0)))
except Exception:
    print("no memory service not running at %s (gauss-brain: scripts/memory-services.sh install)" % sys.argv[1])
' "$memory_url")
  item "${memory%% *}" "${memory#* }"
  # The chatbot answer model was retired on 2026-10-22 (gauss-brain GAU-184; memory search returns
  # sources). It is opt-in for experiments, so it is reported but never fails the check.
  if [ "$(code "${GAUSS_BRAIN_URL:-http://127.0.0.1:3032}/v1/models")" = 200 ]; then
    item ok "answer model up (${GAUSS_BRAIN_URL:-http://127.0.0.1:3032}; opt-in)"
  else
    item ok "answer model off (retired 2026-10-22, GAU-184; opt-in with GAUSS_BRAIN_MODEL_SERVICE=1)"
  fi
  local fb; fb=$(fallback_state); item "${fb%% *}" "${fb#* }"
  [ $fail = 0 ] && echo "Ready to demo." || echo "Not ready: fix the ✗ items above."
  return $fail
}

case "${1:-}" in
  install)
    dir="$(cd "${2:?usage: $0 install <checkout-dir>}" && pwd)"
    install_agents "$dir"
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
  balance)
    balance "${2:-}"
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
    printf 'fallback %s\n' "$(fallback_state | cut -d' ' -f2-)"
    ;;
  restart)
    for l in "${SERVICES[@]}"; do launchctl kickstart -k "$UID_DOMAIN/$l"; done
    sleep 8
    health
    ;;
  dev)
    dev_run "${2:-}"
    ;;
  deploy)
    deploy "${2:-}" "${3:-}"
    ;;
  events)
    events_show "${2:-}" "${3:-}" "${4:-}"
    ;;
  fallback)
    case "${2:-}" in
      prepare) fallback_prepare "${3:-}" "${4:-}" ;;
      on) fallback_on "switched by hand" ;;
      off) fallback_off ;;
      *) fallback_state | cut -d' ' -f2- ;;
    esac
    ;;
  uninstall)
    for l in "${FALLBACK_LABELS[@]}"; do launchctl bootout "$UID_DOMAIN/$l" 2>/dev/null || true; done
    for l in "${LABELS[@]}"; do
      launchctl bootout "$UID_DOMAIN/$l" 2>/dev/null || true
      rm -f "$AGENTS/$l.plist"
    done
    [ -f "$SUDOERS" ] && { awake_set 0 "uninstalled" || true; echo "To drop the sleep rule too: sudo rm $SUDOERS"; }
    echo "Gauss services removed. Logs kept in $LOGS."
    ;;
  *)
    sed -n '2,18p' "$0"
    exit 2
    ;;
esac
