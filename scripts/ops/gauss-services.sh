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
#   scripts/ops/gauss-services.sh deploy <commit> [fallback-dir] [--emergency <reason>] [--no-fallback]   switch live to <commit>; rolls back by itself if it doesn't come up
#   scripts/ops/gauss-services.sh gates record <checkout-dir>|list   run the five gates on a clean checkout; deploy needs a passing record
#   scripts/ops/gauss-services.sh gates enqueue <checkout-dir>|<commit>   hand a gate run to the queue; the session can then be archived
#   scripts/ops/gauss-services.sh gates queue | priority <pr|sha> front|back | waiting   see/reorder the train, list passes waiting for a person
#   scripts/ops/gauss-services.sh gates result <checkout-dir>|<commit>|status   the queue's one-line result (exit 0 passed, 1 failed, 3 queued)
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
# deploy (GAU-162) refuses a commit that isn't on origin/main or whose exact tree has no
# passing gate record (`gates record`), unless `--emergency <reason>`, which texts the phone.
# Each deploy and rollback is a line in deploy-history.jsonl (by, from, to, tree, gates,
# fallback, result) and an event; `check` says whether live is a recorded deploy.
# It also refuses under memory pressure or over
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
# GAUSS_AWAKE_MIN_BATTERY% (default 40), where it lets the Mac sleep again. It texts
# the phone (via `argo notify`) at GAUSS_AWAKE_WARN_BATTERY% (default 50), at the floor,
# and when the charger can't keep up.
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
# 40%, not the mesh's 10% critical level: heavy jobs never run on battery anyway, and an
# awake Mac drained a worn battery to 10% overnight (2026-10-28), leaving nothing for the
# day. Staying awake on battery only covers short trips away from the charger.
AWAKE_MIN_BATTERY="${GAUSS_AWAKE_MIN_BATTERY:-40}"
AWAKE_WARN_BATTERY="${GAUSS_AWAKE_WARN_BATTERY:-50}" # phone warning (and load shedding) before the floor
# A worn battery holds a fraction of its design capacity, so each percent lasts that much less. At
# 52% health (4 Nov 2026, 365 cycles) 40 -> 28% took 16 min under ordinary load, then the gauge fell
# 28 -> 10% in 8 min of sleep and macOS hibernated with live down. Under BATTERY_WORN_PCT health the
# floor and the warning each rise by BATTERY_WORN_EXTRA points, unless set explicitly.
BATTERY_WORN_PCT="${GAUSS_BATTERY_WORN_PCT:-70}"
BATTERY_WORN_EXTRA="${GAUSS_BATTERY_WORN_EXTRA:-10}"
battery_health() { # full-charge capacity as a % of design, or nothing on a desktop
  ioreg -rn AppleSmartBattery 2>/dev/null \
    | sed -n 's/.*"FullChargeCapacity"=\([0-9]*\).*"DesignCapacity"=\([0-9]*\).*/\1 \2/p' \
    | awk 'NR==1 && $2>0 {printf "%d", $1*100/$2}'
}
BATTERY_HEALTH=$(battery_health || true)
if [ -n "$BATTERY_HEALTH" ] && [ "$BATTERY_HEALTH" -lt "$BATTERY_WORN_PCT" ]; then
  [ -n "${GAUSS_AWAKE_MIN_BATTERY:-}" ] || AWAKE_MIN_BATTERY=$((AWAKE_MIN_BATTERY + BATTERY_WORN_EXTRA))
  [ -n "${GAUSS_AWAKE_WARN_BATTERY:-}" ] || AWAKE_WARN_BATTERY=$((AWAKE_WARN_BATTERY + BATTERY_WORN_EXTRA))
fi
ARGO="${ARGO:-$HOME/.local/bin/argo}"
# Memory uses the kernel's pressure level (kern.memorystatus_vm_pressure_level: 1 normal, 2 warn,
# 4 critical) and swap in GB; see memory_stats for why not "free %" or swap "% used".
MEM_ALERT_LEVEL="${GAUSS_MEM_ALERT_LEVEL:-4}" # phone alert at or above this pressure level
MEM_SHED_LEVEL="${GAUSS_MEM_SHED_LEVEL:-2}"   # balance sheds optional load at or above this level
SWAP_MAX_GB="${GAUSS_SWAP_MAX_GB:-4}"         # ... or at or above this many GB of swap in use
# ... or below this many GB free on the boot volume. Swap files grow on this disk: the 2026-10-22
# 01:00 kernel panic logged "LOW swap space" with 12-13 GB free, so clean up well before that.
# Below DISK_MIN_GB balance clears rebuildable caches quietly: the dev Mac sat under 15 GB in 54% of
# the 2026-10-17..25 samples, so a text there would arrive all day. The text (and a failing check)
# comes below DISK_ALERT_GB, or below DISK_MIN_GB while swap is high: the panic's combination.
DISK_MIN_GB="${GAUSS_DISK_MIN_GB:-15}"
DISK_ALERT_GB="${GAUSS_DISK_ALERT_GB:-12}"   # 8% of samples were under 12 GB; 4% under 8
# mem-guard writes one sample every 10 min (gauss-tpm-watch): footprint GB per owner, which the
# alerts use to say what to close. Sustained warn and swap climbing over an hour are Argo's guard
# texts (GAU-165: guard-memory, guard-swap), so this script doesn't repeat them.
MEM_LOG="${GAUSS_MEM_LOG:-$HOME/Library/Logs/gauss/memory.tsv}"
# macOS's pressure level can still say normal while swap runs away (fl4p/macos-oom-guard, 2026), so
# two faster signals: kern.memorystatus_level (% of memory available) under AVAIL_MIN, and swap
# growing SWAP_FAST_GB within 2.5 min (the 2026-10-17..25 log's biggest rise was 2.7 GB in 10 min).
AVAIL_MIN="${GAUSS_MEM_AVAIL_MIN:-10}"
SWAP_FAST_GB="${GAUSS_SWAP_FAST_GB:-1}"
SWAP_LAST="${GAUSS_SWAP_LAST:-$HOME/Library/Application Support/Gauss/swap-last}" # "<epoch> <swap MB>"
WATCH_DIR="$HOME/Library/Application Support/Gauss"
GUARD_HEARTBEAT="$WATCH_DIR/guard.heartbeat" # Argo restarts the guard if this goes stale
WATCH_KICKS="$WATCH_DIR/watch-kicks"         # "<label> <epoch>" per watchdog restart
WATCH_MAX_KICKS=3
DEPLOY_LOCK="$WATCH_DIR/deploying" # held by deploy; the guard leaves the services alone meanwhile
DEPLOY_WAIT="${GAUSS_DEPLOY_WAIT:-90}" # seconds a deploy waits for the services to come up
DEPLOY_HISTORY="$WATCH_DIR/deploy-history.jsonl" # every deploy and rollback; never rotated (a line per deploy)
DEPLOY_EMERGENCY="" # set by `deploy --emergency <reason>`
DEPLOY_NO_FALLBACK="" # set by `deploy --no-fallback`: go ahead with no standby to refresh (FM-24)
# Gate records (GAU-162), keyed by tree hash: what was tested is exactly what is deployed, even
# after a merge commit or a rebase that leaves the tree unchanged (GAU-161 finding 4).
GATES_DIR="$WATCH_DIR/gates"
GATE_LOCK="${GAUSS_GATE_LOCK:-$HOME/.local/state/gauss-gate.lock}" # shared with agents running gates by hand
# `verify` already runs the full test suite, the ops tests and the production build
# (scripts/verify/verify.ts), so `test` and `build` are not run again as gates of
# their own; their record fields come from verify's log. Halves a gate run.
GATES=(test:ops quality:full verify)
# Gate queue (2026-10-29): sessions held a `claude-heavy --wait 720 ... gates record` each for hours
# (~1 GB of idle sessions on an 8 GB Mac), each with its own npm ci. Now a session enqueues and
# can be archived; one detached runner works through the requests one at a time under claude-heavy
# (memory, power, Argo's guard) in one checkout of its own, reinstalling only when the lockfile changes.
GATES_QUEUE="$GATES_DIR/queue"         # <time>-<tree queued>.req, oldest first; one per tree (its tree= line)
GATES_RESULTS="$GATES_DIR/results.log" # <utc> <sha> <tree> PASSED|FAILED|SKIPPED|ERROR|EXPIRED <detail>, one line per request
GATES_RUNNER="$GATES_DIR/runner"       # held by the one runner (its pid inside)
GATES_SRC="$GATES_DIR/runner.src"      # sha= blob= from= at=: the commit the runner's copy (runner.sh) came from
HEAVY="${GAUSS_HEAVY:-$HOME/.local/bin/claude-heavy}"
GATES_WAIT_MIN="${GAUSS_GATES_WAIT_MIN:-120}" # one claude-heavy wait; the runner asks again when it gives up
GATES_EXPIRE_H="${GAUSS_GATES_EXPIRE_H:-72}"   # a request still waiting after this is dropped (EXPIRED)
# Gatebox (GAU-207 sizing, GAU-223): an Oracle Always Free VM on the tailnet runs the Linux-portable
# gates (npm ci, npm test, quality:full, build) on the exact commit, fetched from public GitHub, through
# the gate user's forced command (scripts/ops/gatebox/cloud-init.yaml). The ops tests and the VCRM need
# macOS, so a deploy record still comes from this Mac; the gatebox screens first, so a commit that fails
# there is FAILED without taking this Mac's memory (16 of 70 guarded gate runs failed, 29 Oct-5 Nov,
# `argo scale`). Off unless a host is set: GAUSS_GATEBOX or one line in $WATCH_DIR/gatebox (a tailnet name).
GATEBOX="${GAUSS_GATEBOX:-$(head -1 "$WATCH_DIR/gatebox" 2>/dev/null || true)}"
GATEBOX_KEY="${GAUSS_GATEBOX_KEY:-$HOME/.ssh/gauss-gate}"
GATEBOX_HOSTS="$WATCH_DIR/gatebox.known_hosts" # the gatebox's host key, pinned on first contact over the tailnet
GATEBOX_REPO="Pallas117/Constellation"         # the only repo gauss-gate-run accepts
# balance: safe, reversible load shedding (GAU-126). GAUSS_BALANCE=0 turns it off.
BALANCE="${GAUSS_BALANCE:-1}"
LOCAL_CODER="${GAUSS_LOCAL_CODER:-$HOME/.local/bin/local-coder}"   # optional on-device model server
LOCAL_CODER_PORT="${LOCAL_CODER_PORT:-8089}"   # local-coder's server; Gauss's memory answer model (:3032, opt-in since GAU-184) is never shed
# macOS helpers that leak and that macOS relaunches on demand, holding no user data: balance
# restarts one once its footprint passes LEAK_MB. CursorUIViewService (the text-cursor helper) had
# grown to 3.7 GB before the 2026-10-22 01:00 kernel panic (GAU-183). Never apps or Claude sessions.
LEAKY_HELPERS="${GAUSS_LEAKY_HELPERS-CursorUIViewService}"
LEAK_MB="${GAUSS_LEAK_MB:-512}"   # it idles at 12-170 MB; reported leaks reach 3.7-4.9 GB
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
# The services' own logs. launchd keeps them open, so a rename would leave it writing to the moved file:
# copy to .1 and empty in place instead (a line written in between can be lost). backend.log had reached
# 12 MB in a month, never rotated, on a Mac held for disk (4 Nov 2026).
LOG_MAX_KB="${GAUSS_LOG_MAX_KB:-5120}"
ROTATED_LOGS="backend frontend fallback-backend fallback-frontend learning awake gates-runner deploy balance"
rotate_logs() {
  local n f
  for n in $ROTATED_LOGS; do
    f="$LOGS/$n.log"
    [ -f "$f" ] && [ $(( $(stat -f %z "$f" 2>/dev/null || echo 0) / 1024 )) -ge "$LOG_MAX_KB" ] || continue
    cp -p "$f" "$f.1" 2>/dev/null && : >"$f"
  done
  return 0
}
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
  batt=$(pmset -g batt 2>/dev/null || true); pct=$(grep -Eo -m1 '[0-9]+%' <<<"$batt" | tr -d % || true)
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
# Minutes since the Mac last woke (kern.waketime); a huge number when unknown. Peers can't have
# checked in while the Mac slept, so the watchdog gives them that long again before restarting.
awake_min() { local w; w=$(sysctl -n kern.waketime 2>/dev/null | sed -nE 's/^[{] sec = ([0-9]+),.*/\1/p'); [ -n "$w" ] || { echo 99999; return; }; echo $(( ($(date +%s) - w) / 60 )); }
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

# Plug in ahead (Josh 2026-11-03: "you don't need to be plugged in all the time - just warn so I can
# plug in ahead of time"). Measured from Argo's guard log that day: a gate drains ~20 %/h on battery
# (6.8 %/h idle) and takes 5-30 min, so about PLUG_GATE_PCT a gate. Work runs on battery down to
# WORK_BATTERY (Argo's batteryWorkPct, claude-heavy's HEAVY_BATTERY_MIN), then waits for the charger.
PLUG_GATE_PCT="${GAUSS_PLUG_GATE_PCT:-5}"
WORK_BATTERY="${GAUSS_WORK_BATTERY:-50}"
plug_ahead() { # plug_ahead <pct>: on battery with gate runs queued, say when to plug in
  local pct=$1 n need
  [ -d "$GATES_QUEUE" ] || return 0 # find on a missing folder fails, and pipefail would end the caller
  n=$(find "$GATES_QUEUE" -name '*.req' | wc -l | tr -d ' ') || return 0
  [ "${n:-0}" -gt 0 ] || return 0
  need=$(( n * PLUG_GATE_PCT ))
  if [ "$pct" -lt "$WORK_BATTERY" ]; then
    phone -key plug-ahead -every 1h "Gauss: plug in to keep merging" \
      "$n PR(s) wait to be tested and merged. Under ${WORK_BATTERY}% on battery they wait for the charger (${pct}% now)."
  elif [ $(( pct - need )) -lt "$WORK_BATTERY" ]; then
    phone -key plug-ahead -every 1h "Gauss: plug in soon" \
      "$n PR(s) queued need about ${need}% of battery; at ${pct}% the queue stops at ${WORK_BATTERY}%. Plug in within the hour to keep it moving."
  fi
}

battery_alerts() { # battery_alerts <pmset batt output> <pct>
  local batt=$1 pct=$2
  [ -n "$pct" ] || return 0
  [[ "$batt" == *"'AC Power'"* ]] || plug_ahead "$pct"
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
disk_short() { # disk_short <free GB> <swap MB>: too little room for swap to keep growing
  [ "${1:-999}" -lt "$DISK_ALERT_GB" ] || { [ "${1:-999}" -lt "$DISK_MIN_GB" ] && swap_high "${2:-0}"; }
}
disk_alerts() { # disk_alerts <free GB> <swap MB>
  disk_short "$1" "${2:-0}" || return 0
  if [ "${1:-999}" -lt "$DISK_ALERT_GB" ]; then
    phone -key disk-low -every 6h "Gauss: disk ${1} GB free" \
      "Swap needs room; below ${DISK_ALERT_GB} GB macOS may kill apps. Caches are cleared for you; delete old builds or downloads."
  else
    phone -key disk-low -every 6h "Gauss: disk ${1} GB free, swap $(gb "$2") GB" \
      "Swap is growing on a short disk, as before the 22 Oct crash. Close: $(memory_hint)."
  fi
  return 0
}
# Biggest process by footprint (top's MEM is phys_footprint, as Activity Monitor shows). RSS leaves
# out compressed pages, which held 7.5 GB on 2026-10-25, so it named the wrong process.
top_memory() {
  local pid mem name
  read -r pid mem < <(top -l 1 -o mem -n 1 -stats pid,mem 2>/dev/null | tail -1)
  name=$(ps -o comm= -p "${pid:-0}" 2>/dev/null); name=${name##*/}
  awk -v n="${name:-?}" -v m="${mem:-0}" 'BEGIN{v=m+0; u=substr(m,length(m)); if (u=="+"||u=="-") u=substr(m,length(m)-1,1)
    if (u=="G") v*=1024; else if (u=="K") v/=1024; else if (u=="B") v/=1048576; printf "%s %.1f GB", n, v/1024}'
}
# memory_hint: what Josh can close, biggest first, from mem-guard's newest sample (owners of 0.5 GB+
# that are his to close; never macOS, Gauss or the Claude app). Falls back to the biggest process.
memory_hint() {
  local hint=""
  if [ -r "$MEM_LOG" ] && [ -n "$(find "$MEM_LOG" -mmin -30 2>/dev/null)" ]; then
    hint=$(awk -F'\t' 'NR == 1 {for (i = 1; i <= NF; i++) col[$i] = i; next} {last = $0}
      END {
        split("browser cowork_vm claude_code whatsapp apps", k, " ")
        lab["browser"] = "browser tabs"; lab["cowork_vm"] = "Cowork"; lab["claude_code"] = "idle Claude sessions"
        lab["whatsapp"] = "WhatsApp"; lab["apps"] = "unused apps"
        n = split(last, v, "\t")
        for (i = 1; i <= 5; i++) if (col[k[i]] && v[col[k[i]]] + 0 >= 0.5) printf "%.1f\t%s %.1f GB\n", v[col[k[i]]], lab[k[i]], v[col[k[i]]]
      }' "$MEM_LOG" | sort -rn | head -3 | cut -f2 | paste -sd ',' - | sed 's/,/, /g')
  fi
  echo "${hint:-$(top_memory)}"
}
# phys_footprint in MB, as Activity Monitor shows it. RSS leaves out compressed pages, which is
# where a leaking helper's memory ends up (CursorUIViewService: RSS 4 MB vs footprint 12 MB idle).
footprint_mb() { # footprint_mb <pid>
  footprint -p "$1" 2>/dev/null | awk '$1 == "phys_footprint:" {v = $2; u = $3
    if (u == "GB") v *= 1024; else if (u == "KB") v /= 1024; else if (u == "B" || u == "bytes") v /= 1048576
    printf "%d", v; exit}'
}

mem_available() { # kern.memorystatus_level: % of memory available (100 when unreadable)
  local a; a=$(sysctl -n kern.memorystatus_level 2>/dev/null)
  case "$a" in ''|*[!0-9]*) echo 100 ;; *) echo "$a" ;; esac
}
swap_fast() { # swap_fast <swap MB>: swap grew SWAP_FAST_GB+ since a reading <= 150 s ago; records this one
  local now prev_t="" prev_s=""; now=$(date +%s)
  read -r prev_t prev_s 2>/dev/null <"$SWAP_LAST" || true
  mkdir -p "$(dirname "$SWAP_LAST")" 2>/dev/null; echo "$now $1" >"$SWAP_LAST" 2>/dev/null || true
  [ -n "$prev_t" ] && [ $((now - prev_t)) -le 150 ] && [ $(($1 - ${prev_s:-0})) -ge $((SWAP_FAST_GB * 1024)) ]
}

# Fleet memory watch (GAU-240): the hub classifies each mesh device's memory from what its Argo
# reports and keeps the result in fleet-memory.json beside the device store (backend/mesh/store.ts).
# This reads that file each minute, no API session and no tokens, and texts when ANOTHER device is at
# risk or critical: once per device per 2 h. This Mac has its own memory alerts below. A state older
# than the file's staleAfterMs says nothing about now and is ignored.
FLEET_MEMORY="${GAUSS_FLEET_MEMORY:-}" # default: beside the live backend's MESH_STORE_PATH
fleet_memory_watch() {
  local f=$FLEET_MEMORY store me name state why
  if [ -z "$f" ]; then
    store=$(plutil -extract EnvironmentVariables.MESH_STORE_PATH raw -o - "$AGENTS/uk.lightbound.gauss-backend.plist" 2>/dev/null) || return 0
    [ -n "$store" ] || return 0
    f="$(dirname "$store")/fleet-memory.json"
  fi
  [ -f "$f" ] || return 0
  me=$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)
  while IFS=$'\t' read -r name state why; do
    [ -n "$name" ] && [ "$name" != "$me" ] || continue
    # Same 2 h window as the text (alert_event's stamp): one event and one text per device, not one a minute.
    [ -n "$(find "$WATCH_DIR/alerts/mesh-mem-$name" -mmin -120 2>/dev/null)" ] && continue
    event fleet-memory "$name" "memory $state: $why" device="$name" state="$state"
    if [ "$state" = critical ]; then
      phone -key "mesh-mem-$name" -every 2h "Gauss: $name is out of memory" \
        "$name reports: $why. It may freeze or stop programs. Close apps or sessions on it now."
    else
      phone -key "mesh-mem-$name" -every 2h "Gauss: $name is short of memory" \
        "$name reports: $why. It is not recovering by itself yet. Close unused apps or sessions on it when you can."
    fi
  done < <(python3 -Ic '
import datetime, json, re, sys
try:
    d = json.load(open(sys.argv[1]))
    stale = float(d.get("staleAfterMs", 900000)) / 1000
    now = datetime.datetime.now(datetime.timezone.utc)
    for e in d.get("devices", []):
        name, state, at = e.get("name"), e.get("state"), e.get("reportedAt")
        if state not in ("risk", "critical") or not isinstance(name, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", name) or not isinstance(at, str):
            continue
        age = (now - datetime.datetime.fromisoformat(at.replace("Z", "+00:00"))).total_seconds()
        if not -120 <= age <= stale:
            continue
        why = "; ".join(w for w in e.get("why", []) if isinstance(w, str) and re.fullmatch(r"[A-Za-z0-9 ()/,.:+-]{1,80}", w))[:200]
        print("%s\t%s\t%s" % (name, state, why or "memory " + state))
except Exception:
    pass
' "$f" 2>/dev/null || true)
  return 0
}

memory_alerts() { # memory_alerts <pressure level> <swap used MB>
  local level=$1 swap=$2 avail; avail=$(mem_available)
  if [ "$level" -ge "$MEM_ALERT_LEVEL" ] || [ "$avail" -lt "$AVAIL_MIN" ]; then
    phone -key memory-low -every 30m "Gauss: memory $([ "$level" -ge "$MEM_ALERT_LEVEL" ] && echo "pressure $(pressure_name "$level")" || echo "almost out (${avail}% left)")" \
      "Background work may be killed. Biggest: $(top_memory). Close: $(memory_hint)."
  fi
  if swap_fast "$swap"; then
    phone -key swap-fast -every 30m "Gauss: swap growing fast" \
      "Swap jumped ${SWAP_FAST_GB}+ GB in a minute or two (now $(gb "$swap") GB): something is running away. Biggest: $(top_memory). Quit it if you can."
  fi
  # Swap stays until the work holding it ends, so this won't clear by itself; every 3 h, not hourly.
  if swap_high "$swap"; then
    phone -key swap-high -every 3h "Gauss: swap $(gb "$swap") GB" \
      "The Mac is short of memory and won't recover by itself. Close: $(memory_hint)."
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
  local age awake; awake=$(awake_min)
  # Argo only rewrites state.json on a full probe (~5 min), so allow 15. A stale file right after
  # the Mac wakes is sleep, not a stall (5 Nov 2026: 4 needless restarts after a 3 h lid-closed sleep).
  if loaded uk.lightbound.argo && [ ! -e "$HOME/.local/state/argo/disabled" ]; then
    age=$(mtime_age_min "$HOME/.local/state/argo/state.json")
    if [ "$age" -gt 15 ]; then
      if [ "$awake" -gt 15 ]; then kick uk.lightbound.argo "no Argo check for ${age} min"
      else echo "$(date '+%F %T') watchdog: Argo stale ${age} min but the Mac woke ${awake} min ago; waiting"; fi
    fi
  fi
  if loaded uk.lightbound.mesh-heal; then
    age=$(mtime_age_min "$HOME/.local/share/mesh-heal/state")
    if [ "$age" -gt 10 ]; then
      if [ "$awake" -gt 10 ]; then kick uk.lightbound.mesh-heal "no mesh-heal check for ${age} min"
      else echo "$(date '+%F %T') watchdog: mesh-heal stale ${age} min but the Mac woke ${awake} min ago; waiting"; fi
    fi
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
# FM-21: a standby that was prepared but can no longer serve, in words; nothing when it is fine
# or was never prepared ("none prepared" is a status warning, and deploy refuses it: FM-24).
fallback_problem() {
  [ -e "$FALLBACK_STATE/ready" ] || return 0
  if ! ready_record; then echo "its ready record is corrupt or cut short"; return 0; fi
  if ! fallback_ready; then echo "its checkout, build or agents are gone (${READY_DIR})"; return 0; fi
  local head; head=$(git -C "$READY_DIR" rev-parse -q --verify HEAD 2>/dev/null) || return 0 # not a git checkout: nothing to compare
  [[ "$head" == "$READY_SHA"* ]] || echo "its checkout moved to ${head:0:7} after it was prepared at ${READY_SHA:0:7}"
}
fallback_watch() { # awake guard: text when the standby goes bad, not only once a failover needs it
  fallback_active && return 0
  local why; why=$(fallback_problem)
  [ -n "$why" ] || return 0
  phone -key fallback-bad -every 6h "Gauss: no usable standby" \
    "The fallback can't take over: $why. Live still runs; if it fails there is nothing to switch to. Fix: gauss-services.sh fallback prepare <dir>"
}

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
    # The checkout changes under the old record from here: drop it, so a failed install or
    # build leaves "none prepared", never a ready record describing a different checkout.
    rm -f "$FALLBACK_STATE/ready"
    git -C "$dir" checkout -q --detach "$sha" || return 1
  else
    git -C "$live" worktree add -q --detach "$dir" "$sha" || return 1; dir=$(cd "$dir" && pwd)
  fi
  # Explicit returns throughout: deploy calls this in a condition, where set -e is off.
  [ "$dir" != "$live" ] || { echo "The fallback must not be the live checkout." >&2; return 1; }
  local lock; lock=$(install_key "$dir") || return 1
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
  prebuild_backend "$dir"
  PLIST_DATA="$live/data" plist "${FALLBACK_LABELS[0]}" "$dir" "$LOGS/fallback-backend.log" keepalive \
    "$NODE" --env-file-if-exists="$live/.env" "${BACKEND_ARGS[@]}" >"$FALLBACK_STATE/${FALLBACK_LABELS[0]}.plist"
  PLIST_DATA="$live/data" plist "${FALLBACK_LABELS[1]}" "$dir" "$LOGS/fallback-frontend.log" keepalive \
    "$NODE" node_modules/vite/bin/vite.js preview --config frontend/vite.config.ts --host 127.0.0.1 --port 8080 --strictPort \
    >"$FALLBACK_STATE/${FALLBACK_LABELS[1]}.plist"
  plutil -lint -s "$FALLBACK_STATE/${FALLBACK_LABELS[0]}.plist" "$FALLBACK_STATE/${FALLBACK_LABELS[1]}.plist" || return 1
  echo "$sha $dir $(date +%s)" >"$FALLBACK_STATE/ready"
  event fallback_prepared "${sha:0:7}" "fallback prepared at $dir"
  echo "Fallback ready: ${sha:0:7} at $dir (cold: not running, no memory used)."
}

# Prebuilt backend (2 Nov): running TypeScript through tsx at runtime kept the loader, source maps and
# an esbuild helper resident: 207 MB RSS + 16 MB helper vs 91 MB prebuilt (same code, empty data,
# 90 s). Compile backend/ and shared/ to .js beside the .ts, so every relative path (../../build,
# ../../shared/proto, *.json) resolves as before. Only the live and fallback checkouts do this; dev
# keeps tsx. BACKEND_ARGS is what the backend agent runs; tsx if prebuilding is not possible.
prebuild_backend() { # prebuild_backend <checkout-dir>: sets BACKEND_ARGS
  local dir=$1 esb="$1/node_modules/esbuild/bin/esbuild"
  BACKEND_ARGS=(--import tsx backend/server.ts)
  [ -f "$esb" ] && [ -n "$NODE" ] || return 0
  # esbuild's install usually swaps its JS launcher for the native binary: run that directly.
  local run=("$NODE" "$esb"); [ "$(head -c 2 "$esb")" != "#!" ] && [ -x "$esb" ] && run=("$esb")
  # Drop .js left by an earlier build (only git-ignored ones, never node_modules), so a removed module can't linger.
  (cd "$dir" && find backend shared -name '*.js' ! -path '*/node_modules/*' -print0 | git check-ignore -z --stdin 2>/dev/null | xargs -0 rm -f) || true
  if (cd "$dir" && find backend shared -name '*.ts' ! -name '*.test.ts' ! -name '*.d.ts' ! -path '*/node_modules/*' -print0 \
      | xargs -0 "${run[@]}" --outdir=. --outbase=. --format=esm --platform=node --target=node26 --log-level=error) \
    && (cd "$dir" && "$NODE" --check backend/server.js); then
    BACKEND_ARGS=(backend/server.js)
  else
    echo "Prebuilding the backend failed in $dir; it keeps running through tsx." >&2
  fi
}

install_agents() { # install_agents <checkout-dir>: build the site, write and (re)load the agents
  local dir=$1 l
  [ -f "$dir/backend/server.ts" ] || { echo "$dir is not a Gauss checkout" >&2; return 1; }
  mkdir -p "$LOGS" "$dir/data/mesh" "$dir/data/commerce"
  echo "Building the frontend in $dir (same-origin API) ..."
  (cd "$dir" && VITE_HELIO_PROXY_URL=same-origin "$NODE" node_modules/vite/bin/vite.js build --config frontend/vite.config.ts >/dev/null) || return 1
  prebuild_backend "$dir"
  plist uk.lightbound.gauss-backend "$dir" "$LOGS/backend.log" keepalive \
    "$NODE" --env-file-if-exists=.env "${BACKEND_ARGS[@]}" >"$AGENTS/uk.lightbound.gauss-backend.plist"
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

# Who ran it: GAUSS_BY if set, else the user, marked when it ran inside a Claude Code session.
deployer() { if [ -n "${GAUSS_BY:-}" ]; then echo "$GAUSS_BY"; elif [ -n "${CLAUDECODE:-}" ]; then echo "claude-code ($(id -un))"; else id -un; fi; }

# The gates are heavy for an 8 GB Mac (a hard reset on 2026-10-21 under memory pressure), so
# each waits for normal pressure and takes the lock other agents use for the same gates.
# GATES_HOLD=1 when this run took the lock (and so must free it).
gate_lock() {
  local level _; mkdir -p "$(dirname "$GATE_LOCK")"; GATES_HOLD=0
  until read -r level _ < <(memory_stats) && [ "$level" = 1 ] \
    && { gate_lock_ours || { mkdir "$GATE_LOCK" 2>/dev/null && GATES_HOLD=1; }; }; do sleep 20; done
}
# claude-heavy takes the same lock before it runs its command, so `claude-heavy -- gates record`
# (and the queue) would wait for itself forever: a lock owned by one of our callers is ours.
gate_lock_ours() {
  local owner p; owner=$(awk '{print $1}' "$GATE_LOCK/owner" 2>/dev/null) && [ -n "$owner" ] || return 1
  p=$$
  while [ -n "$p" ] && [ "$p" -gt 1 ]; do
    [ "$p" = "$owner" ] && return 0
    p=$(/bin/ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
  return 1
}

# The detached runner is started by the awake LaunchAgent, so it inherits the services' environment:
# live data paths (a test must never write live mesh/commerce data), the live ALLOWED_ORIGINS
# (server.access.test.ts expects the defaults) and launchd's PATH, whose /usr/bin/python3 has no
# numpy (5 ml tests). 2026-11-11: gates 8aa759a and 5294132 failed on exactly that, not on code.
GATES_SCRUB_ENV=(ALLOWED_ORIGINS GAUSS_PUBLIC_URL BETTER_AUTH_URL MESH_STORE_PATH COMMERCE_DB_PATH GAUSS_BEDROCK_DIR NODE_ENV)
gates_python_dir() { # the directory of the first python3 that can import numpy (GATES_PYTHON first), or nothing
  local p
  for p in "${GATES_PYTHON:-}" /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
    /opt/homebrew/bin/python3 /usr/local/bin/python3 "$(command -v python3 2>/dev/null)"; do
    [ -n "$p" ] && [ -x "$p" ] && "$p" -Ic 'import numpy' >/dev/null 2>&1 && { dirname "$p"; return 0; }
  done
  return 1
}

gates_record() { # gates_record <checkout-dir>: run the gates on a clean checkout and record the result by tree
  local dir sha tree g rc
  dir=$(cd "${1:?usage: $0 gates record <checkout-dir>}" && pwd) || return 1
  [ -f "$dir/backend/server.ts" ] && [ -d "$dir/node_modules" ] || { echo "$dir is not a Gauss checkout with node_modules" >&2; return 1; }
  # A record vouches for a tree, so nothing uncommitted may be in it.
  [ -z "$(git -C "$dir" status --porcelain)" ] || { echo "$dir has uncommitted or untracked files: commit or stash them first." >&2; return 1; }
  sha=$(git -C "$dir" rev-parse HEAD) && tree=$(git -C "$dir" rev-parse 'HEAD^{tree}') || return 1
  GATES_TMP=$(mktemp -d); local tmp=$GATES_TMP # global: the EXIT trap runs after this function's locals are gone
  # Release the lock on exit only while holding it: an interrupted wait must not free another agent's lock.
  trap '[ "${GATES_HOLD:-0}" = 1 ] && rmdir "$GATE_LOCK" 2>/dev/null; rm -rf "$GATES_TMP"' EXIT
  local pydir scrub=() v
  pydir=$(gates_python_dir) || { pydir=""; echo "warning: no python3 with numpy found; the ml tests will fail" >&2; }
  for v in "${GATES_SCRUB_ENV[@]}"; do scrub+=(-u "$v"); done
  for g in "${GATES[@]}"; do
    gate_lock
    echo "gate $g ..."
    rc=0; (cd "$dir" && env "${scrub[@]}" PATH="$(dirname "$NODE")${pydir:+:$pydir}:$PATH" npm run "$g" >"$tmp/$g.log" 2>&1) || rc=$?
    if [ "$GATES_HOLD" = 1 ]; then rmdir "$GATE_LOCK" 2>/dev/null || true; fi; GATES_HOLD=0
    echo "$rc" >"$tmp/$g.rc"
  done
  [ "$(git -C "$dir" rev-parse HEAD)" = "$sha" ] && [ -z "$(git -C "$dir" status --porcelain)" ] \
    || { echo "$dir changed while the gates ran; not recording." >&2; return 1; }
  local json; json=$(python3 -Ic '
import json, os, re, sys
d, sha, tree, by, at = sys.argv[1:6]
log = lambda g: open(os.path.join(d, g + ".log"), encoding="utf-8", errors="replace").read()
rc = lambda g: int(open(os.path.join(d, g + ".rc")).read())
def last(pat, text, conv=int):
    m = re.findall(pat, text, re.M)
    return conv(m[-1]) if m else None
ops, v = log("test:ops"), log("verify")
def step(name): # verify prints "✔ <step>" or "✖ <step> (exit N)"; no line: verify died first
    if re.search(r"^✔ " + name + r"$", v, re.M): return 0
    m = re.search(r"^✖ " + name + r" \(exit (-?\d+|null)\)", v, re.M)
    return (int(m.group(1)) if m and m.group(1) != "null" else 1) if m else max(rc("verify"), 1)
r = {"sha": sha, "tree": tree, "by": by, "at": at,
     "test_ops": {"exit": rc("test:ops"), "pass": last(r"gauss-services: (\d+) passed", ops), "fail": last(r"gauss-services: \d+ passed, (\d+) failed", ops), "go_ok": len(re.findall(r"^ok\s", ops, re.M))},
     "test": {"exit": step("Test suite"), "tests": last(r"^\S* ?tests (\d+)$", v), "pass": last(r"^\S* ?pass (\d+)$", v), "fail": last(r"^\S* ?fail (\d+)$", v), "via": "verify"},
     "build": {"exit": step("Production build"), "via": "verify"},
     "quality": {"exit": rc("quality:full")},
     "verify": {"exit": rc("verify"), "vcrm": last(r"VCRM: (\d+/\d+)", v, str), "fmea": last(r"FMEA: (\d+/\d+)", v, str), "passed_at": last(r"VERIFY PASSED at (\w+)", v, str)}}
r["passed"] = all(r[k]["exit"] == 0 for k in ("test_ops", "test", "build", "quality", "verify")) \
    and r["test"]["fail"] == 0 and r["test_ops"]["fail"] == 0 and sha.startswith(r["verify"]["passed_at"] or "-")
print(json.dumps(r, ensure_ascii=False))
' "$tmp" "$sha" "$tree" "$(deployer)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)") || return 1
  mkdir -p "$GATES_DIR"; printf '%s\n' "$json" >"$GATES_DIR/$tree.json"
  # Keep the end of each failed gate's output (2026-10-31: "npm test 486/487" with nothing to read).
  local g kept="$GATES_DIR/logs/$tree"
  rm -rf "$kept"
  for g in "${GATES[@]}"; do
    [ "$(cat "$tmp/$g.rc" 2>/dev/null)" = 0 ] && continue
    mkdir -p "$kept" && tail -400 "$tmp/$g.log" >"$kept/$g.log" 2>/dev/null
  done
  [ -d "$kept" ] && echo "Failed gate output: $kept"
  if [ -d "$GATES_DIR/logs" ]; then # keep the last 20 (ls fails on an empty dir: pipefail + set -e)
    ls -dt "$GATES_DIR"/logs/*/ 2>/dev/null | tail -n +21 | while IFS= read -r old; do rm -rf "$old"; done || true
  fi
  gates_summary "$GATES_DIR/$tree.json"
  gate_record "$tree" >/dev/null
}

gates_summary() { # gates_summary <record file>: one line
  python3 -Ic '
import json, sys
r = json.load(open(sys.argv[1]))
t, o, v = r.get("test") or {}, r.get("test_ops") or {}, r.get("verify") or {}
fails = [k for k in ("test_ops", "test", "build", "quality", "verify") if (r.get(k) or {}).get("exit") not in (0, None)]
print("%s %s (tree %s) by %s at %s: npm test %s/%s, test:ops %s passed, build %s, quality %s, VCRM %s, FMEA %s" % (
    "PASSED" if r.get("passed") else "FAILED (" + ", ".join(fails or ["counts"]) + ")", r["sha"][:7], r["tree"][:7], r.get("by"), r.get("at"),
    t.get("pass"), t.get("tests"), o.get("pass"), "ok" if (r.get("build") or {}).get("exit") == 0 else "failed",
    "ok" if (r.get("quality") or {}).get("exit") == 0 else "failed", v.get("vcrm"), v.get("fmea")))
' "$1"
}

gate_record() { # gate_record <tree>: print the passing record for this exact tree as one JSON line, or fail
  [ -f "$GATES_DIR/$1.json" ] || return 1
  python3 -Ic '
import json, sys
r = json.load(open(sys.argv[1]))
if r.get("passed") is not True or r.get("tree") != sys.argv[2]:
    sys.exit(1)
print(json.dumps(r, ensure_ascii=False))
' "$GATES_DIR/$1.json" "$1"
}

req_get() { sed -n "/^$2=/{s///p;q;}" "$1"; } # req_get <request file> <key>: the first value (sed quits itself, no SIGPIPE)

gates_result() { # gates_result <sha> <tree> <STATUS> <detail>: the one line a session or the ledger reads later
  mkdir -p "$GATES_DIR"
  printf '%s %s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4" >>"$GATES_RESULTS"
  event gates_result "${1:0:7}" "$3 ${1:0:7}: $4" sha="$1" tree="$2" status="$3"
}

gates_queued() { # gates_queued <tree>: the queued request for that tree, by its tree= line: train_sync moves a request
  # to the merged head in place, so the file name keeps the tree it was queued with (2026-11-03: "gates result 0db616f"
  # said no request while #212's moved request was running it, and a re-enqueue would have queued it twice).
  local f; for f in "$GATES_QUEUE"/*.req; do [ -f "$f" ] && [ "$(req_get "$f" tree)" = "$1" ] && { echo "$f"; return 0; }; done; return 1
}

gates_resolve() { # gates_resolve <checkout-dir>|<commit>: sets G_SRC G_SHA G_TREE G_REPO
  if [ -d "$1" ]; then
    G_SRC=$(cd "$1" && pwd) || return 1
    [ -z "$(git -C "$G_SRC" status --porcelain)" ] \
      || { echo "$G_SRC has uncommitted or untracked files: commit them first (the queue gates commits)." >&2; return 1; }
    G_SHA=$(git -C "$G_SRC" rev-parse --verify HEAD) || return 1
  else
    G_SRC=$PWD
    G_SHA=$(git -C "$G_SRC" rev-parse -q --verify "$1^{commit}" 2>/dev/null) || { echo "Unknown commit '$1' in $G_SRC." >&2; return 1; }
  fi
  G_TREE=$(git -C "$G_SRC" rev-parse "$G_SHA^{tree}") && G_REPO=$(git -C "$G_SRC" rev-parse --path-format=absolute --git-common-dir)
}

# A new head replaces the older heads of its branch still waiting (2026-10-31: three hand prunes of
# stale requests in one day, each costing a full gate slot). Never a commit already on origin/main:
# a queued main (for a deploy) is an ancestor of every branch that merged it. Never a commit that is
# still a branch's head (2026-11-02: queuing #210's head dropped the head of #158 under it, which has
# to pass on its own before #158 merges): only a branch whose head moved on supersedes.
gates_supersede() { # gates_supersede <new-sha> <new-request>
  local new=$1 keep=$2 r old tips fetched=
  for r in "$GATES_QUEUE"/*.req; do
    [ -f "$r" ] && [ "$r" != "$keep" ] || continue
    old=$(req_get "$r" sha)
    [ -n "$old" ] && [ "$old" != "$new" ] || continue
    git --git-dir="$G_REPO" merge-base --is-ancestor "$old" "$new" 2>/dev/null || continue
    if [ -z "$fetched" ]; then # once, and only with a candidate: origin's heads as they are now (30 s cap: hotspot)
      fetched=1
      GIT_TERMINAL_PROMPT=0 perl -e 'alarm shift; exec @ARGV' 30 git --git-dir="$G_REPO" fetch -q origin 2>/dev/null \
        || echo "(git fetch failed; judging branch heads by the refs already here)"
    fi
    git --git-dir="$G_REPO" merge-base --is-ancestor "$old" refs/remotes/origin/main 2>/dev/null && continue
    tips=$(gates_branch_tips "$old")
    [ -z "$tips" ] || { echo "Kept ${old:0:7}: still the head of $tips."; continue; }
    rm -f "$r" && echo "Superseded ${old:0:7}: ${new:0:7} contains it."
  done
}

gates_branch_tips() { # gates_branch_tips <sha>: the branches, here or on origin, whose head is <sha> (comma-separated)
  local ref h
  git --git-dir="$G_REPO" for-each-ref --points-at "$1" --format='%(refname)' refs/heads refs/remotes/origin \
    | while IFS= read -r ref; do
      case $ref in # not origin's copy of a branch that has moved on here: that newer head just isn't pushed yet
        refs/remotes/origin/*) h=$(git --git-dir="$G_REPO" rev-parse -q --verify "refs/heads/${ref#refs/remotes/origin/}") \
          && [ "$h" != "$1" ] && git --git-dir="$G_REPO" merge-base --is-ancestor "$1" "$h" && continue ;;
      esac
      echo "${ref#refs/}"
    done | paste -sd, -
}

gates_enqueue() { # gates_enqueue <checkout-dir>|<commit> [--pr N]: queue a gate run for that commit's tree, start the runner
  # --pr N puts it on the merge train (train_sync, train_merge): main is merged in before the run
  # and the PR is merged after a pass, when the standing approval's conditions hold.
  gates_resolve "${1:?usage: $0 gates enqueue <checkout-dir>|<commit> [--pr N]}" || return 1
  local sha=$G_SHA tree=$G_TREE f pr=""
  case "${2:-}" in
    --pr) pr=${3:-}; [[ "$pr" =~ ^[0-9]+$ ]] || { echo "usage: $0 gates enqueue <checkout-dir>|<commit> --pr <number>" >&2; return 2; } ;;
    "") ;;
    *) echo "unknown option ${2} (expected --pr N)" >&2; return 2 ;;
  esac
  if gate_record "$tree" >/dev/null; then
    if [ -z "$pr" ]; then
      gates_result "$sha" "$tree" SKIPPED "already passed: $(gates_summary "$GATES_DIR/$tree.json")"
      echo "Already passed: ${sha:0:7} (tree ${tree:0:7}) has a passing gate record; nothing queued."; return 0
    fi
    # On the train a pass is not the end (4 Nov: #209 passed as a draft and was HELD; marked ready and
    # re-queued, it got "already passed" and nothing merged it, while main moved on). A head that still
    # contains main goes straight to train_merge; one main has moved past is queued, so train_sync merges
    # main in and the merged tree is gated.
    git --git-dir="$G_REPO" fetch -q origin 2>/dev/null || true
    if git --git-dir="$G_REPO" merge-base --is-ancestor refs/remotes/origin/main "$sha" 2>/dev/null; then
      echo "Already passed: ${sha:0:7} (tree ${tree:0:7}); merging PR #$pr if the train's rules hold."
      if train_merge "$pr" "$sha" "$tree" "$G_REPO"; then echo "Merged PR #$pr."
      else echo "Not merged: $(tail -1 "$GATES_RESULTS" | cut -d' ' -f4-)"; fi
      return 0
    fi
    echo "Already passed: ${sha:0:7}, but main has moved past it: queueing it so the train merges main in and gates that."
  fi
  mkdir -p "$GATES_QUEUE"
  if f=$(gates_queued "$tree"); then
    echo "Already queued: tree ${tree:0:7} ($(req_get "$f" sha | cut -c1-7), by $(req_get "$f" by))."
  else
    f="$GATES_QUEUE/$(python3 -Ic 'import time; print("%.6f" % time.time())')-$tree.req"
    printf 'sha=%s\ntree=%s\nrepo=%s\nnode=%s\nby=%s\nqueued=%s\npr=%s\n' "$sha" "$tree" "$G_REPO" "$NODE" "$(deployer)" "$(date +%s)" "$pr" >"$f.tmp"
    mv "$f.tmp" "$f"
    event gates_queued "${sha:0:7}" "gate run queued for ${sha:0:7}" sha="$sha" tree="$tree" by="$(deployer)"
    gates_supersede "$sha" "$f"
    echo "Queued ${sha:0:7} (tree ${tree:0:7}); $(ls "$GATES_QUEUE" | grep -c '\.req$') in the queue."
  fi
  echo "Result later (any session, or the ledger): $0 gates result ${sha:0:7}   (or: tail -1 \"$GATES_RESULTS\")"
  gates_start
}

gates_runner_pid() { local p; p=$(cat "$GATES_RUNNER/pid" 2>/dev/null) && [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"; }

gates_runner_src() { # the commit the runner's copy came from, while runner.src still describes that copy
  local blob
  [ -f "$GATES_SRC" ] && blob=$(git hash-object --no-filters "$GATES_DIR/runner.sh" 2>/dev/null) \
    && [ "$(req_get "$GATES_SRC" blob)" = "$blob" ] && req_get "$GATES_SRC" sha
}

# The runner outlives the checkout that queued it (sessions' worktrees get removed): it runs a copy,
# renamed into place so a runner still reading the old copy keeps it. Refreshed on enqueue, even with
# a runner alive (2026-10-31: a runner that never idles kept running old queue code for days); the
# runner re-runs itself when it sees the new copy. Only forward (2026-11-03: an enqueue from an older
# branch replaced the merge-train runner of PR #218 with its own script): runner.src names the commit
# the copy came from, and only a checkout whose HEAD contains it, or origin/main's script, replaces it.
gates_refresh_runner() {
  local run="$GATES_DIR/runner.sh" dir pre blob head="" main="" was why
  blob=$(git hash-object --no-filters "$0") && dir=$(cd "$(dirname "$0")" && pwd) || return 1
  if pre=$(git -C "$dir" rev-parse --show-prefix 2>/dev/null); then
    # The commit only vouches for this script if it is committed as is (no edits since).
    [ "$(git -C "$dir" rev-parse -q --verify "HEAD:$pre${0##*/}" || true)" = "$blob" ] && head=$(git -C "$dir" rev-parse HEAD)
    main=$(git -C "$dir" rev-parse -q --verify "refs/remotes/origin/main:$pre${0##*/}") || main=""
  fi
  was=$(gates_runner_src) || was="" # none or stale (runner.sh changed without it): refresh as before
  if cmp -s "$0" "$run"; then
    [ -n "$was" ] && return 0 # same code, already recorded
  elif [ -n "$was" ] && [ "$blob" != "$main" ] \
    && ! { [ -n "$head" ] && git -C "$dir" merge-base --is-ancestor "$was" "$head" 2>/dev/null; }; then
    if [ -n "$head" ]; then why="this checkout (${head:0:7}) doesn't contain it"; else why="this script isn't committed as is"; fi
    echo "Runner kept: it runs ${was:0:7} and $why. A checkout that contains ${was:0:7}, or origin/main's script, updates it."
    return 0
  else
    cp "$0" "$run.$$" && mv -f "$run.$$" "$run" || return 1
  fi
  if [ -n "$head" ]; then
    printf 'sha=%s\nblob=%s\nfrom=%s\nat=%s\n' "$head" "$blob" "$dir" "$(date +%s)" >"$GATES_SRC.$$" && mv -f "$GATES_SRC.$$" "$GATES_SRC"
  else
    rm -f "$GATES_SRC" # unknown origin: the next checkout refreshes it as before
  fi
}

gates_start() { # start the one runner, detached from this session (own session id, no terminal), if none runs
  local p
  mkdir -p "$GATES_DIR" "$LOGS"
  gates_refresh_runner || return 1
  if p=$(gates_runner_pid); then echo "The gate runner is working (pid $p)."; return 0; fi
  [ "${GAUSS_GATES_START:-1}" = 1 ] || return 0 # tests
  (cd "$GATES_DIR" && nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' /bin/bash "$GATES_DIR/runner.sh" gates run \
    </dev/null >>"$LOGS/gates-runner.log" 2>&1 &)
  echo "Gate runner started (log: $LOGS/gates-runner.log)."
}

gates_prescreen() { # gates_prescreen <sha> <tree>: 0 when the gatebox failed the commit (result written); else 1: gate it here
  local sha=$1 tree=$2 log rc=0 last
  [ -n "$GATEBOX" ] || return 1
  [[ "$GATEBOX" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo "gatebox: not a host name: $GATEBOX; gating here"; return 1; }
  [ -r "$GATEBOX_KEY" ] || { echo "gatebox: no key at $GATEBOX_KEY; gating here"; return 1; }
  mkdir -p "$GATES_DIR/logs"; log="$GATES_DIR/logs/gatebox-${sha:0:12}.log"
  echo "$(date '+%F %T') gatebox $GATEBOX: screening ${sha:0:7} ..."
  # BatchMode: never a prompt. The host key is pinned in its own file on first contact (the tailnet has
  # already authenticated the machine); a changed key is refused, and the run falls back to this Mac.
  ssh -i "$GATEBOX_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=4 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$GATEBOX_HOSTS" \
    "gate@$GATEBOX" "$GATEBOX_REPO $sha" >"$log" 2>&1 </dev/null || rc=$?
  last=$(grep -E '^gates rc=' "$log" | tail -1)
  # gauss-gate-run prints "gates rc=N in S s on <sha>" after the gates; without that line (ssh 255, busy 75,
  # sha not on GitHub 65, fetch 69, a killed run) the gatebox said nothing about the commit.
  if [ "$rc" = 0 ] && [[ "$last" == "gates rc=0 "* ]]; then
    echo "$(date '+%F %T') gatebox passed ${sha:0:7} ($last); full gates here next"; return 1
  fi
  if [ "$rc" -ge 1 ] && [ "$rc" -le 63 ] && [[ "$last" == "gates rc=$rc "* ]]; then
    event gates-gatebox gates "failed on the gatebox" sha="$sha" rc:="$rc" host="$GATEBOX"
    gates_result "$sha" "$tree" FAILED "on gatebox $GATEBOX (npm ci, test, quality:full, build): $last; log $log"
    return 0
  fi
  echo "$(date '+%F %T') gatebox could not screen ${sha:0:7} (exit $rc: $(tail -1 "$log" 2>/dev/null)); gating here"
  return 1
}

gates_run() { # gates_run [--once]: work through the queue, oldest first, then exit; --once: stop after one wait that gave up
  local once=${1:-} self req sha tree queued rc pid me pr repo
  self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  # Never the folder it was started from: that is a session's checkout, often a temporary worktree removed
  # while the runner lives on (4 Nov: every git call then failed with getcwd errors).
  cd "$GATES_DIR" 2>/dev/null || cd /
  me=$(shasum "$self" | cut -d' ' -f1)
  mkdir -p "$GATES_QUEUE"
  until mkdir "$GATES_RUNNER" 2>/dev/null; do
    pid=$(cat "$GATES_RUNNER/pid" 2>/dev/null || true)
    [ "$pid" = "$$" ] && break # this runner, re-run on a newer copy of itself: the lock is still ours
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "The gate runner is already working (pid $pid)."; return 0; fi
    # No pid yet: another runner is starting, unless that was long ago.
    [ -z "$pid" ] && [ "$(mtime_age_min "$GATES_RUNNER")" -lt 1 ] && { echo "Another gate runner is starting."; return 0; }
    rm -rf "$GATES_RUNNER"
  done
  echo $$ >"$GATES_RUNNER/pid"
  trap 'rm -rf "$GATES_RUNNER"' EXIT
  while req=$(ls "$GATES_QUEUE"/*.req 2>/dev/null | sort | awk 'NR==1') && [ -n "$req" ]; do
    if [ "$(shasum "$self" | cut -d' ' -f1)" != "$me" ]; then
      echo "$(date '+%F %T') runner code changed: re-running the new copy"
      exec /bin/bash "$self" gates run $once
    fi
    sha=$(req_get "$req" sha); tree=$(req_get "$req" tree); queued=$(req_get "$req" queued)
    if [ $(( $(date +%s) - ${queued:-0} )) -ge $(( GATES_EXPIRE_H * 3600 )) ]; then
      gates_result "$sha" "$tree" EXPIRED "waited over ${GATES_EXPIRE_H} h for memory or power; enqueue it again"
      rm -f "$req"; continue
    fi
    if gate_record "$tree" >/dev/null; then # passed meanwhile (another request, or by hand)
      pr=$(req_get "$req" pr)
      if [ -z "$pr" ]; then
        gates_result "$sha" "$tree" SKIPPED "already passed: $(gates_summary "$GATES_DIR/$tree.json")"
        rm -f "$req"; continue
      fi
      # A train request whose head already passed still has to land (12 Nov: #265 passed, main moved,
      # the re-queue was dropped here as SKIPPED and never merged). Merge main in first; if that left
      # the tree unchanged, merge without a second run, else gate the new head as usual below.
      train_sync "$req" || { tail -1 "$GATES_RESULTS"; continue; }
      sha=$(req_get "$req" sha); tree=$(req_get "$req" tree)
      if gate_record "$tree" >/dev/null; then
        repo=$(req_get "$req" repo)
        gates_result "$sha" "$tree" SKIPPED "already passed: going straight to the merge"
        rm -f "$req"
        train_merge "$pr" "$sha" "$tree" "$repo" || true
        tail -1 "$GATES_RESULTS"; continue
      fi
    fi
    if gates_prescreen "$sha" "$tree"; then rm -f "$req"; tail -1 "$GATES_RESULTS"; continue; fi
    echo "$(date '+%F %T') gates ${sha:0:7} ..."
    rc=0
    if [ -x "$HEAVY" ]; then
      "$HEAVY" --wait "$GATES_WAIT_MIN" --name gates --label "gate queue ${sha:0:7}" -- /bin/bash "$self" gates run-one "$req" || rc=$?
    else
      /bin/bash "$self" gates run-one "$req" || rc=$?
    fi
    if [ "$rc" = 75 ] && [ -f "$req" ]; then # claude-heavy gave up waiting; the request stays first in line
      echo "$(date '+%F %T') ${sha:0:7} still waiting for memory or power; asking again."
      [ "$once" = --once ] && return 0
      sleep "${GAUSS_GATES_RETRY_S:-60}"; continue
    fi
    if [ "$rc" = 76 ] && [ -f "$req" ]; then # the install lost the network: same request, after a pause
      echo "$(date '+%F %T') ${sha:0:7} install lost the network; trying again in ${GAUSS_GATES_NET_RETRY_S:-600} s."
      [ "$once" = --once ] && return 0
      sleep "${GAUSS_GATES_NET_RETRY_S:-600}"; continue
    fi
    if [ -f "$req" ]; then # run-one died before it could say why
      gates_result "$sha" "$tree" ERROR "gate run exited $rc without a result (log: $LOGS/gates-runner.log)"; rm -f "$req"
    fi
    tail -1 "$GATES_RESULTS"
  done
  echo "$(date '+%F %T') gate queue empty."
}

gates_run_one() { # gates_run_one <request>: check out, install if the lockfile changed, gates_record, write the result
  local req=$1 sha tree repo node by co lock out rc=0 line status
  # Withdrawn while claude-heavy waited (a session re-queued a new head): nothing to run.
  [ -f "$req" ] || { echo "Request $(basename "$req") was withdrawn; skipping."; return 0; }
  local pr; pr=$(req_get "$req" pr)
  if [ -n "$pr" ]; then # merge train: test what would land, not a head main has moved past
    train_sync "$req" || return 0 # withdrawn: closed PR, moved head or a conflict (result written)
    # Already gated (passed, then held as a draft or for GitHub's state): no second 5-30 min run.
    if gate_record "$(req_get "$req" tree)" >/dev/null; then
      sha=$(req_get "$req" sha); tree=$(req_get "$req" tree); repo=$(req_get "$req" repo); rm -f "$req"
      gates_result "$sha" "$tree" SKIPPED "already passed: going straight to the merge"
      train_merge "$pr" "$sha" "$tree" "$repo" || true
      return 0
    fi
  fi
  sha=$(req_get "$req" sha); tree=$(req_get "$req" tree); repo=$(req_get "$req" repo); node=$(req_get "$req" node); by=$(req_get "$req" by)
  [ -n "$node" ] && [ -x "$node" ] && NODE=$node # the Node the session queued with (.nvmrc: Node 26)
  co=${GAUSS_GATES_CHECKOUT:-$(dirname "$repo").worktrees/gates}
  gates_fail() { gates_result "$sha" "$tree" ERROR "$1"; rm -f "$req"; return 1; }
  mkdir -p "$GATES_DIR/runs"
  if [ -e "$co" ]; then
    # Only ever reset a checkout the queue made: never someone's working checkout.
    grep -Fqx "$co" "$GATES_DIR/checkouts" 2>/dev/null || { gates_fail "$co exists and was not made by the gate queue (set GAUSS_GATES_CHECKOUT)"; return 1; }
    { git -C "$co" checkout -q --detach -f "$sha" && git -C "$co" clean -fdq; } || { gates_fail "could not check out ${sha:0:7} in $co"; return 1; }
  else
    git --git-dir="$repo" -c advice.detachedHead=false worktree add -q --detach "$co" "$sha" || { gates_fail "could not add the gate checkout $co at ${sha:0:7}"; return 1; }
    echo "$co" >>"$GATES_DIR/checkouts" # one per repository
  fi
  # One install for consecutive requests with the same package-lock.json.
  [ -f "$co/package-lock.json" ] && lock=$(install_key "$co") || { gates_fail "no package-lock.json at ${sha:0:7}"; return 1; }
  if [ "$(cat "$co/node_modules/.gauss-lock" 2>/dev/null)" != "$lock" ]; then
    echo "Installing dependencies in $co ..."
    if ! (cd "$co" && PATH="$(dirname "$NODE"):$PATH" npm ci --no-audit --no-fund >"$GATES_DIR/runs/$sha.install.log" 2>&1); then
      # A dropped download (5 Nov 2026: read ETIMEDOUT on the phone hotspot) isn't the commit's fault:
      # the request stays first in line and the runner tries again later.
      if grep -Eq 'ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|network request to' "$GATES_DIR/runs/$sha.install.log"; then
        echo "npm ci lost the network for ${sha:0:7} (log: $GATES_DIR/runs/$sha.install.log): it stays queued."; return 76
      fi
      gates_fail "npm ci failed (log: $GATES_DIR/runs/$sha.install.log)"; return 1
    fi
    echo "$lock" >"$co/node_modules/.gauss-lock"
  fi
  # The native MHD kernel: npm ci no longer builds it (package.json "gypfile": false, GAU-228) and the
  # backend loads it only with GAUSS_NATIVE_MHD=1, but the gate still builds it so the GAU-133 test
  # (kernel vs TypeScript) keeps running. Rebuild only when its sources differ: a stale build/ once
  # tested a commit against another commit's C++ (2026-10-31).
  if [ -f "$co/binding.gyp" ]; then
    local native; native=$(cat "$co/binding.gyp" "$co"/backend/cpp/* 2>/dev/null | shasum | cut -d' ' -f1)
    if [ "$(cat "$co/build/.gauss-native" 2>/dev/null)" != "$native" ]; then
      echo "Rebuilding the native kernel in $co ..."
      # npm's own bundled node-gyp (what the install uses), run by this Node so the addon matches its ABI.
      local gyp; gyp=$(PATH="$(dirname "$NODE"):$PATH"; p=$(command -v npm) && echo "$(dirname "$(readlink -f "$p")")/../node_modules/node-gyp/bin/node-gyp.js")
      (cd "$co" && PATH="$(dirname "$NODE"):$PATH" "$NODE" "$gyp" rebuild >"$GATES_DIR/runs/$sha.native.log" 2>&1) \
        || { gates_fail "native build failed (log: $GATES_DIR/runs/$sha.native.log)"; return 1; }
      echo "$native" >"$co/build/.gauss-native"
    fi
  fi
  out=$(GAUSS_BY=$by; gates_record "$co" 2>&1) || rc=$?
  printf '%s\n' "$out" >"$GATES_DIR/runs/$sha.log"
  line=$(printf '%s\n' "$out" | grep -E '^(PASSED|FAILED)' | tail -1 || true)
  if [ -n "$line" ]; then status=${line%% *}; line=${line#* }
  else status=ERROR; line="$(printf '%s\n' "$out" | tail -1) (log: $GATES_DIR/runs/$sha.log)"; fi
  gates_result "$sha" "$tree" "$status" "$line"
  rm -f "$req"
  [ "$status" = PASSED ] || return 1
  [ -z "$pr" ] || train_merge "$pr" "$sha" "$tree" "$repo" || true # a pass stands whether or not it merged
}

# The merge train (Josh 2026-11-03, "make fixes to merge train always"): overnight, main moved
# twice (#197, #213) and every queued gate tested a head that could no longer merge; each PR then
# needed a session awake to merge main in, re-queue, wait and merge. A request queued with --pr
# now does that itself. Same rules as the standing approval (CLAUDE.md): passed on the exact head,
# head contains origin/main, GitHub says CLEAN, not a draft, and nothing it changes matches
# TRAIN_HOLD (auth, RBAC, crypto/TLS, secrets, CyberTiger, keys); those pass and wait for Josh.
# Only fast-forward pushes of a merge commit to the PR's own branch; never a force push.
TRAIN_REPO="${GAUSS_TRAIN_REPO:-Pallas117/Constellation}"
TRAIN_HOLD="${GAUSS_TRAIN_HOLD:-auth|rbac|crypto|tls|secret|cybertiger|passkey|bpsec|signing|trust/|\.env|keys?\.}"

train_pr() { # train_pr <pr>: "state head branch base draft merge-state" on one line, or fail
  gh pr view "$1" --repo "$TRAIN_REPO" --json state,headRefOid,headRefName,baseRefName,isDraft,mergeStateStatus \
    -q '[.state, .headRefOid, .headRefName, .baseRefName, (.isDraft|tostring), .mergeStateStatus] | join(" ")' 2>/dev/null
}

train_sync() { # train_sync <request>: merge origin/main into a train PR's head before its run; 1 = withdrawn
  local req=$1 pr sha tree repo info state head branch base _ w new
  pr=$(req_get "$req" pr); sha=$(req_get "$req" sha); tree=$(req_get "$req" tree); repo=$(req_get "$req" repo)
  git --git-dir="$repo" fetch -q origin 2>/dev/null || { echo "fetch failed: gating ${sha:0:7} as queued"; return 0; }
  info=$(train_pr "$pr") || { echo "GitHub unreachable: gating ${sha:0:7} as queued"; return 0; }
  read -r state head branch base _ _ <<<"$info"
  if [ "$state" != OPEN ]; then gates_result "$sha" "$tree" SKIPPED "PR #$pr is ${state:-gone}"; rm -f "$req"; return 1; fi
  if [ "$head" != "$sha" ]; then
    gates_result "$sha" "$tree" SKIPPED "PR #$pr moved on to ${head:0:7}; queue that head"; rm -f "$req"; return 1
  fi
  [ "$base" = main ] || return 0 # stacked: gated as it is; it syncs once its base has merged
  git --git-dir="$repo" merge-base --is-ancestor refs/remotes/origin/main "$sha" && return 0
  w=$(mktemp -d -t gauss-train)/w
  git --git-dir="$repo" worktree add -q --detach "$w" "$sha" 2>/dev/null || { echo "could not prepare a merge of main; gating as queued"; return 0; }
  if git -C "$w" merge -q --no-edit -m "Merge origin/main into $branch (merge train)" refs/remotes/origin/main >/dev/null 2>&1 \
     && new=$(git -C "$w" rev-parse HEAD) && git -C "$w" push -q origin "$new:refs/heads/$branch" 2>/dev/null; then
    sed -i '' -e "s/^sha=.*/sha=$new/" -e "s/^tree=.*/tree=$(git -C "$w" rev-parse "$new^{tree}")/" "$req"
    gates_result "$sha" "$tree" MOVED "merged main into PR #$pr: gating ${new:0:7} instead"
    echo "Merged main into PR #$pr: ${sha:0:7} -> ${new:0:7}"
  else
    git -C "$w" merge --abort 2>/dev/null || true
    gates_result "$sha" "$tree" CONFLICT "PR #$pr can't take main without a person (conflict, or its branch moved)"
    phone -key "train-$pr" -every 6h "Gauss: PR #$pr needs a hand" "Main has moved and #$pr doesn't merge with it cleanly. A session needs to merge main into it."
    rm -f "$req"
  fi
  git --git-dir="$repo" worktree remove --force "$w" 2>/dev/null || true
  [ -f "$req" ]
}

train_merge() { # train_merge <pr> <sha> <tree> <repo>: merge a PR that just passed, if every rule holds
  local pr=$1 sha=$2 tree=$3 repo=$4 info state head branch base draft merge i files held child why
  git --git-dir="$repo" fetch -q origin 2>/dev/null || true
  for i in 1 2 3; do # GitHub computes mergeability lazily: UNKNOWN right after a push
    info=$(train_pr "$pr") || return 1
    read -r state head branch base draft merge <<<"$info"
    [ "$merge" != UNKNOWN ] && break
    sleep "${GAUSS_TRAIN_WAIT_S:-10}"
  done
  why=""
  [ "$state" = OPEN ] || why="PR is $state"
  [ -z "$why" ] && [ "$head" != "$sha" ] && why="PR moved on to ${head:0:7}"
  [ -z "$why" ] && [ "$base" != main ] && why="stacked on $base: merges after it"
  [ -z "$why" ] && [ "$draft" = true ] && why="draft"
  [ -z "$why" ] && ! git --git-dir="$repo" merge-base --is-ancestor refs/remotes/origin/main "$sha" && why="main moved during the run: re-queue it"
  [ -z "$why" ] && [ "$merge" != CLEAN ] && why="GitHub says $merge"
  if [ -z "$why" ]; then
    files=$(git --git-dir="$repo" diff --name-only "refs/remotes/origin/main...$sha")
    held=$(printf '%s\n' "$files" | { grep -Ei -- "$TRAIN_HOLD" || true; } | sed -n 1,3p | tr '\n' ' ') # sed reads it all: no SIGPIPE
    [ -z "$held" ] || why="touches ${held% }: Josh merges"
  fi
  if [ -n "$why" ]; then
    gates_result "$sha" "$tree" HELD "passed, not merged: $why"
    # 12 Nov: merging one PR moved main under the next one's run, which then sat HELD until a person
    # re-queued it. Re-queue it at the front instead (train_sync merges main in), at most 3 times a day.
    [[ "$why" == "main moved during the run"* ]] && train_requeue "$pr" "$sha" "$tree" "$repo"
    return 1
  fi
  if gh pr merge "$pr" --repo "$TRAIN_REPO" --merge --match-head-commit "$sha" >/dev/null 2>&1; then
    gates_result "$sha" "$tree" MERGED "PR #$pr merged by the train after its gate passed on ${sha:0:7}"
    # PRs stacked on this one now belong on main (their next queued run merges main in).
    for child in $(gh pr list --repo "$TRAIN_REPO" --base "$branch" --state open --json number -q '.[].number' 2>/dev/null); do
      gh pr edit "$child" --repo "$TRAIN_REPO" --base main >/dev/null 2>&1 && echo "Retargeted PR #$child to main."
    done
    phone -key "train-merged" -every 1m "Gauss: merged #$pr" "PR #$pr passed its checks and is merged into main."
    return 0
  fi
  gates_result "$sha" "$tree" HELD "passed, but gh pr merge refused it"
  return 1
}

gates_show_result() { # gates_show_result <checkout-dir>|<commit>: the latest line for that tree; exit 0 passed, 1 failed/none, 3 queued
  local arg=${1:?usage: $0 gates result <checkout-dir>|<commit>|status} tree="" line f
  if gates_resolve "$arg" 2>/dev/null; then tree=$G_TREE; else tree=$arg; fi # a session's worktree may be gone: match a prefix
  if [ ${#tree} = 40 ] && f=$(gates_queued "$tree"); then
    echo "QUEUED ${tree:0:7} since $(date -r "$(req_get "$f" queued)" '+%F %H:%M') by $(req_get "$f" by); runner: $(gates_runner_pid >/dev/null && echo working || echo 'not running (the awake guard restarts it within a minute)')"
    return 3
  fi
  line=$(awk -v t="$tree" 'index($2, t) == 1 || index($3, t) == 1' "$GATES_RESULTS" 2>/dev/null | tail -1)
  [ -n "$line" ] || { echo "No gate result or request for $arg."; return 1; }
  echo "$line"
  case $(echo "$line" | cut -d' ' -f4) in PASSED|MERGED|HELD) return 0 ;; SKIPPED) [[ "$line" == *" already passed: "* ]] ;; *) return 1 ;; esac
}

train_requeue() { # train_requeue <pr> <sha> <tree> <repo>: put a passed head main moved past back at the front
  local pr=$1 sha=$2 tree=$3 repo=$4 n f
  n=$(awk -v since="$(date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)" -v k="REQUEUED PR #$pr " \
    '$1 >= since && index($0, k)' "$GATES_RESULTS" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${n:-0}" -ge 3 ]; then
    gates_result "$sha" "$tree" HELD "PR #$pr was re-queued 3 times today as main kept moving: a person decides"
    return 1
  fi
  gates_queued "$tree" >/dev/null && return 0
  mkdir -p "$GATES_QUEUE"
  # "1" + time sorts before every request queued the usual way (they start with the 10-digit epoch
  # 17...), so it runs next; the queued= line keeps the real time for expiry.
  f="$GATES_QUEUE/1$(python3 -Ic 'import time; print("%.6f" % time.time())')-$tree.req"
  printf 'sha=%s\ntree=%s\nrepo=%s\nnode=%s\nby=%s\nqueued=%s\npr=%s\n' "$sha" "$tree" "$repo" "$NODE" "merge-train" "$(date +%s)" "$pr" >"$f.tmp" && mv "$f.tmp" "$f"
  gates_result "$sha" "$tree" REQUEUED "PR #$pr re-queued at the front: main moved during its run"
}

# Queue tooling (Josh 12 Nov, "make some tooling to improve this process"): see the queue by PR,
# move a PR to the front or back, and list the passes that wait for a person.
gates_pr_heads() { # one line per open PR: "<head sha> <number> <draft true|false> <merge state> <title>"
  gh pr list --repo "$TRAIN_REPO" --state open --limit 100 --json number,headRefOid,isDraft,mergeStateStatus,title \
    -q '.[] | "\(.headRefOid) \(.number) \(.isDraft) \(.mergeStateStatus) \(.title)"' 2>/dev/null
}

gates_queue() { # gates queue: the queue in run order, with each request's PR
  local f i=0 sha pr heads line
  heads=$(gates_pr_heads || true) # GitHub unreachable: list without PR details
  [ -n "$(ls "$GATES_QUEUE" 2>/dev/null | grep '\.req$')" ] || { echo "queue: empty"; return 0; }
  while IFS= read -r f; do
    i=$((i + 1)); sha=$(req_get "$GATES_QUEUE/$f" sha); pr=$(req_get "$GATES_QUEUE/$f" pr)
    line=""; [ -n "$pr" ] && line=$(awk -v n="$pr" '$2 == n' <<<"$heads")
    printf '%2d  %s  %-6s %s\n' "$i" "${sha:0:7}" "${pr:+#$pr}" \
      "$(if [ -z "$pr" ]; then echo "(gates only: a person merges)"; elif [ -z "$line" ]; then echo "(PR not open)"
         else read -r _h _n dr ms title <<<"$line"; printf '%s%s %s' "$([ "$dr" = true ] && echo 'draft, ')" "$ms" "$title" | cut -c1-80; fi)"
  done < <(ls "$GATES_QUEUE" | grep '\.req$' | sort)
}

gates_priority() { # gates priority <pr number|sha> front|back: move that request in the queue
  local key=${1:?usage: $0 gates priority <pr|sha> front|back} where=${2:-front} f b n=0 head
  case "$where" in front) head=1$(date +%s) ;; back) head=9$(date +%s) ;; *) echo "usage: $0 gates priority <pr|sha> front|back" >&2; return 2 ;; esac
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    b=$(basename "$f")
    mv "$f" "$GATES_QUEUE/$head.$(printf '%06d' "$n")-${b#*-}"; n=$((n + 1))
  done < <(grep -l -E "^(pr=$key|sha=$key)" "$GATES_QUEUE"/*.req 2>/dev/null)
  [ $n -gt 0 ] || { echo "Nothing queued for $key." >&2; return 1; }
  echo "Moved $n request(s) for $key to the $where."
  gates_queue
}

gates_waiting() { # gates waiting: open PRs whose head passed its gates and that wait for a person
  local repo heads sha num draft ms title tree last n=0 contains
  repo=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || { echo "Run this from a checkout of the repository." >&2; return 1; }
  git --git-dir="$repo" fetch -q origin 2>/dev/null || true
  heads=$(gates_pr_heads || true) # GitHub unreachable: list without PR details
  while read -r sha num draft ms title; do
    [ -n "$sha" ] || continue
    tree=$(git --git-dir="$repo" rev-parse "$sha^{tree}" 2>/dev/null) || continue
    gate_record "$tree" >/dev/null || continue
    gates_queued "$tree" >/dev/null && continue
    n=$((n + 1))
    last=$(awk -v s="$sha" '$2 == s' "$GATES_RESULTS" 2>/dev/null | tail -1 | cut -d' ' -f4-)
    contains=no; git --git-dir="$repo" merge-base --is-ancestor refs/remotes/origin/main "$sha" 2>/dev/null && contains=yes
    printf '#%s %s %s%s: %s\n' "$num" "${sha:0:7}" "$([ "$draft" = true ] && echo 'draft, ')" "$ms" "$(echo "$title" | cut -c1-70)"
    printf '    %s\n' "${last:-passed}"
    if [ "$draft" = true ]; then echo "    next: mark it ready (gh pr ready $num), then: $0 gates enqueue $sha --pr $num"
    elif [ "$ms" = DIRTY ]; then echo "    next: it conflicts with main: merge main into it by hand, then enqueue the new head with --pr $num"
    elif [ "$contains" = no ]; then echo "    next: main moved past it: $0 gates enqueue $sha --pr $num"
    elif [ "$ms" = CLEAN ]; then echo "    next (your call): gh pr merge $num --repo $TRAIN_REPO --merge --match-head-commit $sha"
    else echo "    next: GitHub says $ms; fix that first"; fi
  done <<<"$heads"
  [ $n -gt 0 ] || echo "Nothing passed and waiting."
}

gates_status() {
  local f n=0 p
  if p=$(gates_runner_pid); then echo "runner: working (pid $p)"; else echo "runner: not running"; fi
  if p=$(gates_runner_src) && [ -n "$p" ]; then echo "runner code: ${p:0:7} (from $(req_get "$GATES_SRC" from))"; else echo "runner code: not recorded"; fi
  for f in "$GATES_QUEUE"/*.req; do
    [ -f "$f" ] || continue; n=$((n + 1))
    echo "queued: $(req_get "$f" sha | cut -c1-7) by $(req_get "$f" by) since $(date -r "$(req_get "$f" queued)" '+%F %H:%M')"
  done
  [ $n -gt 0 ] || echo "queue: empty"
  if [ -n "$GATEBOX" ]; then echo "gatebox: $GATEBOX screens each request first"; else echo "gatebox: off (all gates run here)"; fi
  tail -5 "$GATES_RESULTS" 2>/dev/null || true
}

record_deploy() { # record_deploy <deploy|rollback> <ok|failed> <from> <to> <tree> <gates json|""> <reason>
  local ev=$1 result=$2 from=$3 to=$4 tree=$5 gates=${6:-null} reason=$7 fb="" by; by=$(deployer)
  ready_record && fb=$READY_SHA || true
  mkdir -p "$WATCH_DIR"
  printf '{"ts":"%s","action":%s,"by":%s,"from":%s,"to":%s,"tree":%s,"gates":%s,"fallback":%s,"result":%s,"emergency":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_str "$ev")" "$(json_str "$by")" "$(json_str "$from")" "$(json_str "$to")" \
    "$(json_str "$tree")" "$gates" "$(json_opt "$fb")" "$(json_str "$result")" "$(json_opt "$DEPLOY_EMERGENCY")" >>"$DEPLOY_HISTORY"
  event "$ev" "${to:0:7}" "$reason" by="$by" from="$from" to="$to" tree="$tree" gates:="$gates" \
    fallback="$fb" result="$result" emergency="$DEPLOY_EMERGENCY"
}

deploy_state() { # "ok|no <description>" for status and check: is what runs in live a recorded deploy?
  local live head; live=$(live_dir) && [ -d "$live" ] && head=$(git -C "$live" rev-parse HEAD 2>/dev/null) \
    || { echo "no live: not installed"; return 0; }
  python3 -Ic '
import json, sys
from datetime import datetime, timezone
head, rows = sys.argv[2], []
try:
    rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
except (OSError, ValueError):
    pass
ok = [r for r in rows if r.get("to") == head and r.get("result") == "ok"]
if not ok:
    print("no live = %s has no deploy record (switched by hand?): deploy it with gauss-services.sh deploy" % head[:7]); sys.exit()
r = ok[-1]
when = datetime.strptime(r["ts"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
what = "rolled back to" if r.get("action") == "rollback" else "deployed"
if r.get("emergency"):
    print("no live = %s, %s %s by %s in an EMERGENCY (%s): no gate record" % (head[:7], what, when, r.get("by"), r["emergency"]))
elif r.get("gates"):
    g = r["gates"]
    print("ok live = %s, %s %s by %s, gates recorded (npm test %s, test:ops %s, VCRM %s)" % (head[:7], what, when, r.get("by"),
          (g.get("test") or {}).get("pass"), (g.get("test_ops") or {}).get("pass"), (g.get("verify") or {}).get("vcrm")))
else:
    print("no live = %s, %s %s by %s, no gate record" % (head[:7], what, when, r.get("by")))
' "$DEPLOY_HISTORY" "$head"
}

# What a deploy can break, and so what decides a rollback. The rest of `check`
# (network, space weather, memory service, Argo) can be off for reasons a rollback
# wouldn't fix, so it is reported after a deploy, never acted on.
# tailnet_api_in <dist-assets-dir>: true if the build hardcodes a tailnet URL (an absolute
# http(s)://<host>.ts.net API origin breaks every browser on this Mac: macOS Tailscale doesn't loop
# its own share back). Only a URL counts: the Mesh page's code names the ".ts.net" suffix itself
# (lib/mesh-onboarding.ts), and a bare 'ts.net' match failed every deploy of main on 2026-10-31.
tailnet_api_in() { grep -rEqs 'https?://[A-Za-z0-9.-]+\.ts\.net' "$1"; }

deploy_ready() { # deploy_ready <dir> <seconds>: poll until the services answer, or give up
  local dir=$1 waited=0
  until [ "$(code http://127.0.0.1:3001/health)" = 200 ] && [ "$(code http://127.0.0.1:8080/)" = 200 ] \
    && [ "$(code http://127.0.0.1:8080/api/system/connectivity)" = 200 ] \
    && ! tailnet_api_in "$dir/frontend/dist/assets"; do
    [ "$waited" -ge "$2" ] && return 1
    sleep 3; waited=$((waited + 3)); touch "$DEPLOY_LOCK" 2>/dev/null || true
  done
}

# install_key <dir>: what node_modules was built for. Native modules (better-sqlite3, the MHD kernel)
# are built for one Node ABI, so a Node upgrade needs a reinstall even with the same lockfile (2 Nov: 25 -> 26).
install_key() { echo "$(shasum "$1/package-lock.json" | cut -d' ' -f1) node-$("$NODE" -v 2>/dev/null || echo none)"; }
node_changed() { # node_changed <dir>: node_modules was installed by another Node (unknown counts as unchanged)
  local was; was=$(cat "$1/node_modules/.gauss-node" 2>/dev/null) || return 1
  [ -n "$was" ] && [ "$was" != "$("$NODE" -v 2>/dev/null || echo none)" ]
}

deploy_power_short() { # prints why the power can't carry a deploy, or nothing
  local batt pct watts
  batt=$(pmset -g batt 2>/dev/null); pct=$(grep -Eo -m1 '[0-9]+%' <<<"$batt" | tr -d % || true)
  [ -n "$pct" ] && [ "$pct" -lt "$WORK_BATTERY" ] || return 0
  if [[ "$batt" != *"'AC Power'"* ]]; then echo "battery ${pct}% on battery"; return 0; fi
  if [[ "$batt" == *discharging* || "$batt" == *"not charging"* ]]; then echo "battery ${pct}% and the charger isn't keeping up"; return 0; fi
  watts=$(pmset -g ac 2>/dev/null | sed -n 's/^ *Wattage = \([0-9]*\)W.*/\1/p')
  [ -z "$watts" ] || [ "$watts" -ge 20 ] || echo "battery ${pct}% on a ${watts} W charger"
}
switch_live() { # switch_live <dir> <from sha> <to sha>: check out, npm ci if the lockfile or Node changed, reinstall
  git -C "$1" checkout -q --detach "$3" || return 1
  if [ ! -d "$1/node_modules" ] || ! git -C "$1" diff --quiet "$2" "$3" -- package-lock.json || node_changed "$1"; then
    echo "package-lock.json or Node changed: installing dependencies in $1 ..."
    (cd "$1" && PATH="$(dirname "$NODE"):$PATH" npm ci --no-audit --no-fund >/dev/null) || return 1
  fi
  [ -d "$1/node_modules" ] && { "$NODE" -v 2>/dev/null || echo none; } >"$1/node_modules/.gauss-node"
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
  # Only merged code with gates recorded for its exact tree, unless a person says why not.
  local tree gates="" prev_tree prev_gates=""
  tree=$(git -C "$live" rev-parse "$sha^{tree}") && prev_tree=$(git -C "$live" rev-parse "$prev^{tree}") || return 1
  gates=$(gate_record "$tree") || gates=""
  prev_gates=$(gate_record "$prev_tree") || prev_gates=""
  if [ -z "$DEPLOY_EMERGENCY" ]; then
    git -C "$live" merge-base --is-ancestor "$sha" origin/main 2>/dev/null \
      || { echo "${sha:0:7} is not on origin/main: merge it first (or --emergency <reason>)." >&2; return 1; }
    [ -n "$gates" ] || { echo "No passing gate record for ${sha:0:7} (tree ${tree:0:7}): run '$0 gates record <checkout at ${sha:0:7}>' first (or --emergency <reason>)." >&2; return 1; }
  fi
  read -r level _ < <(memory_stats)
  if [ "$level" -ge "$MEM_SHED_LEVEL" ]; then
    echo "Memory pressure is $(pressure_name "$level"): not deploying now (npm ci and the build need headroom). Retry when normal." >&2; return 1
  fi
  # The install and the build draw ~10 W: a battery under WORK_BATTERY without a charger that keeps
  # up can die mid-switch and leave live half-deployed (4 Nov 2026: a deploy ran at 13% on 8 W).
  local why_power; why_power=$(deploy_power_short) || true
  if [ -n "$why_power" ] && [ -z "$DEPLOY_EMERGENCY" ]; then
    echo "Not deploying now: $why_power. Plug into a 20 W+ charger (or --emergency <reason>)." >&2; return 1
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
  if [ -n "$DEPLOY_EMERGENCY" ]; then
    echo "EMERGENCY deploy of ${sha:0:7} by $(deployer): $DEPLOY_EMERGENCY (origin/main and gate checks skipped)"
    phone -key emergency-deploy -every 10m "Gauss: emergency deploy" \
      "${sha:0:7} by $(deployer) without the usual checks: $DEPLOY_EMERGENCY"
  fi

  # The standby becomes what runs now, if it is healthy: never swap a good fallback for a broken live.
  [ -z "$fbdir" ] && ready_record && fbdir=$READY_DIR
  if [ -z "$fbdir" ] && [ -z "$DEPLOY_NO_FALLBACK$DEPLOY_EMERGENCY" ]; then
    # FM-24: a deploy used to go ahead and leave no standby; the next live failure then had nothing to fail over to.
    echo "No fallback to refresh: pass a path ($0 deploy <commit> <fallback-dir>), or --no-fallback to deploy without one." >&2; return 1
  elif [ -z "$fbdir" ]; then
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
    record_deploy deploy ok "$prev" "$sha" "$tree" "$gates" "deployed ${sha:0:7} (was ${prev:0:7})"
    echo "Deployed ${sha:0:7}. Full checklist (for information; only the services decide a rollback):"
    check || true
    return 0
  fi
  echo "${sha:0:7} didn't come up within ${DEPLOY_WAIT}s: rolling back to ${prev:0:7} ..." >&2
  record_deploy deploy failed "$prev" "$sha" "$tree" "$gates" "${sha:0:7} didn't come up within ${DEPLOY_WAIT}s"
  if switch_live "$live" "$sha" "$prev" && deploy_ready "$live" "$DEPLOY_WAIT"; then
    echo "$(date '+%F %T') ${sha:0:7} failed, rolled back to ${prev:0:7}" >>"$LOGS/deploy.log"
    record_deploy rollback ok "$sha" "$prev" "$prev_tree" "$prev_gates" "${sha:0:7} failed, rolled back to ${prev:0:7}"
    phone -key deploy -every 10m "Gauss: deploy rolled back" \
      "${sha:0:7} didn't come up; live is back on ${prev:0:7}. Logs: ~/Library/Logs/gauss/backend.log"
    echo "Rolled back: live is on ${prev:0:7} again." >&2
    return 1
  fi
  echo "$(date '+%F %T') ${sha:0:7} failed and rollback to ${prev:0:7} failed" >>"$LOGS/deploy.log"
  record_deploy rollback failed "$sha" "$prev" "$prev_tree" "$prev_gates" "${sha:0:7} failed and rollback to ${prev:0:7} failed"
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
  fallback_watch || true
  local batt pct
  batt=$(pmset -g batt); pct=$(grep -Eo -m1 '[0-9]+%' <<<"$batt" | tr -d % || true)
  battery_alerts "$batt" "$pct"
  local level swap free; read -r level swap free < <(memory_stats)
  memory_alerts "$level" "$swap"
  memory_sample "$level" "$swap"
  fleet_memory_watch || true
  disk_alerts "$(disk_free_gb)" "$swap"
  rotate_logs
  balance || true
  # A queued gate run outlives a reboot or a killed runner: start one again.
  if ls "$GATES_QUEUE" 2>/dev/null | grep -c '\.req$' >/dev/null && ! gates_runner_pid >/dev/null; then gates_start >/dev/null || true; fi
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
  batt=$(pmset -g batt); pct=$(grep -Eo -m1 '[0-9]+%' <<<"$batt" | tr -d % || true)
  [[ "$batt" != *"'AC Power'"* ]] && [ -n "$pct" ] && on_battery=1
  read -r level swap free < <(memory_stats); disk=$(disk_free_gb)
  { [ "$level" -ge "$MEM_SHED_LEVEL" ] || swap_high "$swap"; } && mem_short=1
  [ $on_battery = 1 ] && [ "$pct" -le "$AWAKE_WARN_BATTERY" ] && batt_low=1
  # On AC only counts when it is gaining: a weak charger losing ground flapped learning and Low Power
  # Mode on and off at 10-14% (balance.log 27-28 Oct).
  local gaining=0; [ $on_battery = 0 ] && [[ "$batt" != *"discharging"* && "$batt" != *"not charging"* ]] && gaining=1
  { [ $gaining = 1 ] || [ "${pct:-0}" -gt $((AWAKE_WARN_BATTERY + 10)) ]; } && recovered=1
  local notify=() quiet=()
  act() { if [ $dry = 1 ]; then echo "would: $*"; else "$@" >/dev/null 2>&1 || true; fi; }

  # Only local-coder's own server, by its port. Gauss's memory answer model is also an
  # mlx_lm.server (same model, :3032, kept alive by launchd); matching it by name restarted it
  # every minute on 2026-10-19.
  local coder="mlx_lm.server.*--port $LOCAL_CODER_PORT"
  if { [ $mem_short = 1 ] || [ $batt_low = 1 ]; } && pgrep -f "$coder" >/dev/null 2>&1; then
    act pkill -f "$coder"; notify+=("stopped the local model server")
  fi
  # A leak grows whatever the pressure, so this one doesn't wait for memory to run short.
  local h p mb
  for h in $LEAKY_HELPERS; do
    for p in $(pgrep -x "$h" 2>/dev/null); do
      mb=$(footprint_mb "$p")
      if [ "${mb:-0}" -ge "$LEAK_MB" ]; then
        act pkill -x "$h"; notify+=("restarted $h (${mb} MB; a macOS helper that leaks, macOS starts it again)"); break
      fi
    done
  done
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
      # A text only when the disk was short; routine clearing between 10 and 15 GB is logged quietly.
      if [ "${after:-0}" -gt "$disk" ]; then
        if disk_short "$disk" "$swap"; then notify+=("cleared rebuildable caches (${disk} to ${after} GB free)")
        else quiet+=("cleared rebuildable caches (${disk} to ${after} GB free)"); fi
      fi
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
  elif [ "$(sleep_disabled)" = 1 ]; then echo "ok stays awake with the lid closed (sleeps on battery at ${AWAKE_MIN_BATTERY}%${BATTERY_HEALTH:+; battery health ${BATTERY_HEALTH}%})"
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
  batt=$(pmset -g batt); pct=$(grep -Eo -m1 '[0-9]+%' <<<"$batt" | tr -d % || true)
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
  disk_short "${disk:-0}" "$swap" && ok=no || ok=ok
  item $ok "disk ${disk:-?} GB free$([ $ok = no ] && echo " (need ${DISK_ALERT_GB}+, or ${DISK_MIN_GB}+ while swap is over ${SWAP_MAX_GB} GB)")"
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
  if tailnet_api_in "$(launchctl print "$UID_DOMAIN/uk.lightbound.gauss-frontend" 2>/dev/null | awk -F'= ' '/working directory =/ && !d {print $2; d=1}')/frontend/dist/assets" 2>/dev/null; then
    item no "frontend build is same-origin (it hardcodes an API host: reinstall)"
  else
    item ok "frontend build is same-origin"
  fi
  if [ "$PUBLIC_URL" != "http://127.0.0.1:8080" ]; then
    # This Mac can't open its own tailnet share (macOS Tailscale doesn't loop it
    # back), so verify the parts it can: sharing configured, and the website and
    # API accept the tailnet hostname. Open the URL on a phone to confirm the last hop.
    local host="${PUBLIC_URL#http://}"
    if tailscale serve status 2>/dev/null | grep -c "/api proxy http://127.0.0.1:3001/api" >/dev/null \
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
  # || true: with the backend not loaded, launchctl fails and pipefail + set -e would end the checklist here.
  local dir; dir=$(launchctl print "$UID_DOMAIN/uk.lightbound.gauss-backend" 2>/dev/null | awk -F'= ' '/working directory =/ && !d {print $2; d=1}' || true)
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
  local dep; dep=$(deploy_state); item "${dep%% *}" "${dep#* }"
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
    printf 'deploy   %s\n' "$(deploy_state | cut -d' ' -f2-)"
    ;;
  restart)
    # Live runs prebuilt JS (#194): after a checkout, restarting alone would run the old .js. Rebuild first.
    if live=$(live_dir) && [ -n "$live" ] && plutil -extract ProgramArguments json -o - "$AGENTS/uk.lightbound.gauss-backend.plist" 2>/dev/null | grep -c 'backend/server.js' >/dev/null; then
      prebuild_backend "$live"
      [ "${BACKEND_ARGS[0]}" = backend/server.js ] || echo "Warning: could not rebuild $live; the backend restarts on its previous build. Run deploy to fix." >&2
    fi
    for l in "${SERVICES[@]}"; do launchctl kickstart -k "$UID_DOMAIN/$l"; done
    sleep 8
    health
    ;;
  dev)
    dev_run "${2:-}"
    ;;
  prebuild) # prebuild <checkout-dir>: what deploy does before writing the backend agent
    prebuild_backend "${2:?usage: $0 prebuild <checkout-dir>}"; echo "backend runs: node ${BACKEND_ARGS[*]}"
    ;;
  deploy)
    shift; args=()
    while [ $# -gt 0 ]; do
      case "$1" in
        --emergency) DEPLOY_EMERGENCY=${2:-}; [ -n "$DEPLOY_EMERGENCY" ] || { echo "--emergency needs a reason" >&2; exit 2; }; shift ;;
        --no-fallback) DEPLOY_NO_FALLBACK=1 ;;
        -*) echo "deploy: unknown option $1 (usage: deploy <sha> [fallback dir] [--emergency <reason>] [--no-fallback])" >&2; exit 2 ;;
        *) args+=("$1") ;;
      esac
      shift
    done
    deploy "${args[0]:-}" "${args[1]:-}"
    ;;
  gates)
    case "${2:-}" in
      record) gates_record "${3:-}" ;;
      enqueue) gates_enqueue "${3:-}" "${4:-}" "${5:-}" ;;
      run) gates_run "${3:-}" ;;
      run-one) gates_run_one "${3:?}" ;;
      result) if [ "${3:-}" = status ]; then gates_status; else gates_show_result "${3:-}"; fi ;;
      queue) gates_queue ;;
      priority) gates_priority "${3:-}" "${4:-front}" ;;
      waiting) gates_waiting ;;
      *) for f in "$GATES_DIR"/*.json; do [ -f "$f" ] && gates_summary "$f"; done; true ;;
    esac
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
    sed -n '2,21p' "$0"
    exit 2
    ;;
esac
