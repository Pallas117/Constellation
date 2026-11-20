#!/bin/bash
# Tests for the awake guard's phone alerts (battery, memory) and the
# `resilience` checklist. System tools are stubbed on PATH and HOME is a temp
# dir, so nothing touches real power settings or sends a real alert.
#   bash scripts/ops/gauss-services.test.sh      (npm run test:ops)
#   GAUSS_OPS_JUNIT=<file> also writes a JUnit report, one test case per expect, named
#   exactly as the expect: `npm run verify` matches REQ-OPS and FMEA evidence by name.
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/gauss-services.sh"
JUNIT="${GAUSS_OPS_JUNIT:-}"; [ -z "$JUNIT" ] || . "$(dirname "$SCRIPT")/junit.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home/.config/argo" "$T/home/.claude" "$T/home/.local/share/mesh-heal"
pass=0; failed=0

stub() { printf '#!/bin/bash\n%s\n' "$2" >"$T/bin/$1"; chmod +x "$T/bin/$1"; }
stub pmset 'if [ "$1 $2" = "-g log" ]; then echo "2026-10-21 00:05:01 +0800 Shutdown Cause  	Shutdown Cause: ${CAUSE:--128}";
elif [ "$1 $2" = "-g ac" ]; then [ -z "${ACW:-}" ] || printf " Wattage = %sW\n" "$ACW";
elif [ "$1 $2" = "-g batt" ]; then printf "Now drawing from '"'"'%s'"'"'\n -InternalBattery-0 (id=1)\t%s\n" "$SRC" "$BATT"; else printf " SleepDisabled\t\t%s\n" "${SD:-0}"; fi'
stub memory_pressure 'echo "System-wide memory free percentage: ${FREE:-50}%"'
stub sysctl 'case "$*" in
  *pressure_level*) echo "${LEVEL:-1}" ;;
  *memorystatus_level*) echo "${AVAIL:-50}" ;;
  *boottime*) echo "{ sec = ${BOOT:-1000}, usec = 5 } Thu Oct 22 01:01:27 2026" ;;
  *waketime*) echo "{ sec = ${WAKE:-1000}, usec = 5 } Thu Oct 22 01:01:27 2026" ;;
  *) echo "total = 6144.00M  used = ${SWAPUSED:-1000}.00M  free = 0.00M  (encrypted)" ;;
esac'
stub ps 'case "$*" in *comm=*) echo "/opt/homebrew/bin/node" ;; *) echo "2097152 node" ;; esac'
stub top 'printf "Processes: 600 total\nPID    MEM\n${TOPPID:-1177}  ${TOPMEM:-2048M}\n"'
stub ioreg 'echo "\"AppleClamshellState\" = No"; [ -z "${FCC:-}" ] || echo "  \"BatteryData\" = {\"FullChargeCapacity\"=$FCC,\"NominalChargeCapacity\"=2424,\"DesignCapacity\"=4382}"'
# bootout/bootstrap flip a label in $KICKS.state (over $LOADED) and are logged in $KICKS
stub launchctl 'S="$KICKS.state"; case "$1" in
  print) l=${2##*/}; grep -qx "in $l" "$S" 2>/dev/null && exit 0; grep -qx "out $l" "$S" 2>/dev/null && exit 1
         for x in $LOADED; do [ "$2" = "gui/$(id -u)/$x" ] && exit 0; done; exit 1 ;;
  kickstart) echo "${3##*/}" >>"$KICKS"; exit 0 ;;
  bootout) l=${2##*/}; { grep -vx "in $l" "$S" 2>/dev/null; echo "out $l"; } >"$S.t"; mv "$S.t" "$S"; echo "bootout $l" >>"$KICKS"; exit 0 ;;
  bootstrap) l=$(basename "$3" .plist); { grep -vx "out $l" "$S" 2>/dev/null; echo "in $l"; } >"$S.t"; mv "$S.t" "$S"; echo "bootstrap $l" >>"$KICKS"; exit 0 ;;
esac; exit 1'
stub df 'printf "Filesystem 1G-blocks Used Available\n/dev/disk3s1s1 228 13 %s\n" "${DISKGB:-50}"'
stub curl 'case "$*" in
  *space-weather/latest*) [ -z "${SWLATEST:-}" ] || printf "%s" "$SWLATEST" ;;
  *rtsw_wind_1m*) [ -z "${RTSW:-}" ] || { echo "curl $*" >>"$ACTIONS"; printf "%s" "$RTSW"; } ;;
  *) printf "%s" "$(cat "$HEALTH_FILE" 2>/dev/null || echo "${HEALTH:-200}")" ;; esac' # code() reads only the HTTP status
stub sudo 'exit 1'
stub argo 'case "$1" in
  notify) [ $# -gt 1 ] || { [ -n "${OLD_ARGO:-}" ] && echo "usage: argo [status|doctor]" >&2 || echo "usage: argo notify [-key K -every 30m] TITLE MESSAGE" >&2; exit 1; }
          shift; echo "$*" >>"$LOG" ;;
  status) echo "${ARGOSTATUS:-● OK MY ts:on}" ;;
esac'

# balance stubs: the local model server is "running" when MLX=1; a helper named $LEAKY runs as
# pid 4242 with footprint $LEAKFP; actions land in $ACTIONS
stub pgrep 'if [ "$1" = -x ]; then [ -n "${LEAKY:-}" ] && [ "$2" = "$LEAKY" ] && echo 4242; exit; fi
[ "${MLX:-0}" = 1 ] && [[ "$*" == *mlx_lm.server* && "$*" == *"--port ${MLXPORT:-8089}"* ]]'
stub footprint '[ "$*" = "-p 4242" ] && printf "Gauss\n    phys_footprint: %s\n    phys_footprint_peak: 9 GB\n" "${LEAKFP:-12 MB}"'
stub pkill 'echo "pkill $*" >>"$ACTIONS"'
mkdir -p "$T/home/.local/bin"
printf '#!/bin/bash\necho "local-coder $*" >>"$ACTIONS"\n' >"$T/home/.local/bin/local-coder"
printf '#!/bin/bash\necho "disk-cleanup $*" >>"$ACTIONS"\n' >"$T/home/.local/bin/disk-cleanup"
printf '#!/bin/bash\necho sample >>"$HOME/mem-samples"\n' >"$T/home/.local/bin/mem-guard"
chmod +x "$T/home/.local/bin/local-coder" "$T/home/.local/bin/disk-cleanup" "$T/home/.local/bin/mem-guard"
mkdir -p "$T/diag"

run() { # run <args...>: gauss-services.sh with the stubs; alerts land in $LOG
  : >"$T/log"; : >"$T/kicks"; : >"$T/actions"
  env -i PATH="$T/bin:/usr/bin:/bin" HOME="$T/home" ARGO="$T/bin/argo" LOG="$T/log" KICKS="$T/kicks" GAUSS_PUBLIC_URL=http://127.0.0.1:8080 \
    GAUSS_SUDOERS="$T/sudoers" MLX="${MLX:-0}" MLXPORT="${MLXPORT:-8089}" ACTIONS="$T/actions" GAUSS_BALANCE="${GAUSS_BALANCE:-1}" \
    LOADED="${LOADED:-}" HEALTH="${HEALTH:-200}" HEALTH_FILE="${HEALTH_FILE:-}" GAUSS_DEPLOY_WAIT=0 DISKGB="${DISKGB:-50}" \
    GATEFAIL="${GATEFAIL:-}" MOVEMAIN="${MOVEMAIN:-}" GAUSS_BY=test-user BOOT="${BOOT:-1000}" GAUSS_DIAG_DIRS="$T/diag" GAUSS_EVENTS_MAX_KB="${GAUSS_EVENTS_MAX_KB:-5120}" \
    WAKE="${WAKE:-1000}" GAUSS_GATEBOX_TRUST="${GAUSS_GATEBOX_TRUST:-}" GAUSS_DEV_DRY="${GAUSS_DEV_DRY:-0}" GAUSS_GATES_START=0 HEAVYGIVEUP="${HEAVYGIVEUP:-}" NPMNET="${NPMNET:-}" GAUSS_GATEBOX="${GAUSS_GATEBOX:-}" GAUSS_GATEBOX_PROBE="${GAUSS_GATEBOX_PROBE:-true}" GAUSS_GATEBOX_WAIT_S="${GAUSS_GATEBOX_WAIT_S:-0}" GAUSS_GATEBOX_POLL_S="${GAUSS_GATEBOX_POLL_S:-1}" GAUSS_MESH_STORE="${GAUSS_MESH_STORE:-}" GAUSS_GATEBOX_TIMEOUT_S="${GAUSS_GATEBOX_TIMEOUT_S:-}" GAUSS_FLEET_MEMORY="${GAUSS_FLEET_MEMORY:-}" GAUSS_GATEBOX_KEY="$T/gatebox-key" GBRC="${GBRC:-}" GAUSS_GATES_EXPIRE_H="${GAUSS_GATES_EXPIRE_H:-72}" GAUSS_GATES_HOOK_S="${GAUSS_GATES_HOOK_S:-300}" GAUSS_DEV_API_PORT="${GAUSS_DEV_API_PORT:-3101}" \
    SRC="${SRC:-AC Power}" BATT="${BATT:-80%; charging; present: true}" SD="${SD:-0}" FCC="${FCC:-}" ACW="${ACW:-}" \
    LEAKY="${LEAKY:-}" LEAKFP="${LEAKFP:-12 MB}" AVAIL="${AVAIL:-50}" GAUSS_SWAP_LAST="${SWAPLAST:-/dev/null}" \
    GATEENV="${GATEENV:-}" GATES_PYTHON="${GATES_PYTHON:-}" ${GATELEAK:+ALLOWED_ORIGINS=https://live.example MESH_STORE_PATH=/live/data/mesh/devices.json COMMERCE_DB_PATH=/live/data/commerce/commerce.db GAUSS_BEDROCK_DIR=/live/data/bedrock NODE_ENV=production} \
    SWLATEST="${SWLATEST:-}" RTSW="${RTSW:-}" ARGOSTATUS="${ARGOSTATUS:-}" LEVEL="${LEVEL:-1}" FREE="${FREE:-50}" SWAPUSED="${SWAPUSED:-1000}" OLD_ARGO="${OLD_ARGO:-}" bash "$SCRIPT" "$@"
}
expect() { # expect <name> <condition-exit-code>
  if [ "$2" = 0 ]; then pass=$((pass + 1)); else failed=$((failed + 1)); echo "FAIL: $1"; sed 's/^/    alerts: /' "$T/log"; fi
  [ -z "$JUNIT" ] || junit_case "$1" "$2" "$(sed 's/^/alerts: /' "$T/log")"
}

# Deploy/check guard against a hardcoded tailnet API origin (2026-10-31: the bare 'ts.net' grep
# matched the Mesh page's ".ts.net" suffix check and rolled back every deploy of main).
eval "$(sed -n '/^tailnet_api_in()/p' "$SCRIPT")"
mkdir -p "$T/dist-suffix" "$T/dist-url" "$T/dist-plain"
printf 'function t(h){return h.endsWith(".ts.net")}' >"$T/dist-suffix/index.js"
printf 'const API="http://judith.tail4f9ebe.ts.net/api"' >"$T/dist-url/index.js"
printf 'const API=""' >"$T/dist-plain/index.js"
! tailnet_api_in "$T/dist-suffix"; expect "deploy guard: a build that only names the .ts.net suffix is same-origin" $?
tailnet_api_in "$T/dist-url"; expect "deploy guard: a build that hardcodes a tailnet API URL is caught" $?
! tailnet_api_in "$T/dist-plain"; expect "deploy guard: a plain same-origin build passes" $?
alerts() { cut -d' ' -f2 "$T/log" | tr '\n' ' ' | sed 's/ $//'; } # the -key of each alert sent
plain() { sed $'s/\033\\[[0-9;]*m//g'; }                          # drop the ✓/✗ colours

# Battery
SRC="AC Power" BATT="6%; AC attached; not charging present: true" SD=1 run awake guard
[ "$(alerts)" = "awake-unguarded charger-weak" ]; expect "6% on a weak charger with sleep disabled and no guard" $?
SRC="AC Power" BATT="80%; charging; 1:00 remaining present: true" run awake guard
[ -z "$(alerts)" ]; expect "80% charging: no alerts" $?
SRC="Battery Power" BATT="45%; discharging; 1:00 remaining present: true" run awake guard
[ "$(alerts)" = "battery-low" ]; expect "45% on battery: low warning" $?
# A worn battery lasts less per percent (4 Nov 2026: 52% health, 40 -> 28% in 16 min, then hibernate):
# under 70% health the floor and the warning rise 10 points.
SRC="Battery Power" BATT="55%; discharging; 1:00 remaining present: true" run awake guard
[ -z "$(alerts)" ]; expect "55% on a battery of unknown health: no warning" $?
FCC=4000 SRC="Battery Power" BATT="55%; discharging; 1:00 remaining present: true" run awake guard
[ -z "$(alerts)" ]; expect "55% on a healthy battery (91%): no warning" $?
FCC=2294 SRC="Battery Power" BATT="55%; discharging; 1:00 remaining present: true" run awake guard
[ "$(alerts)" = "battery-low" ] && grep -q "sleeps at 50%" "$T/log"; expect "55% on a worn battery (52% health): low warning, sleeps at 50%" $?
FCC=2294 SRC="Battery Power" BATT="48%; discharging; 1:00 remaining present: true" run awake guard
[ "$(alerts)" = "battery-critical" ]; expect "48% on a worn battery: at its 50% floor" $?
# Plug in ahead: on battery with gate runs queued (each ~5 % of battery, measured 3 Nov)
PQ="$T/home/Library/Application Support/Gauss/gates/queue"; mkdir -p "$PQ"
SRC="Battery Power" BATT="80%; discharging; 3:00 remaining present: true" run awake guard
[ -z "$(alerts)" ]; expect "plug ahead: on battery with nothing queued, no text" $?
touch "$PQ/1-a.req" "$PQ/2-b.req"
SRC="Battery Power" BATT="80%; discharging; 3:00 remaining present: true" run awake guard
[ -z "$(alerts)" ]; expect "plug ahead: 80% covers two queued gates (~10%), no text" $?
SRC="Battery Power" BATT="57%; discharging; 2:00 remaining present: true" run awake guard
[ "$(alerts)" = "plug-ahead" ] && grep -q "plug in soon" "$T/log"; expect "plug ahead: 57% with two gates queued would stop at 50%: text early" $?
SRC="Battery Power" BATT="45%; discharging; 1:00 remaining present: true" run awake guard
[[ " $(alerts) " == *" plug-ahead "* ]] && grep -q "plug in to keep merging" "$T/log"; expect "plug ahead: under 50% with gates queued, they wait: text" $?
SRC="AC Power" BATT="45%; charging; present: true" run awake guard
[ -z "$(alerts)" ]; expect "plug ahead: on AC, no text" $?
# 17 Nov: with claude-heavy's eclipse budget (a gate runs on battery at 38%, ~8% each) the texts use its numbers.
mkdir -p "$T/home/.local/bin"
printf '%s\n' '#!/bin/bash' '[ "$1 $2" = "--need gates" ] && echo "38 8"' >"$T/home/.local/bin/claude-heavy"; chmod +x "$T/home/.local/bin/claude-heavy"
SRC="Battery Power" BATT="45%; discharging; 1:00 remaining present: true" run awake guard
[[ " $(alerts) " == *" plug-ahead "* ]] && grep -q "need about 16% of battery; at 45% the queue stops at 38%" "$T/log"; expect "plug ahead: claude-heavy's budget (38%, 8%/gate): 45% with two gates queued, text early" $?
SRC="Battery Power" BATT="36%; discharging; 1:00 remaining present: true" run awake guard
[[ " $(alerts) " == *" plug-ahead "* ]] && grep -q "Under 38% on battery they wait" "$T/log"; expect "plug ahead: under claude-heavy's 38% line, they wait: text" $?
printf '%s\n' '#!/bin/bash' 'echo "not numbers"' >"$T/home/.local/bin/claude-heavy"
SRC="Battery Power" BATT="45%; discharging; 1:00 remaining present: true" run awake guard
grep -q "Under 50% on battery they wait" "$T/log"; expect "plug ahead: an older claude-heavy (no --need): the 50% line" $?
rm -f "$T/home/.local/bin/claude-heavy" "$PQ"/*.req
SRC="Battery Power" BATT="9%; discharging; 0:20 remaining present: true" run awake guard
[ "$(alerts)" = "battery-critical" ]; expect "9% on battery: at the floor" $?
SRC="Battery Power" BATT="55%; discharging; 4:00 remaining present: true" run awake guard
[ -z "$(alerts)" ]; expect "55% on battery: no alerts" $?

# Memory: the kernel's pressure level and swap GB decide, never "free %" or swap "% used"
LEVEL=4 run awake guard
[ "$(alerts)" = "memory-low" ] && grep -q "memory pressure critical" "$T/log" && grep -q "node 2.0 GB" "$T/log"
expect "critical pressure: alert names the biggest process" $?
LEVEL=2 run awake guard
[ -z "$(alerts)" ]; expect "warn pressure alone: no phone alert" $?
FREE=10 run awake guard
[ -z "$(alerts)" ]; expect "10% 'free' at normal pressure: no alert (free % is not the signal)" $?
SWAPUSED=4200 run awake guard
[ "$(alerts)" = "swap-high" ] && grep -q "swap 4.1 GB" "$T/log"; expect "4.1 GB swap: alert" $?
stub sysctl 'case "$*" in *pressure_level*) echo 2 ;; *) echo "total = 3072.00M  used = 2800.00M  free = 272.00M  (encrypted)" ;; esac'
run awake guard
[ -z "$(alerts)" ]; expect "2.8 of 3 GB swap (91%; macOS adds swap files on demand): no alert" $?
stub sysctl 'case "$*" in
  *pressure_level*) echo "${LEVEL:-1}" ;;
  *memorystatus_level*) echo "${AVAIL:-50}" ;;
  *boottime*) echo "{ sec = ${BOOT:-1000}, usec = 5 } Thu Oct 22 01:01:27 2026" ;;
  *waketime*) echo "{ sec = ${WAKE:-1000}, usec = 5 } Thu Oct 22 01:01:27 2026" ;;
  *) echo "total = 6144.00M  used = ${SWAPUSED:-1000}.00M  free = 0.00M  (encrypted)" ;;
esac'
LEVEL=1 SWAPUSED=3000 run awake guard
[ -z "$(alerts)" ]; expect "healthy memory: no alerts" $?
AVAIL=8 run awake guard
[ "$(alerts)" = "memory-low" ] && grep -q "memory almost out (8% left)" "$T/log"
expect "8% available at a 'normal' pressure level (the level lags swap death): alert" $?
AVAIL=12 run awake guard
[ -z "$(alerts)" ]; expect "12% available: no alert" $?
# Runaway: swap grows 1 GB+ between two readings at most 150 s apart
rm -f "$T/swaplast"
SWAPLAST="$T/swaplast" SWAPUSED=1000 run awake guard
[ -z "$(alerts)" ]; expect "first swap reading: nothing to compare, no alert" $?
SWAPLAST="$T/swaplast" SWAPUSED=2200 run awake guard
[ "$(alerts)" = "swap-fast" ] && grep -q "Biggest: node 2.0 GB" "$T/log"; expect "swap +1.2 GB in a minute: runaway alert naming the biggest process" $?
echo "$(( $(date +%s) - 600 )) 1000" >"$T/swaplast"
SWAPLAST="$T/swaplast" SWAPUSED=2200 run awake guard
[ -z "$(alerts)" ]; expect "the same rise over 10 minutes is not a runaway" $?

# mem-guard's samples: what to close (sustained warn and swap climbing are Argo's guard texts, GAU-165)
M="$T/home/Library/Logs/gauss/memory.tsv"; mkdir -p "${M%/*}"
sample() { printf '%s\t%s\t40\t1.3\t1.8\t1.1\t2.8\t6\t%s\t15\t9.4\t8\t40\t2.2\t1.3\t1.2\t0.4\t0.1\t0.4\t0.4\t4.7\t5.5\t0.1\n' "$(date -v-"$1"M '+%F %T')" "$2" "$3"; }
{ printf 'ts\tlevel\tfree_pct\twired\tanon\tfile\tcmp_occ\tcmp_data\tswap\tdisk\tdemand\tram\tswapped_pct\tclaude_app\tcowork_vm\tclaude_code\tgauss_live\tdev\tvpn\twhatsapp\tbrowser\tmacos\tapps\n'
  sample 32 2 2.0; sample 21 2 2.4; sample 11 2 2.8; sample 1 2 3.2; } >"$M"
SWAPUSED=4300 run awake guard
grep -q "Gauss: swap 4.2 GB" "$T/log" && grep -q "Close: browser tabs 4.7 GB" "$T/log"; expect "high swap: the text says what to close" $?
touch -t "$(date -v-2H '+%Y%m%d%H%M')" "$M"
SWAPUSED=4300 run awake guard
grep -q "Close: node 2.0 GB" "$T/log"; expect "a stale sample (2 h old) is not used; falls back to the biggest process" $?
rm -f "$M"

# Disk (seen on the dev Mac: 5 GB free with 5 GB of swap)
DISKGB=5 run awake guard
[ "$(alerts)" = "disk-low" ]; expect "5 GB free disk: alert; a cleanup that frees nothing is not claimed" $?
DISKGB=20 run awake guard
[ -z "$(alerts)" ]; expect "20 GB free disk: no alert" $?
rm -f "$T/home/Library/Application Support/Gauss/balance-cleanup"
DISKGB=13 run awake guard
[ -z "$(alerts)" ] && grep -qx "disk-cleanup --apply --if-below 15" "$T/actions"
expect "13 GB free with little swap (54% of the dev Mac's samples): quiet cleanup, no text" $?
grep -q "balance: cleared\|disk-cleanup" "$T/actions"; expect "the quiet cleanup still runs" $?
rm -f "$T/home/Library/Application Support/Gauss/balance-cleanup"
DISKGB=13 SWAPUSED=4300 run awake guard
grep -q "disk 13 GB free, swap 4.2 GB" "$T/log" && grep -q "Swap is growing on a short disk" "$T/log"
expect "13 GB free with 4.2 GB swap (the 2026-10-22 panic's combination): a text that says why" $?
DISKGB=9 run awake guard
[ "$(alerts)" = "disk-low" ] && grep -q "below 12 GB" "$T/log"; expect "9 GB free: a text whatever the swap" $?
out=$(DISKGB=13 run resilience 2>&1 | plain)
[[ "$out" == *"✓ disk 13 GB free"* ]]; expect "resilience: 13 GB free with little swap passes" $?
out=$(DISKGB=13 SWAPUSED=4300 run resilience 2>&1 | plain)
[[ "$out" == *"✗ disk 13 GB free (need 12+, or 15+ while swap is over 4 GB)"* ]]; expect "resilience: 13 GB with high swap fails and says why" $?

# Replay: a real overnight drain from the dev Mac's pmset log (57% down to 2%,
# lid closed, on battery). Alert keys per reading; argo rate-limits repeats.
seq=""
for pct in 57 48 30 21 20 15 11 10 6 2; do
  SRC="Battery Power" BATT="${pct}%; discharging; present: true" run awake guard
  seq+="$pct:$(alerts) "
done
[ "$seq" = "57: 48:battery-low 30:battery-critical 21:battery-critical 20:battery-critical 15:battery-critical 11:battery-critical 10:battery-critical 6:battery-critical 2:battery-critical " ]
expect "replayed 57→2% drain: warn from 50%, critical from 40%" $?

EV="$T/home/Library/Logs/gauss/events.jsonl"
# ev <python expr over the list E of events>: true when it holds (python3 -I, so the check can't import from here)
ev() { python3 -Ic 'import json,sys; E=[json.loads(l) for l in open(sys.argv[1])]; sys.exit(0 if eval(sys.argv[2]) else 1)' "$EV" "$1" 2>/dev/null; }

# Watchdog: the guard keeps Argo, mesh-heal and the services alive, and leaves a heartbeat for Argo
kicked() { tr '\n' ' ' <"$T/kicks" | sed 's/ $//'; }
WD="$T/home/Library/Application Support/Gauss"
mkdir -p "$T/home/.local/state/argo"
touch "$T/home/.local/state/argo/state.json" "$T/home/.local/share/mesh-heal/state"
LOADED="uk.lightbound.argo uk.lightbound.mesh-heal" run awake guard
[ -z "$(kicked)" ] && [ -n "$(find "$WD/guard.heartbeat" -mmin -1)" ]; expect "fresh peers: no restarts, guard heartbeat written" $?
touch -t 202601010000 "$T/home/.local/state/argo/state.json" "$T/home/.local/share/mesh-heal/state"
LOADED="uk.lightbound.argo uk.lightbound.mesh-heal" run awake guard
[ "$(kicked)" = "uk.lightbound.argo uk.lightbound.mesh-heal" ]; expect "stale Argo and mesh-heal: both restarted" $?
touch -t 202601010000 "$T/home/.local/state/argo/state.json" "$T/home/.local/share/mesh-heal/state"
WAKE=$(( $(date +%s) - 120 )) LOADED="uk.lightbound.argo uk.lightbound.mesh-heal" run awake guard
[ -z "$(kicked)" ]; expect "stale peers 2 min after the Mac woke: sleep, not a stall; no restarts" $?
WAKE=$(( $(date +%s) - 20 * 60 )) LOADED="uk.lightbound.argo uk.lightbound.mesh-heal" run awake guard
[ "$(kicked)" = "uk.lightbound.argo uk.lightbound.mesh-heal" ]; expect "still stale 20 min after waking: restarted" $?
ev '[e["label"] for e in E if e["event"]=="watchdog_kick"][-2:]==["uk.lightbound.argo","uk.lightbound.mesh-heal"] and "no Argo check for" in E[-2]["reason"] and E[-1]["pressure"]==1 and E[-1]["swap_mb"]==1000 and E[-1]["battery"]==80 and E[-1]["on_ac"] is True'
expect "events: each watchdog restart is a JSON line with the memory and power state" $?
touch "$T/home/.local/state/argo/disabled"
LOADED="uk.lightbound.argo" run awake guard
[ -z "$(kicked)" ]; expect "argo off: not restarted" $?
rm -f "$T/home/.local/state/argo/disabled"
run awake guard
[ -z "$(kicked)" ]; expect "jobs not installed: nothing restarted" $?
for _ in 1 2; do LOADED="uk.lightbound.mesh-heal" run awake guard; done # 2 more kicks: 3 this hour
LOADED="uk.lightbound.mesh-heal" run awake guard
[ -z "$(kicked)" ] && grep -q "mesh-heal keeps failing" "$T/log"; expect "4th restart in an hour: alert instead of kicking" $?
rm -f "$WD/watch-kicks"; touch "$T/home/.local/share/mesh-heal/state" "$T/home/.local/state/argo/state.json"
HEALTH=000 LOADED="uk.lightbound.gauss-backend" run awake guard
[ -z "$(kicked)" ]; expect "backend down once: wait for a second failure" $?
HEALTH=000 LOADED="uk.lightbound.gauss-backend" run awake guard
[ "$(kicked)" = "uk.lightbound.gauss-backend" ]; expect "backend down twice: restarted" $?
HEALTH=000 LOADED="uk.lightbound.gauss-backend" run awake guard
HEALTH=200 LOADED="uk.lightbound.gauss-backend" run awake guard
HEALTH=000 LOADED="uk.lightbound.gauss-backend" run awake guard
[ -z "$(kicked)" ]; expect "a recovery resets the strike count" $?
old=$(( $(date +%s) - 3700 )); : >"$WD/watch-kicks"; rm -f "$WD"/*.strikes # 3 restarts, all over an hour ago
for _ in 1 2 3; do echo "uk.lightbound.gauss-backend $old" >>"$WD/watch-kicks"; done
for _ in 1 2; do HEALTH=000 LOADED="uk.lightbound.gauss-backend" run awake guard; done
[ "$(kicked)" = "uk.lightbound.gauss-backend" ] && [ -z "$(alerts)" ]; expect "restarts over an hour old don't count: restarted again, no alert" $?

# Fallback (GAU-158): when live is out of restarts and still down, swap in the cold standby
# A space in the fallback path, like the real "Gauss Aurora.worktrees/fallback": the ready
# record must keep the whole path (a plain `read -r sha dir _` cut it and broke failover).
FB="$WD/fallback"; FBDIR="$T/Gauss Aurora.worktrees/fallback"; LIVE="$T/live-checkout"; B=uk.lightbound.gauss-backend
mkdir -p "$FB" "$FBDIR/frontend/dist" "$FBDIR/backend" "$LIVE/backend" "$T/home/Library/LaunchAgents"
touch "$FBDIR/frontend/dist/index.html" "$FBDIR/backend/server.ts" "$LIVE/backend/server.ts"
plutil -create xml1 "$T/home/Library/LaunchAgents/$B.plist"
plutil -insert WorkingDirectory -string "$LIVE" "$T/home/Library/LaunchAgents/$B.plist"
exhaust() { local n; n=$(date +%s); : >"$WD/watch-kicks"; for _ in 1 2 3; do echo "$B $n" >>"$WD/watch-kicks"; done; }
rm -f "$T/kicks.state" "$WD"/*.strikes; exhaust
out=$(run fallback); [[ "$out" == *"none prepared (warning"* ]]; expect "fallback status: none prepared is a warning" $?
for _ in 1 2; do HEALTH=000 LOADED="$B" run awake guard; done
[ -z "$(kicked)" ] && grep -q "gauss-backend keeps failing" "$T/log"; expect "no fallback prepared: out of restarts only alerts" $?
echo "abc1234def $FBDIR $(date +%s)" >"$FB/ready"
touch "$FB/uk.lightbound.gauss-fallback-backend.plist" "$FB/uk.lightbound.gauss-fallback-frontend.plist"
out=$(run fallback); [[ "$out" == *"fallback ready: abc1234"* ]]; expect "fallback status: ready although its path has a space" $?
# A record that is corrupt, cut short, or names a checkout that is gone is no fallback: never a
# half failover (live booted out with nothing in its place), and the phone still hears.
good=$(cat "$FB/ready"); bad=0
for rec in "abc1234def" "not a ready record" "abc1234def $T/gone checkout $(date +%s)"; do
  echo "$rec" >"$FB/ready"
  [[ "$(run fallback)" == *"none prepared (warning"* ]] || bad=1
  for _ in 1 2; do HEALTH=000 LOADED="$B" run awake guard; done
  [ -z "$(kicked)" ] && [ ! -e "$T/kicks.state" ] && grep -q "gauss-backend keeps failing" "$T/log" || bad=1
done
echo "$good" >"$FB/ready"
[ $bad = 0 ]; expect "a corrupt, cut-short or orphaned fallback record reads as none prepared: no half failover, still alerts" $?
# FM-21: the standby going bad is texted when it happens, not only once a failover needs it.
fbsave="$T/fb-save"; mkdir -p "$fbsave"; cp "$T/log" "$WD/watch-kicks" "$fbsave/" 2>/dev/null || true # the failover tests below need them
fbbad() { : >"$T/log"; rm -f "$WD"/*.strikes "$WD/watch-kicks"; LOADED="$B" run awake guard >/dev/null 2>&1; grep "^[^ ]* fallback-bad " "$T/log"; }
[ -z "$(fbbad)" ]; expect "a usable standby: no standby text" $?
echo "abc1234def $T/gone checkout $(date +%s)" >"$FB/ready"; out=$(fbbad)
[[ "$out" == *"checkout, build or agents are gone"* ]]; expect "standby checkout gone: texted while live still runs" $?
echo "abc1234def" >"$FB/ready"; [[ "$(fbbad)" == *"corrupt or cut short"* ]]; expect "standby record corrupt: texted" $?
FBG="$T/fb-git"; mkdir -p "$FBG/frontend/dist"; touch "$FBG/frontend/dist/index.html"
git -C "$FBG" init -q && git -C "$FBG" add -A && git -C "$FBG" -c user.name=t -c user.email=t@t commit -qm one
echo "$(git -C "$FBG" rev-parse HEAD) $FBG $(date +%s)" >"$FB/ready"; ok1=$(fbbad)
git -C "$FBG" -c user.name=t -c user.email=t@t commit -q --allow-empty -m two
[ -z "$ok1" ] && [[ "$(fbbad)" == *"checkout moved to"* ]]; expect "standby checkout moved after it was prepared: texted" $?
rm -f "$FB/ready"; [ -z "$(fbbad)" ]; expect "nothing prepared: no standby text (status warns, deploy refuses)" $?
echo "$good" >"$FB/ready"; rm -f "$WD"/*.strikes; cp "$fbsave/log" "$T/log"; cp "$fbsave/watch-kicks" "$WD/" 2>/dev/null || true
out=$(run dev "$FBDIR" 2>&1); [[ "$out" == *"is the fallback checkout"* ]]; expect "dev refuses the fallback checkout (path with a space)" $?
for _ in 1 2; do HEALTH=000 LOADED="$B uk.lightbound.gauss-frontend" run awake guard; done
[ "$(kicked)" = "bootout $B bootout uk.lightbound.gauss-frontend bootout uk.lightbound.gauss-fallback-backend bootstrap uk.lightbound.gauss-fallback-backend bootout uk.lightbound.gauss-fallback-frontend bootstrap uk.lightbound.gauss-fallback-frontend" ] \
  && [ "$(alerts)" = "fallback" ] && [ -f "$FB/active" ]
expect "out of restarts and still down: fails over to the fallback and texts the phone" $?
out=$(LOADED="$B" run status); [[ "$out" == *"fallback serving from fallback since"* ]]; expect "status shows the fallback is serving" $?
for _ in 1 2; do HEALTH=000 LOADED="$B" run awake guard; done
[ "$(kicked)" = "uk.lightbound.gauss-fallback-backend uk.lightbound.gauss-fallback-frontend" ]; expect "on fallback: the guard restarts the fallback, never fails over again" $?
n=$(date +%s); for l in uk.lightbound.gauss-fallback-backend uk.lightbound.gauss-fallback-frontend; do printf '%s %s\n' "$l" "$n" "$l" "$n" >>"$WD/watch-kicks"; done # 3 each this hour
for _ in 1 2; do HEALTH=000 LOADED="$B" run awake guard; done
[ -z "$(kicked)" ] && [ "$(alerts)" = "watch-uk.lightbound.gauss-fallback-backend watch-uk.lightbound.gauss-fallback-frontend" ] && [ -f "$FB/active" ]
expect "on fallback and out of restarts: alerts only, no restart loop, no flip back to live" $?
LOADED="$B" run fallback off >/dev/null
[ "$(kicked)" = "bootout uk.lightbound.gauss-fallback-backend bootout uk.lightbound.gauss-fallback-frontend bootout $B bootstrap $B bootout uk.lightbound.gauss-frontend bootstrap uk.lightbound.gauss-frontend" ] \
  && [ ! -f "$FB/active" ] && ! grep -q "^$B " "$WD/watch-kicks"
expect "fallback off: live back, fresh restarts for it" $?
rm -f "$T/kicks.state" "$WD/watch-kicks"

# Dev layer: never the live or fallback checkout, never under memory pressure, never live's ports
out=$(run dev "$LIVE" 2>&1); [[ "$out" == *"is the live checkout"* ]]; expect "dev refuses the live checkout" $?
out=$(run dev "$FBDIR" 2>&1); [[ "$out" == *"is the fallback checkout"* ]]; expect "dev refuses the fallback checkout" $?
DEV="$T/dev-checkout"; mkdir -p "$DEV/backend" "$DEV/node_modules"; touch "$DEV/backend/server.ts"
out=$(LEVEL=2 run dev "$DEV" 2>&1); [[ "$out" == *"Memory pressure is warn"* ]]; expect "dev refuses at memory pressure warn" $?
out=$(HEALTH=000 GAUSS_DEV_DRY=1 run dev "$DEV" 2>&1); [[ "$out" == *"dev ok: $DEV site http://127.0.0.1:5174 api :3101"* ]]; expect "dev runs on :5174 and :3101" $?
out=$(GAUSS_DEV_DRY=1 run dev "$DEV" 2>&1); [[ "$out" == *"Port 3101 is in use"* ]]; expect "dev refuses a busy dev port" $?
out=$(HEALTH=000 GAUSS_DEV_DRY=1 GAUSS_DEV_API_PORT=3001 run dev "$DEV" 2>&1); [[ "$out" == *"belong to live"* ]]; expect "dev refuses live's ports" $?
# A real start, node stubbed to record what each server is given. Unset, the backend takes
# :3001 and the dev site proxies /api to :3001 (frontend/vite.config.ts), so dev must set them;
# explicit env also beats a checkout's .env under node --env-file, so a .env copied from live
# can't point dev back at live.
stub node 'if [[ "$*" == *vite.js* ]]; then for _ in $(seq 1 50); do grep -q "^api" "$ACTIONS" && break; sleep 0.1; done
  echo "web|$(pwd -P)|$GAUSS_DEV_WEB_PORT|$GAUSS_API_TARGET" >>"$ACTIONS"
else echo "api|$(pwd -P)|$PROXY_PORT|$GAUSS_PUBLIC_URL|$BETTER_AUTH_URL|$GAUSS_BEDROCK_DIR|$MESH_STORE_PATH|$COMMERCE_DB_PATH|$*" >>"$ACTIONS"; fi'
HEALTH=000 run dev "$DEV" >/dev/null 2>&1; P=$(cd "$DEV" && pwd -P)
[ "$(sed -n 1p "$T/actions")" = "api|$P|3101|http://127.0.0.1:5174|http://127.0.0.1:5174|$DEV/data/bedrock|$DEV/data/mesh/devices.json|$DEV/data/commerce/commerce.db|--env-file-if-exists=.env --import tsx backend/server.ts" ] \
  && [ "$(sed -n 2p "$T/actions")" = "web|$P|5174|http://127.0.0.1:3101" ] && [ "$(wc -l <"$T/actions" | tr -d ' ')" = 2 ]
expect "dev start: its own ports, data and API target, set explicitly, never live's" $?
rm -f "$T/bin/node"

# fallback prepare: only a fresh path or the previous fallback dir, never under memory pressure
git -C "$LIVE" init -q && git -C "$LIVE" -c user.email=t@t -c user.name=t commit -q --allow-empty -m t
out=$(LEVEL=2 run fallback prepare "$T/new-fb" 2>&1); [[ "$out" == *"Memory pressure is warn"* ]] && [ ! -e "$T/new-fb" ]
expect "prepare refuses at memory pressure warn" $?
out=$(run fallback prepare "$DEV" 2>&1); [[ "$out" == *"is not the current fallback"* ]]; expect "prepare never re-points someone else's checkout" $?

# deploy: live is a real repo; curl answers with the checked-out commit's "health" file,
# so a bad commit really fails and a rollback really brings the good one back.
stub node 'if [[ " $* " == *" build "* ]]; then mkdir -p frontend/dist && touch frontend/dist/index.html; fi'
# npm run <gate> prints what the real gates print (counts parsed by `gates record`); GATEFAIL=<gate> fails one
stub npm 'if [ "$1" = run ]; then
  [ "$2" = verify ] && [ -n "$MOVEMAIN" ] && [ -f "$MOVEMAIN" ] && { sh "$MOVEMAIN"; rm -f "$MOVEMAIN"; } # main moves mid-run
  [ -n "$GATEENV" ] && { env | grep -E "^(ALLOWED_ORIGINS|MESH_STORE_PATH|COMMERCE_DB_PATH|GAUSS_BEDROCK_DIR|NODE_ENV)=" ; echo "PATH=$PATH"; } >>"$GATEENV"
  case "$2" in
    test:ops) echo "gauss-services: 99 passed, 0 failed"; echo "ok  	argo	1.0s" ;;
    test|build) echo "$2 is not a gate: verify runs it" >&2; exit 9 ;;
    verify) echo "▶ Test suite"
      if [ "$GATEFAIL" = test ]; then printf "ℹ tests 5\nℹ pass 4\nℹ fail 1\n\n✖ failing tests:\n\ntest at backend/x.test.ts:1:1\n✖ the broken test (1.5ms)\n  AssertionError\n✖ Test suite (exit 1)\n"; else printf "ℹ tests 5\nℹ pass 5\nℹ fail 0\n✔ Test suite\n"; fi
      printf "▶ Production build\n✔ Production build\n"
      if [ "$GATEFAIL" = test ]; then echo "▶ VCRM: 39/40 requirements verified"; echo "  ✗ REQ-X-001: test failed: \"the broken test\""; else echo "▶ VCRM: 40/40 requirements verified"; fi
      echo "▶ FMEA: 12/14 failure modes mitigated"
      if [ "$GATEFAIL" = test ]; then echo "❌ VERIFY FAILED"; exit 1; fi
      echo "✅ VERIFY PASSED at $(git rev-parse --short HEAD)" ;;
  esac
  if [ "$GATEFAIL" = "quality:full" ] && [ "$2" = "quality:full" ]; then
    printf "/tmp/co/backend/replay/fetch-archive.ts\n  110:26  error  There is no cause attached to the symptom error being thrown  preserve-caught-error\n\nX 1 problem (1 error, 0 warnings)\n"
  fi
  [ "$GATEFAIL" != "$2" ]; exit
fi
[ -n "$NPMNET" ] && [ "$1" = ci ] && { echo "npm error network request to https://registry.npmjs.org/x.tgz failed, reason: read ETIMEDOUT" >&2; exit 1; }
echo "npm $*" >>"$ACTIONS"; mkdir -p node_modules'
g() { git -C "$LIVE" -c user.email=t@t -c user.name=t "$@"; }
head_is() { [ "$(g rev-parse HEAD)" = "$1" ]; }
mkdir -p "$LIVE/data/bedrock" "$LIVE/node_modules"
printf 'node_modules/\nfrontend/dist/\n' >"$LIVE/.gitignore"
echo 200 >"$LIVE/health"; echo a >"$LIVE/package-lock.json"; echo t0 >"$LIVE/data/bedrock/telemetry.jsonl"
mkdir -p "$LIVE/docs" "$LIVE/.claude"; echo doc >"$LIVE/docs/NOTE.md"; echo skill >"$LIVE/.claude/NOTE.md"
g add -A && g commit -qm good-a; A=$(g rev-parse HEAD)
echo v2 >"$LIVE/backend/server.ts"; g commit -qam good-b; Bc=$(g rev-parse HEAD)
echo 500 >"$LIVE/health"; g commit -qam bad; C=$(g rev-parse HEAD)
g checkout -q --detach "$Bc"; echo b >"$LIVE/package-lock.json"; g commit -qam new-lock; D=$(g rev-parse HEAD)
g checkout -q --detach "$A"; echo t1 >>"$LIVE/data/bedrock/telemetry.jsonl" # live data changed in place
# GAU-162: deploys need the commit on origin/main and a passing gate record for its tree
main_at() { g update-ref refs/remotes/origin/main "$1"; }
gated() { local t; t=$(g rev-parse "$1^{tree}"); mkdir -p "$WD/gates"
  printf '{"sha":"%s","tree":"%s","passed":true,"by":"test-user","at":"2026-10-22T00:00:00Z","test":{"pass":5}}\n' "$1" "$t" >"$WD/gates/$t.json"; }
main_at "$C"; for x in "$A" "$Bc" "$C" "$D"; do gated "$x"; done
FB2="$T/Gauss Aurora.worktrees/fb2"; rm -f "$FB/ready" "$T/kicks.state"; export HEALTH_FILE="$LIVE/health"
out=$(run deploy "$Bc" --dry-run 2>&1); rc=$?
[ $rc = 2 ] && head_is "$A" && [[ "$out" == *"unknown option --dry-run"* ]] && [ ! -d "$WD/deploying" ]
expect "deploy: an unknown flag stops before anything changes (not taken as the fallback dir)" $?
out=$(run deploy "$Bc" "$FB2" 2>&1); rc=$?
[ $rc = 0 ] && head_is "$Bc" && [[ "$out" == *"Deployed ${Bc:0:7}"* ]] && grep -q t1 "$LIVE/data/bedrock/telemetry.jsonl" && [ ! -d "$WD/deploying" ]
expect "deploy: live switched, its local data kept, lock released" $?
[[ "$(cat "$FB/ready")" == "$A $FB2 "* ]] && [ "$(grep -c '^npm ci' "$T/actions")" = 1 ]
expect "deploy: fallback refreshed to the previous version; npm ci only for the new fallback (live's lockfile unchanged)" $?
pl() { plutil -extract "$2" "${3:-raw}" -o - "$1" 2>/dev/null; } # pl <plist> <key path> [raw|json]
LA="$T/home/Library/LaunchAgents"; fbp="$FB/uk.lightbound.gauss-fallback-backend.plist"; fwp="$FB/uk.lightbound.gauss-fallback-frontend.plist"
[ "$(pl "$fwp" ProgramArguments json)" = "$(pl "$LA/uk.lightbound.gauss-frontend.plist" ProgramArguments json)" ] \
  && [[ "$(pl "$fwp" ProgramArguments json)" == *'"--port","8080","--strictPort"'* ]] \
  && [ "$(pl "$fbp" ProgramArguments.1)" = "--env-file-if-exists=$LIVE/.env" ] && ! pl "$fbp" EnvironmentVariables.PROXY_PORT >/dev/null \
  && [ "$(pl "$fbp" EnvironmentVariables.GAUSS_PUBLIC_URL)" = "$(pl "$LA/$B.plist" EnvironmentVariables.GAUSS_PUBLIC_URL)" ] \
  && [ "$(pl "$fbp" EnvironmentVariables.GAUSS_BEDROCK_DIR)" = "$LIVE/data/bedrock" ] \
  && [ "$(pl "$fbp" EnvironmentVariables.MESH_STORE_PATH)" = "$LIVE/data/mesh/devices.json" ] \
  && ! grep -q "bootstrap uk.lightbound.gauss-fallback" "$T/kicks"
expect "fallback plists: live's ports, URLs, data and .env; prepare never loads them" $?
out=$(run deploy "$C" 2>&1); rc=$?
[ $rc = 1 ] && head_is "$Bc" && [[ "$out" == *"Rolled back: live is on ${Bc:0:7}"* ]] && [ "$(alerts)" = "deploy" ] && [[ "$(cat "$FB/ready")" == "$Bc $FB2 "* ]]
expect "deploy of a bad commit: rolls back by itself and texts the phone; fallback is the last good one" $?
grep -q "${C:0:7} failed, rolled back to ${Bc:0:7}" "$T/home/Library/Logs/gauss/deploy.log"; expect "deploy log records the rollback" $?
# Service logs (4 Nov 2026: backend.log 12 MB, never rotated): over the cap, copied to .1 and emptied in place.
LG="$T/home/Library/Logs/gauss"; head -c 6000000 /dev/zero | tr '\0' 'x' >"$LG/backend.log"; echo small >"$LG/frontend.log"; echo keep >"$LG/memory.tsv.test"
run awake guard >/dev/null 2>&1
[ ! -s "$LG/backend.log" ] && [ "$(stat -f %z "$LG/backend.log.1")" = 6000000 ] && [ "$(cat "$LG/frontend.log")" = small ] && [ ! -e "$LG/frontend.log.1" ] && [ -s "$LG/memory.tsv.test" ]
expect "service logs over 5 MB are rotated to .1 and emptied; small ones and other tools' files are left" $?
rm -f "$LG/backend.log.1" "$LG/memory.tsv.test"
ev 'any(e["event"]=="deploy" and e["result"]=="ok" and e["live_sha"]=="'"$Bc"'" and e["from"]=="'"$A"'" and e["fallback_sha"]=="'"$A"'" for e in E)'
expect "events: a deploy line carries live_sha (the new commit), from and the fallback SHA" $?
ev '[(e["event"],e["result"],e["live_sha"]) for e in E if e["event"] in ("deploy","rollback")][-2:]==[("deploy","failed","'"$C"'"),("rollback","ok","'"$Bc"'")]'
expect "events: a failed deploy and its rollback, each with the SHA live was on" $?
ev 'any(e["event"]=="fallback_prepared" and e["fallback_sha"]=="'"$A"'" for e in E) and any(e["event"]=="alert" and e["label"]=="deploy" for e in E)'
expect "events: fallback prepared and the deploy alert are logged" $?
main_at "$D"; out=$(run deploy "$D" 2>&1); rc=$?
[ $rc = 0 ] && head_is "$D" && [[ "$out" == *"Fallback already at ${Bc:0:7}"* ]] && [ "$(cat "$T/actions")" = "npm ci --no-audit --no-fund" ]
expect "deploy: lockfile changed, so npm ci runs in live; fallback not rebuilt needlessly" $?
main_at "$C"; out=$(HEALTH_FILE=/nonexistent HEALTH=500 run deploy "$C" 2>&1); rc=$?
[ $rc = 1 ] && head_is "$D" && [[ "$out" == *"fallback stays at ${Bc:0:7}"* ]] && [ -f "$FB/active" ] && [[ " $(alerts) " == *" fallback "* ]]
expect "deploy and rollback both fail: switches to the fallback (kept, not replaced by an unhealthy live)" $?
ev 'E[-1]["event"]=="failover" and E[-1]["to"]=="'"$Bc"'" and E[-1]["live_sha"]=="'"$D"'" and E[-2]["event"]=="rollback" and E[-2]["result"]=="failed"'
expect "events: rollback failed, then failover to the fallback with both SHAs" $?
out=$(run deploy "$Bc" 2>&1); [[ "$out" == *"The fallback is serving now"* ]]; expect "deploy refuses while the fallback serves" $?
run fallback off >/dev/null
out=$(run deploy deadbeef 2>&1); [[ "$out" == *"Unknown commit 'deadbeef'"* ]]; expect "deploy refuses an unknown commit" $?
out=$(run deploy "$D" 2>&1); [[ "$out" == *"already at ${D:0:7}"* ]]; expect "deploy: already there is a no-op" $?
# Re-pointing the fallback checks it out first. If its install then fails, the checkout has
# changed under the old ready record: the deploy stops and the record goes, so status says
# "none prepared" rather than vouching for a fallback that isn't what it describes.
cp "$T/bin/npm" "$T/npm.saved" # the gate-aware stub above: put back as it was, later tests read its counts
stub npm 'echo "npm $*" >>"$ACTIONS"; exit 1'
out=$(run deploy "$Bc" 2>&1); rc=$?
[ $rc = 1 ] && head_is "$D" && [[ "$out" == *"Couldn't refresh the fallback; not deploying."* ]] && [ ! -e "$FB/ready" ] \
  && [[ "$(run fallback)" == *"none prepared (warning"* ]] && [ ! -d "$WD/deploying" ]
expect "deploy: a fallback that fails to rebuild stops the deploy and is not left marked ready" $?
mv "$T/npm.saved" "$T/bin/npm"
out=$(LEVEL=2 run deploy "$Bc" 2>&1); [[ "$out" == *"Memory pressure is warn"* ]] && head_is "$D"; expect "deploy refuses at memory pressure warn" $?
echo local >>"$LIVE/backend/server.ts"
out=$(run deploy "$Bc" 2>&1); [[ "$out" == *"local code changes"*"backend/server.ts"* ]] && head_is "$D"; expect "deploy refuses over local code changes in live" $?
g checkout -q -- backend/server.ts
mkdir "$WD/deploying"
out=$(run deploy "$Bc" 2>&1); [[ "$out" == *"Another deploy is running"* ]] && head_is "$D"; expect "one deploy at a time" $?
rm -f "$T/kicks.state" "$WD/watch-kicks"; unset HEALTH_FILE # health from $HEALTH again: services down
HEALTH=000 LOADED="$B" run awake guard; HEALTH=000 LOADED="$B" run awake guard
[ -z "$(kicked)" ] && [ ! -f "$WD/$B.strikes" ]; expect "the guard leaves the services alone during a deploy" $?
touch -t 202001010000 "$WD/deploying"
HEALTH=000 LOADED="$B" run awake guard; HEALTH=000 LOADED="$B" run awake guard
[ "$(kicked)" = "$B" ]; expect "a deploy lock older than 30 min no longer silences the guard" $?
rmdir "$WD/deploying"; rm -f "$WD/watch-kicks" "$WD"/*.strikes "$T/kicks.state"
rm -f "$FB/ready" # nothing prepared and no path given (FM-24): refused unless a person says --no-fallback
out=$(run deploy "$Bc" 2>&1); rc=$?
[ $rc = 1 ] && ! head_is "$Bc" && [[ "$out" == *"No fallback to refresh"*"--no-fallback"* ]]
expect "deploy with no fallback prepared or given: refused, live unchanged" $?
out=$(run deploy "$Bc" --no-fallback 2>&1); rc=$?
[ $rc = 0 ] && head_is "$Bc" && [[ "$out" == *"warning: no fallback to refresh"* ]] && [ ! -e "$FB/ready" ]
expect "deploy --no-fallback: warns, deploys, leaves none" $?
main_at "$D"; run deploy "$D" --no-fallback >/dev/null 2>&1; head_is "$D"; expect "deploy back to D, the gated tree the GAU-162 checks below start from" $?
# GAU-211: a commit that stops tracking live's telemetry file (now in .gitignore). Live appends to it in
# place by path while the deploy runs, so the file itself must stay where it is (same inode, never moved):
# a plain checkout refuses going forward (changed file) and going back silently writes the committed copy
# over live's (git overwrites ignored files).
tel="$LIVE/data/bedrock/telemetry.jsonl"; ino() { stat -f %i "$1"; }
kept() { [ "$(cat "$tel")" = "$before" ] && [ "$(ino "$tel")" = "$inode" ] && [ ! -e "$tel.gauss-keep" ]; } # same data, same file, no link left
saved=$(cat "$tel"); g checkout -q --detach "$D"; g rm -q --cached data/bedrock/telemetry.jsonl; echo data/bedrock/telemetry.jsonl >>"$LIVE/.gitignore"
g add .gitignore; g commit -qm untrack; U=$(g rev-parse HEAD)
echo 500 >"$LIVE/health"; g commit -qam bad-untrack; Ubad=$(g rev-parse HEAD)
rm "$tel"; g checkout -q --detach "$D"; echo "$saved" >"$tel"; gated "$U"; gated "$Ubad"; main_at "$Ubad"
echo t2 >>"$tel"; before=$(cat "$tel"); inode=$(ino "$tel")
out=$(HEALTH_FILE="$LIVE/health" run deploy "$Ubad" --no-fallback 2>&1); rc=$?
[ $rc = 1 ] && head_is "$D" && kept && [[ "$out" == *"Rolled back"* ]] && [ "$(g status --porcelain data)" = " M data/bedrock/telemetry.jsonl" ]
expect "GAU-211: a failed deploy across the untracking commit rolls back with live telemetry intact" $?
# The backend keeps appending while git checks out: this git appends the line in $T/mark by path just
# before and just after every checkout (and, once, removes the file if $T/git-eats exists; used below).
stub git 'if [[ " $* " != *" checkout -q --detach "* ]]; then exec /usr/bin/git "$@"; fi
[ ! -s "'"$T"'/mark" ] || cat "'"$T"'/mark" >>"'"$tel"'"
/usr/bin/git "$@"; rc=$?
if [ -e "'"$T"'/git-eats" ]; then rm -f "'"$T"'/git-eats" "'"$tel"'"; fi
[ ! -s "'"$T"'/mark" ] || cat "'"$T"'/mark" >>"'"$tel"'"
exit $rc'
appended() { [ "$(grep -c "^$1\$" "$tel")" = 4 ] && [ "$(grep -v "^$1\$" "$tel")" = "$before" ] && [ "$(ino "$tel")" = "$inode" ] && [ ! -e "$tel.gauss-keep" ]; }
echo during-forward >"$T/mark"; out=$(HEALTH_FILE="$LIVE/health" run deploy "$U" --no-fallback 2>&1); rc=$?
[ $rc = 0 ] && head_is "$U" && appended during-forward && [ -z "$(g ls-files data/bedrock)" ] && [ -z "$(g status --porcelain data)" ]
expect "GAU-211: deploy across the untracking commit keeps live telemetry (untracked, ignored, the same file) and every line appended meanwhile" $?
echo t3 >>"$tel"; before=$(cat "$tel")
echo older >"$tel.gauss-keep"; out=$(HEALTH_FILE="$LIVE/health" run deploy "$D" --no-fallback 2>&1); rc=$?
[ $rc = 1 ] && head_is "$U" && [[ "$out" == *"gauss-keep is live data left by an earlier checkout"* ]] && [ "$(cat "$tel")" = "$before" ] \
  && [ "$(cat "$tel.gauss-keep")" = older ] && [ -z "$(g status --porcelain --untracked-files=no data)" ]
expect "GAU-211: a differing copy left by an interrupted checkout stops the next one (neither file touched)" $?
rm "$tel.gauss-keep"
echo during-back >"$T/mark"; out=$(HEALTH_FILE="$LIVE/health" run deploy "$D" --no-fallback 2>&1); rc=$?
[ $rc = 0 ] && head_is "$D" && appended during-back && [ "$(g status --porcelain data)" = " M data/bedrock/telemetry.jsonl" ]
expect "GAU-211: deploying back to a commit that still tracks the file keeps live's copy and every line appended meanwhile" $?
# Safety net: a git that removes the file all the same (once, in the checkout) still leaves live's data in place.
: >"$T/mark"; before=$(cat "$tel")
touch "$T/git-eats"; out=$(HEALTH_FILE="$LIVE/health" run deploy "$U" --no-fallback 2>&1); rc=$?
[ $rc = 0 ] && head_is "$U" && kept && [ ! -e "$T/git-eats" ] && [[ "$out" == *"git touched data/bedrock/telemetry.jsonl"*"live's copy is back in place"* ]]
expect "GAU-211: if git removes the file during the checkout, live's copy is put back from the hard link" $?
mv "$tel" "$tel.gauss-keep" # as left by a run that stopped between git removing the file and the restore
out=$(HEALTH_FILE="$LIVE/health" run deploy "$D" --no-fallback 2>&1); rc=$?
[ $rc = 0 ] && head_is "$D" && kept
expect "GAU-211: an interrupted restore is finished by the next checkout before anything else" $?
rm "$T/bin/git" "$T/mark"
# A checkout git refuses for another reason (here a local change to a file the target also changes) leaves
# the data file, and what the index says about it, exactly as they were.
eval "$(sed -n '/^carry_checkout()/,/^}/p' "$SCRIPT")"
CR="$T/carry-repo"; c() { git -C "$CR" -c user.email=t@t -c user.name=t "$@"; }
git init -q "$CR"; mkdir -p "$CR/data/bedrock"; echo r0 >"$CR/data/bedrock/telemetry.jsonl"; echo v1 >"$CR/code"
c add -A; c commit -qm tracked; c rm -q --cached data/bedrock/telemetry.jsonl; echo data/bedrock/telemetry.jsonl >"$CR/.gitignore"; echo v2 >"$CR/code"
c add -A; c commit -qm untracked; CU=$(c rev-parse HEAD); c checkout -q --detach HEAD~1; echo r0 >"$CR/data/bedrock/telemetry.jsonl"
echo r1 >>"$CR/data/bedrock/telemetry.jsonl"; echo local >"$CR/code"; was=$(c status --porcelain); cino=$(ino "$CR/data/bedrock/telemetry.jsonl")
out=$(carry_checkout "$CR" "$CU" 2>&1); rc=$?
[ $rc = 1 ] && [ "$(c rev-parse HEAD)" != "$CU" ] && [ "$(c status --porcelain)" = "$was" ] && [ "$(ino "$CR/data/bedrock/telemetry.jsonl")" = "$cino" ] \
  && [ "$(cat "$CR/data/bedrock/telemetry.jsonl")" = "r0
r1" ] && [ ! -e "$CR/data/bedrock/telemetry.jsonl.gauss-keep" ]
expect "GAU-211: a checkout git refuses for another reason leaves the data file and its index entry as they were" $?
main_at "$D"
# 17 Nov 2026: a live checkout whose only edit was a skill file blocked a deploy. Edits under .claude/ or docs/
# are saved as patches and restored; any other changed path still refuses.
main_at "$Bc"; echo "local skill text" >>"$LIVE/.claude/NOTE.md"; echo "local doc" >>"$LIVE/docs/NOTE.md"
out=$(run deploy "$Bc" --no-fallback 2>&1); rc=$?
SAVEDS=("$T/home/Library/Logs/gauss/live-local-changes/"*/); SAVED=${SAVEDS[0]}
[ $rc = 0 ] && head_is "$Bc" && [[ "$out" == *"local doc/agent-note change"* ]] && [ -z "$(g status --porcelain --untracked-files=no -- .claude docs)" ] \
  && grep -q "local skill text" "$SAVED/.claude_NOTE.md.patch" && grep -q "local doc" "$SAVED/docs_NOTE.md.patch"
expect "deploy: local edits under .claude/ and docs/ are saved as patches, restored, and the deploy proceeds" $?
ev 'any(e["event"]=="deploy-local-doc-changes" and "saved_to" in e for e in E)'; expect "events: the saved doc-only live changes are logged" $?
main_at "$D"; run deploy "$D" --no-fallback >/dev/null 2>&1; head_is "$D" || expect "deploy back to D after the doc-only test" 1
main_at "$Bc"; echo "local skill text" >>"$LIVE/.claude/NOTE.md"; echo local >>"$LIVE/backend/server.ts"
out=$(run deploy "$Bc" --no-fallback 2>&1); [[ "$out" == *"local code changes"*"backend/server.ts"* ]] && head_is "$D" && ! grep -q "NOTE.md" <<<"${out#*server.ts}"
expect "deploy: a code change next to a doc change still refuses, and the doc change is not touched" $?
g checkout -q -- backend/server.ts .claude/NOTE.md
# A deploy's install and build can run a low battery flat mid-switch (4 Nov 2026: one ran at 13% on 8 W).
main_at "$Bc"
out=$(SRC="Battery Power" BATT="13%; discharging; present: true" run deploy "$Bc" 2>&1); rc=$?
[ $rc = 1 ] && head_is "$D" && [[ "$out" == *"battery 13% on battery"* ]]; expect "deploy refused at 13% on battery" $?
out=$(ACW=8 BATT="13%; charging; present: true" run deploy "$Bc" 2>&1); rc=$?
[ $rc = 1 ] && head_is "$D" && [[ "$out" == *"13% on a 8 W charger"* ]]; expect "deploy refused at 13% on an 8 W charger" $?
out=$(BATT="40%; AC attached; not charging present: true" run deploy "$Bc" 2>&1); rc=$?
[ $rc = 1 ] && head_is "$D" && [[ "$out" == *"charger isn't keeping up"* ]]; expect "deploy refused at 40% on a charger that isn't keeping up" $?
main_at "$D"

# GAU-162: every deploy and rollback is recorded; only merged, gated trees go live without --emergency
H="$WD/deploy-history.jsonl"
hist() { python3 -Ic 'import json,sys; H=[json.loads(l) for l in open(sys.argv[1])]; sys.exit(0 if eval(sys.argv[2]) else 1)' "$H" "$1" 2>/dev/null; }
hist 'H[0]["action"]=="deploy" and H[0]["result"]=="ok" and H[0]["by"]=="test-user" and H[0]["from"]=="'"$A"'" and H[0]["to"]=="'"$Bc"'" and H[0]["tree"]=="'"$(g rev-parse "$Bc^{tree}")"'" and H[0]["gates"]["passed"] is True and H[0]["fallback"]=="'"$A"'" and H[0]["emergency"] is None'
expect "history: a deploy records by, from, to, tree, gates and the fallback SHA" $?
hist '[(h["action"],h["result"],h["to"]) for h in H[1:3]]==[("deploy","failed","'"$C"'"),("rollback","ok","'"$Bc"'")] and H[2]["gates"]["tree"]=="'"$(g rev-parse "$Bc^{tree}")"'"'
expect "history: a failed deploy and its rollback (with the gates of what it rolled back to)" $?
ev '(d:=[e for e in E if e["event"]=="deploy"][0])["by"]=="test-user" and d["tree"]=="'"$(g rev-parse "$Bc^{tree}")"'" and d["gates"]["passed"] is True'
expect "events: the deploy event carries by, tree and gates too" $?
main_at "$D"
out=$(run check | plain); [[ "$out" == *"✓ live = ${D:0:7}, deployed "*" by test-user, gates recorded"* ]]; expect "check: live is a recorded, gated deploy" $?
out=$(run status); [[ "$out" == *"deploy   live = ${D:0:7}, deployed"* ]]; expect "status shows the deploy record" $?
g checkout -q --detach "$A"
out=$(run check | plain); [[ "$out" == *"✗ live = ${A:0:7} has no deploy record"* ]]; expect "check: a checkout by hand has no deploy record" $?
g checkout -q --detach "$D"
echo e >"$LIVE/backend/server.ts"; g add backend/server.ts; g commit -qm ungated; E=$(g rev-parse HEAD); g checkout -q --detach "$D"
out=$(run deploy "$E" 2>&1); [[ "$out" == *"${E:0:7} is not on origin/main"* ]] && head_is "$D"; expect "deploy refuses a commit not on origin/main" $?
main_at "$E"
out=$(run deploy "$E" 2>&1); [[ "$out" == *"No passing gate record for ${E:0:7}"* ]] && head_is "$D"; expect "deploy refuses a tree with no passing gate record" $?
main_at "$D"
out=$(run deploy "$E" --emergency "hotfix for the outage" 2>&1); rc=$?
[ $rc = 0 ] && head_is "$E" && [[ "$out" == *"EMERGENCY deploy of ${E:0:7} by test-user"* && " $(alerts) " == *" emergency-deploy "* ]] \
  && hist 'H[-1]["emergency"]=="hotfix for the outage" and H[-1]["gates"] is None and H[-1]["to"]=="'"$E"'" and H[-1]["result"]=="ok"'
expect "--emergency deploys without the checks, texts the phone and is recorded" $?
out=$(run check | plain); [[ "$out" == *"✗ live = ${E:0:7}, deployed "*"EMERGENCY (hotfix for the outage)"* ]]; expect "check: an emergency deploy stays ✗" $?
# The private operator console's certificate (GAU-235): shown when there is one, failing 14 days before expiry.
CERTS="$T/home/.local/state/gauss-ops-cert/certificates"; mkdir -p "$CERTS"
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/console.key" -out "$CERTS/ops.example.test.crt" -days 40 -subj /CN=ops.example.test 2>/dev/null
out=$(run check | plain); [[ "$out" == *"✓ console certificate for ops.example.test: "*" days left"* ]]; expect "check: the private console's certificate and its days left" $?
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/console.key" -out "$CERTS/ops.example.test.crt" -days 3 -subj /CN=ops.example.test 2>/dev/null
out=$(run check | plain); [[ "$out" == *"✗ console certificate for ops.example.test: "*" days left (renew it with ops-cert.sh)"* ]]; expect "check: a console certificate within 14 days of expiry fails the check" $?
rm -rf "$T/home/.local/state/gauss-ops-cert" "$T/console.key"
out=$(run deploy "$D" --emergency 2>&1); [ $? = 2 ] && [[ "$out" == *"needs a reason"* ]]; expect "--emergency needs a reason" $?
# check: space-weather data. A stale point is upstream's fault when NOAA's active spacecraft has no plasma
# while a standby one is current; it stays ✗ when NOAA has newer active data than our ingest (GAU: 17 Nov 2026).
now_z() { date -u -v"$1" +%Y-%m-%dT%H:%M:%S; }
rtsw() { # rtsw <active-plasma-age> <standby-age> <active-newest-age>: rows as NOAA lists them (newest first)
  printf '[{"time_tag":"%s","active":true,"source":"SOLAR1","proton_speed":null,"proton_density":null},{"time_tag":"%s","active":false,"source":"ACE","proton_speed":400,"proton_density":5},{"time_tag":"%s","active":true,"source":"SOLAR1","proton_speed":410,"proton_density":6}]' \
    "$(now_z "-${3}M")" "$(now_z "-${2}M")" "$(now_z "-${1}M")"
}
point() { printf '{"quality":{"tier":%s},"observedAt":"%sZ","spacecraft":"SOLAR1"}' "$1" "$(now_z "-$2M")"; }
sw() { run check | plain | grep "space-weather data"; }
out=$(SWLATEST="$(point 2 40)" RTSW="$(rtsw 40 1 1)" sw); [[ "$out" == *"✓ space-weather data: upstream gap (NOAA active spacecraft SOLAR1 has no plasma since "*"Z; standby current)"* ]]
expect "check: a stale point with NOAA's active spacecraft out of plasma is an upstream-gap warning, not ✗" $?
out=$(SWLATEST="$(point 2 40)" RTSW="$(rtsw 5 1 1)" sw); [[ "$out" == *"✗ space-weather data: stale"*"our ingest is behind NOAA"* ]]
expect "check: a stale point while NOAA has newer active plasma stays ✗ (our ingest is behind)" $?
out=$(SWLATEST="$(point 0 1)" sw); [[ "$out" == *"✓ space-weather data: live"* ]] && ! grep -q "^curl" "$T/actions"
expect "check: a live point does not ask NOAA anything" $?
out=$(SWLATEST="$(point 2 40)" RTSW="" sw); [[ "$out" == *"✗ space-weather data: stale"* ]]; expect "check: a stale point with NOAA unreachable stays ✗" $?

# gates record: the five gates on a clean checkout (path with a space), recorded by tree
GW="$T/gates checkout"; git clone -q "$LIVE" "$GW"; git -C "$GW" checkout -q --detach "$D"; mkdir -p "$GW/node_modules"
rec="$WD/gates/$(g rev-parse "$D^{tree}").json"; rm -f "$rec"
out=$(run gates record "$GW" 2>&1); rc=$?
[ $rc = 0 ] && [[ "$out" == *"PASSED ${D:0:7}"*"npm test 5/5, test:ops 99 passed, build ok, quality ok, VCRM 40/40, FMEA 12/14"* ]] \
  && python3 -Ic 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r["passed"] and r["sha"]==sys.argv[2] and r["by"]=="test-user" and r["test_ops"]["go_ok"]==1 else 1)' "$rec" "$D"
expect "gates record: runs the gates (test and build inside verify) and records the counts by tree" $?
[ ! -d "$T/home/.local/state/gauss-gate.lock" ]; expect "gates record releases the shared gate lock" $?
out=$(run gates); [[ "$out" == *"PASSED ${D:0:7}"* ]]; expect "gates lists the records" $?
out=$(GATEFAIL=test run gates record "$GW" 2>&1); rc=$?
[ $rc != 0 ] && [[ "$out" == *"FAILED (test, verify) ${D:0:7}"* ]] && ! python3 -Ic 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["passed"] else 1)' "$rec"
expect "gates record: a failing gate is recorded as FAILED, so the tree can't be deployed" $?
[[ "$out" == *"VCRM 39/40, FMEA 12/14 | failing tests: the broken test; requirements: REQ-X-001"* ]] \
  && python3 -Ic 'import json,sys; f=json.load(open(sys.argv[1]))["failing"]; sys.exit(0 if f["tests"]==["the broken test"] and f["requirements"]==["REQ-X-001"] and f["quality"]==[] else 1)' "$rec"
expect "gates record: a FAILED line names the failing tests and requirements" $?
kept="$WD/gates/logs/$(basename "$rec" .json)"
[[ "$out" == *"Failed gate output: $kept"* ]] && grep -q "VERIFY FAILED" "$kept/verify.log" && [ ! -f "$kept/test:ops.log" ]
expect "gates record: a failed gate's output is kept beside the record, passing gates' is not" $?
out=$(GATEFAIL=quality:full run gates record "$GW" 2>&1)
[[ "$out" == *"FAILED (quality) ${D:0:7}"*"quality failed"*"| failing quality: replay/fetch-archive.ts:110 preserve-caught-error"* ]]
expect "gates record: a failed quality gate names the lint error (file, line, rule)" $?
touch "$GW/stray"; out=$(run gates record "$GW" 2>&1); [[ "$out" == *"uncommitted or untracked"* ]]; expect "gates record refuses a dirty checkout" $?
rm -f "$GW/stray"
# The runner inherits the LaunchAgent's env (live data paths, live origins, launchd PATH): gates must not.
mkdir -p "$T/py"; printf '#!/bin/sh\nexit 0\n' >"$T/py/python3"; chmod +x "$T/py/python3"   # "has numpy"
GATEENV="$T/gate-env"; rm -f "$GATEENV"
out=$(GATELEAK=1 GATEENV="$GATEENV" GATES_PYTHON="$T/py/python3" run gates record "$GW" 2>&1)
[ -s "$GATEENV" ] && ! grep -qE "^(ALLOWED_ORIGINS|MESH_STORE_PATH|COMMERCE_DB_PATH|GAUSS_BEDROCK_DIR|NODE_ENV)=" "$GATEENV" \
  && grep -qF ":$T/py:" "$GATEENV"
expect "gates record: gates run without the services' env (live data paths, origins) and with a python3 that has numpy" $?

# gates enqueue/run: a session hands its gate run to the queue and can be archived; one runner
# works through it oldest first under claude-heavy, skipping trees that already passed.
# claude-heavy stub: takes the shared gate lock like the real one (owner = its pid), then runs the command.
printf '%s\n' '#!/bin/bash' 'echo "heavy $*" >>"$ACTIONS"; { pwd -P 2>/dev/null || echo GONE; } >>"$ACTIONS.cwd"; [ -n "${HEAVYGIVEUP:-}" ] && exit 75' \
  'while [ $# -gt 0 ] && [ "$1" != -- ]; do shift; done; [ $# -gt 0 ] && shift' \
  'L="$HOME/.local/state/gauss-gate.lock"; mkdir -p "${L%/*}"; mkdir "$L" || exit 9; echo "$$ now test" >"$L/owner"' \
  '"$@"; rc=$?; rm -rf "$L"; exit $rc' >"$T/home/.local/bin/claude-heavy"
chmod +x "$T/home/.local/bin/claude-heavy"
GQ="$WD/gates/queue"; GR="$WD/gates/results.log"; GCO="$T/live-checkout.worktrees/gates"
tree_of() { g rev-parse "$1^{tree}"; }
rm -f "$WD/gates/$(tree_of "$D").json" "$WD/gates/$(tree_of "$E").json" "$WD/gates/$(tree_of "$C").json"
SW="$T/session worktree"; g worktree add -q --detach "$SW" "$D" # a session's worktree of the same repo
out=$(run gates enqueue "$SW" 2>&1); [[ "$out" == *"Queued ${D:0:7}"* ]] && [ "$(ls "$GQ" | grep -c '\.req$')" = 1 ]
expect "gates enqueue: a clean checkout is queued by tree" $?
out=$(cd "$LIVE" && run gates enqueue "$D" 2>&1); [[ "$out" == *"Already queued: tree $(tree_of "$D" | cut -c1-7)"* ]] && [ "$(ls "$GQ" | grep -c '\.req$')" = 1 ]
expect "gates enqueue: the same tree is queued once" $?
out=$(cd "$LIVE" && run gates enqueue "$A" 2>&1); [[ "$out" == *"Already passed: ${A:0:7}"* ]] && [ "$(ls "$GQ" | grep -c '\.req$')" = 1 ] \
  && [ "$(tail -1 "$GR" | cut -d' ' -f2,4)" = "$A SKIPPED" ]
expect "gates enqueue: a tree with a passing record is skipped, with a result line" $?
(cd "$LIVE" && run gates enqueue "$E" >/dev/null 2>&1 && run gates enqueue "$C" >/dev/null 2>&1)
out=$(cd "$LIVE" && run gates result "$E"); [ $? = 3 ] && [[ "$out" == "QUEUED $(tree_of "$E" | cut -c1-7)"* ]]
expect "gates result: a queued request says QUEUED (exit 3)" $?
gated "$C" # C passes by hand while queued: the runner must not run it again
# Started from a folder that is then removed (4 Nov: a session's temporary worktree): the runner kept it as
# its working directory and every git call failed ("getcwd: cannot access parent directories").
gone="$T/gone-cwd"; mkdir -p "$gone"; rm -f "$T/actions.cwd"
out=$(cd "$gone" && rmdir "$gone" && run gates run 2>&1); rc=$?
[ $rc = 0 ] && [ "$(cut -d' ' -f2,4 "$GR" | tail -3 | tr '\n' ';')" = "$D PASSED;$E PASSED;$C SKIPPED;" ] && [ -z "$(ls "$GQ")" ]
expect "gates run: requests run oldest first, one at a time; a tree that passed meanwhile is skipped" $?
[ -s "$T/actions.cwd" ] && ! grep -q GONE "$T/actions.cwd"; expect "gates run: a removed starting folder doesn't break it (it works from the gates folder)" $?
[ "$(grep -c '^heavy --wait [0-9]* --name gates --label gate queue' "$T/actions")" = 2 ] && [ "$(grep -c '^npm ci' "$T/actions")" = 1 ]
expect "gates run: each run is admitted by claude-heavy; one install for runs sharing package-lock.json" $?
python3 -Ic 'import json,sys; sys.exit(0 if all(json.load(open(f))["passed"] and json.load(open(f))["by"]=="test-user" for f in sys.argv[1:]) else 1)' \
  "$WD/gates/$(tree_of "$D").json" "$WD/gates/$(tree_of "$E").json" && [ "$(git -C "$GCO" rev-parse HEAD)" = "$E" ]
expect "gates run: results are recorded by tree exactly as gates record does, in the queue's own checkout" $?
[ ! -d "$T/home/.local/state/gauss-gate.lock" ] && [ ! -d "$WD/gates/runner" ]
expect "gates run: no self-deadlock on claude-heavy's gate lock; runner and gate locks released" $?
out=$(cd "$LIVE" && run gates result "$E"); [ $? = 0 ] && [[ "$out" == *" $E $(tree_of "$E") PASSED ${E:0:7}"* ]]
expect "gates result: the one-line result for a commit (exit 0 passed)" $?
out=$(run gates result "${E:0:9}"); [ $? = 0 ]; expect "gates result: a SHA prefix works without the checkout" $?
g checkout -q --detach "$E"; echo f >"$LIVE/backend/server.ts"; g commit -qam queued-f; F=$(g rev-parse HEAD); g checkout -q --detach "$E"
(cd "$LIVE" && run gates enqueue "$F" >/dev/null 2>&1)
out=$(HEAVYGIVEUP=1 run gates run --once 2>&1); [[ "$out" == *"still waiting"* ]] && [ "$(ls "$GQ" | grep -c '\.req$')" = 1 ] \
  && [ "$(tail -1 "$GR" | cut -d' ' -f2)" != "$F" ]; expect "gates run: when claude-heavy gives up, the request stays queued" $?
GAUSS_GATES_EXPIRE_H=0 run gates run >/dev/null 2>&1
[ "$(tail -1 "$GR" | cut -d' ' -f2,4)" = "$F EXPIRED" ] && [ -z "$(ls "$GQ")" ]; expect "gates run: a request waiting past GAUSS_GATES_EXPIRE_H expires" $?
# 5 Nov 2026: an install timed out on the phone hotspot and the request was dropped as ERROR.
g checkout -q --detach "$E"; echo net >>"$LIVE/package-lock.json"; g commit -qam lock-net; N=$(g rev-parse HEAD); g checkout -q --detach "$E"
(cd "$LIVE" && run gates enqueue "$N" >/dev/null 2>&1)
out=$(NPMNET=1 run gates run --once 2>&1); [[ "$out" == *"lost the network"* ]] && grep -q "sha=$N" "$GQ"/*.req \
  && ! grep -q " $N " "$GR"; expect "gates run: an install that loses the network keeps the request queued, with no result line" $?
rm -f "$(grep -l "sha=$N" "$GQ"/*.req)"
# Gatebox (GAU-223): the Oracle VM screens each request first over the tailnet. GBRC is the stub's
# exit code; "say" adds the "gates rc=N in S s on <sha>" line gauss-gate-run prints after the gates ran
# ("anon" leaves the commit out of it, as an older gauss-gate-run would).
stub ssh 'echo "ssh $*" >>"$ACTIONS"; a=${@: -1}; case "$GBRC" in hang) sleep 5; exit 0 ;; say*) r=${GBRC#say}; [ -f "$HOME/gatebox-out" ] && cat "$HOME/gatebox-out"; echo "gates rc=$r in 90 s on ${a##* }"; exit "$r" ;; anon*) r=${GBRC#anon}; echo "gates rc=$r in 90 s"; exit "$r" ;; *) echo "ssh: connect to host gatebox port 22: Operation timed out" >&2; exit "${GBRC:-255}" ;; esac'
: >"$T/gatebox-key"
g checkout -q --detach "$E"; echo gb1 >"$LIVE/backend/server.ts"; g commit -qam gb1; GB1=$(g rev-parse HEAD); g checkout -q --detach "$E"
(cd "$LIVE" && run gates enqueue "$GB1" >/dev/null 2>&1)
out=$(GAUSS_GATEBOX=gatebox GBRC=say1 run gates run 2>&1)
[ "$(tail -1 "$GR" | cut -d' ' -f2,4-7)" = "$GB1 FAILED on gatebox gatebox" ] && [ -z "$(ls "$GQ")" ] && ! grep -q '^heavy ' "$T/actions" \
  && grep -q "^ssh .*-o BatchMode=yes .*gate@gatebox Pallas117/Constellation $GB1\$" "$T/actions" && [ ! -f "$WD/gates/$(tree_of "$GB1").json" ]
expect "gates run: a commit the gatebox fails is FAILED without a local run, and no deploy record is written" $?
# gates why: a gatebox failure is named in the result line, and diagnosed with the known cause and its fix
printf '%s\n' 'ok 1' '✖ failing tests:' '' '✖ telemetry_descriptor.json is the current .proto (56.69ms)' >"$T/home/gatebox-out"
(cd "$LIVE" && run gates enqueue "$GB1" >/dev/null 2>&1); GAUSS_GATEBOX=gatebox GBRC=say1 run gates run >/dev/null 2>&1
[[ "$(tail -1 "$GR")" == *"; failing tests: telemetry_descriptor.json is the current .proto; log "* ]]; expect "gates run: a gatebox failure names the failing test in its result line" $?
out=$(run gates why "${GB1:0:9}"); rc=$?
[ $rc = 0 ] && [[ "$out" == "Why ${GB1:0:7} failed"* && "$out" == *"cause: telemetry.proto changed without its descriptor"* && "$out" == *"fix:   regenerate it"* \
  && "$out" != *"cause: a failing test"* && "$out" == *"Before re-queueing: npm run -s check:changed"* ]]
expect "gates why: a known failure gets its cause and fix, without the general advice" $?
printf '%s\n' '✖ failing tests:' '' '✖ something nobody has met (3ms)' >"$T/home/gatebox-out"
(cd "$LIVE" && run gates enqueue "$GB1" >/dev/null 2>&1); GAUSS_GATEBOX=gatebox GBRC=say1 run gates run >/dev/null 2>&1
out=$(run gates why "$GB1")
[[ "$out" == *"failing tests: something nobody has met"* && "$out" == *"cause: a failing test"* ]]; expect "gates why: an unknown failing test is named, with the general advice" $?
# 18 Nov, PR #321: a PASSING descriptor test in the log was blamed; and the lint errors were not named
printf '%s\n' '✔ telemetry_descriptor.json is the current .proto (9.1ms)' '' '/home/gate/work.x/frontend/src/components/scene/CameraTween.tsx' '  22:3  error  Error: Cannot access refs during render' '' '✖ 1 problem (1 error, 0 warnings)' >"$T/home/gatebox-out"
(cd "$LIVE" && run gates enqueue "$GB1" >/dev/null 2>&1); GAUSS_GATEBOX=gatebox GBRC=say1 run gates run >/dev/null 2>&1
out=$(run gates why "$GB1")
[[ "$out" == *"lint errors: scene/CameraTween.tsx:22"* && "$out" == *"cause: a lint error"* && "$out" != *"telemetry.proto changed"* ]]
expect "gates why: lint errors are named by file and line, and a passing test is not blamed" $?
# 18 Nov, PR #309: the device-auth timestamps test failed when two proofs shared a nonce in the same millisecond
printf '%s\n' '✖ failing tests:' '' "✖ timestamps: only computeProof's epoch-ms format, within the TTL (GAU-98) (4.2ms)" >"$T/home/gatebox-out"
(cd "$LIVE" && run gates enqueue "$GB1" >/dev/null 2>&1); GAUSS_GATEBOX=gatebox GBRC=say1 run gates run >/dev/null 2>&1
out=$(run gates why "$GB1")
[[ "$out" == *"cause: the device-auth timestamps test signs with a shared nonce"* && "$out" == *"PR #341"* && "$out" != *"cause: a failing test"* ]]
expect "gates why: the device-auth shared-nonce flake is named with its PR" $?
# 18 Nov, PR #315: Argo Go timing tests failed on a throttled battery run (fixed by PR #340)
printf '%s\n' '✖ Argo Go tests (exit 1)' >"$T/home/gatebox-out"
(cd "$LIVE" && run gates enqueue "$GB1" >/dev/null 2>&1); GAUSS_GATEBOX=gatebox GBRC=say1 run gates run >/dev/null 2>&1
out=$(run gates why "$GB1")
[[ "$out" == *"cause: an Argo Go test failed inside verify"* && "$out" == *"PR #340"* ]]; expect "gates why: the Argo timing flake names PR #340" $?
rm -f "$T/home/gatebox-out"
(cd "$LIVE" && run gates enqueue "$GB1" >/dev/null 2>&1); GAUSS_GATEBOX=gatebox GBRC=say1 run gates run >/dev/null 2>&1
out=$(run gates why "$GB1")
[[ "$out" == *"cause: none of the known causes match"* && "$out" == *"add a row to GATES_CAUSES"* ]]; expect "gates why: no match says so and asks for a new row" $?
out=$(run gates why 0000000); rc=$?
[ $rc = 3 ] && [[ "$out" == "No failed gate on record for 0000000"* ]]; expect "gates why: a commit with no failure exits 3" $?
(cd "$LIVE" && run gates enqueue "$GB1" >/dev/null 2>&1)
out=$(GAUSS_GATEBOX=gatebox GBRC=say0 run gates run 2>&1)
[[ "$out" == *"gatebox passed ${GB1:0:7}"* ]] && grep -q '^heavy --wait' "$T/actions" && [ "$(tail -1 "$GR" | cut -d' ' -f2,4)" = "$GB1 PASSED" ]
expect "gates run: a commit the gatebox passes still runs the full gates here for its record" $?
g checkout -q --detach "$E"; echo gb2 >"$LIVE/backend/server.ts"; g commit -qam gb2; GB2=$(g rev-parse HEAD); g checkout -q --detach "$E"
(cd "$LIVE" && run gates enqueue "$GB2" >/dev/null 2>&1)
out=$(GAUSS_GATEBOX=gatebox GBRC=255 run gates run 2>&1)
[[ "$out" == *"gatebox could not screen ${GB2:0:7} (exit 255"* ]] && grep -q '^heavy --wait' "$T/actions" && [ "$(tail -1 "$GR" | cut -d' ' -f2,4)" = "$GB2 PASSED" ]
expect "gates run: an unreachable gatebox falls back to the gates here" $?
g checkout -q --detach "$E"; echo gb3 >"$LIVE/backend/server.ts"; g commit -qam gb3; GB3=$(g rev-parse HEAD); g checkout -q --detach "$E"
(cd "$LIVE" && run gates enqueue "$GB3" >/dev/null 2>&1)
out=$(GAUSS_GATEBOX=gatebox GBRC=1 run gates run 2>&1)
[ "$(tail -1 "$GR" | cut -d' ' -f2,4)" = "$GB3 PASSED" ] && grep -q '^heavy --wait' "$T/actions"
expect "gates run: a gatebox exit without its result line is not a failure of the commit" $?
g checkout -q --detach "$E"; echo gb5 >"$LIVE/backend/server.ts"; g commit -qam gb5; GB5=$(g rev-parse HEAD); g checkout -q --detach "$E"
(cd "$LIVE" && run gates enqueue "$GB5" >/dev/null 2>&1)
out=$(GAUSS_GATEBOX=gatebox GAUSS_GATEBOX_TIMEOUT_S=1 GBRC=hang run gates run 2>&1)
[[ "$out" == *"gatebox could not screen ${GB5:0:7} (exit 142: no answer in 1 s)"* ]] && grep -q '^heavy --wait' "$T/actions" \
  && [ "$(tail -1 "$GR" | cut -d' ' -f2,4)" = "$GB5 PASSED" ]
expect "gates run: a gatebox screen that hangs past its time limit is cut off and gated here (18 Nov hang)" $?
g checkout -q --detach "$E"; echo gb4 >"$LIVE/backend/server.ts"; g commit -qam gb4; GB4=$(g rev-parse HEAD); g checkout -q --detach "$E"
(cd "$LIVE" && run gates enqueue "$GB4" >/dev/null 2>&1)
out=$(GAUSS_GATEBOX='-oProxyCommand=x' GBRC=say1 run gates run 2>&1)
[[ "$out" == *"gatebox: not a host name"* ]] && ! grep -q '^ssh ' "$T/actions" && [ "$(tail -1 "$GR" | cut -d' ' -f2,4)" = "$GB4 PASSED" ]
expect "gates run: a gatebox setting that is not a host name is never passed to ssh" $?
out=$(GAUSS_GATEBOX=gatebox run gates result status 2>&1); [[ "$out" == *"gatebox: gatebox screens each request first"* ]]
expect "gates result status: names the gatebox when one is set" $?
# Several gatebox addresses (19 Nov: Talos dropped off its fixed LAN IP and every gate fell back to this Mac).
newgb() { g checkout -q --detach "$E"; echo "$1" >"$LIVE/backend/server.ts"; g commit -qam "$1"; g rev-parse HEAD; g checkout -q --detach "$E"; }
stub gbprobe 'echo "probe $1" >>"$ACTIONS"; [ "$1" = talos.local ]'
GB6=$(newgb gb6); (cd "$LIVE" && run gates enqueue "$GB6" >/dev/null 2>&1)
out=$(GAUSS_GATEBOX="192.0.2.9 talos.local" GAUSS_GATEBOX_PROBE="$T/bin/gbprobe" GBRC=say1 run gates run 2>&1)
grep -q '^probe 192.0.2.9$' "$T/actions" && grep -q "^ssh .*-o HostKeyAlias=192.0.2.9 gate@talos.local Pallas117/Constellation $GB6\$" "$T/actions" \
  && [ "$(tail -1 "$GR" | cut -d' ' -f2,4-7)" = "$GB6 FAILED on gatebox talos.local" ]
expect "gates run: the first gatebox address that answers is used, and its key is checked against the first address's" $?
GB7=$(newgb gb7); (cd "$LIVE" && run gates enqueue "$GB7" >/dev/null 2>&1)
out=$(GAUSS_GATEBOX='talos.local -oProxyCommand=x' GBRC=say1 run gates run 2>&1)
[[ "$out" == *"gatebox: not a host name: -oProxyCommand=x"* ]] && ! grep -q '^ssh ' "$T/actions" && [ "$(tail -1 "$GR" | cut -d' ' -f2,4)" = "$GB7 PASSED" ]
expect "gates run: one gatebox address that is not a host name keeps the whole list away from ssh" $?
# A gatebox that comes back within the wait is used instead of the local gates.
stub gbslow 'n=$(cat "$HOME/probes" 2>/dev/null || echo 0); echo $((n + 1)) >"$HOME/probes"; [ "$n" -ge 2 ]'
rm -f "$T/home/probes" "$WD/gates/gatebox.down"
GB8=$(newgb gb8); (cd "$LIVE" && run gates enqueue "$GB8" >/dev/null 2>&1)
out=$(GAUSS_GATEBOX=gatebox GAUSS_GATEBOX_PROBE="$T/bin/gbslow" GAUSS_GATEBOX_WAIT_S=30 GAUSS_GATEBOX_POLL_S=1 GBRC=say1 run gates run 2>&1)
[[ "$out" == *"gatebox (gatebox) not answering; waiting up to 1 min"* ]] && [[ "$out" == *"gatebox answered at gatebox"* ]] \
  && grep -q "gate@gatebox Pallas117/Constellation $GB8\$" "$T/actions" && [ ! -f "$WD/gates/gatebox.down" ] \
  && [ "$(tail -1 "$GR" | cut -d' ' -f2,4)" = "$GB8 FAILED" ]
expect "gates run: a gatebox that answers again within the wait screens the commit (no local run)" $?
# One that stays off is waited for once; the next request gates here at once.
stub gbdown 'exit 1'
rm -f "$WD/gates/gatebox.down"
GB9=$(newgb gb9); (cd "$LIVE" && run gates enqueue "$GB9" >/dev/null 2>&1)
out=$(GAUSS_GATEBOX=gatebox GAUSS_GATEBOX_PROBE="$T/bin/gbdown" GAUSS_GATEBOX_WAIT_S=2 GAUSS_GATEBOX_POLL_S=1 run gates run 2>&1)
[[ "$out" == *"did not answer in 1 min; gating here"* ]] && ! grep -q '^ssh ' "$T/actions" && [ -f "$WD/gates/gatebox.down" ] \
  && [ "$(tail -1 "$GR" | cut -d' ' -f2,4)" = "$GB9 PASSED" ]
expect "gates run: a gatebox that stays off is waited for once, then the gates run here" $?
GB10=$(newgb gb10); (cd "$LIVE" && run gates enqueue "$GB10" >/dev/null 2>&1)
out=$(GAUSS_GATEBOX=gatebox GAUSS_GATEBOX_PROBE="$T/bin/gbdown" GAUSS_GATEBOX_WAIT_S=2 GAUSS_GATEBOX_POLL_S=1 run gates run 2>&1)
[[ "$out" == *"gatebox (gatebox) has not answered since"* ]] && [[ "$out" != *"waiting up to"* ]] && [ "$(tail -1 "$GR" | cut -d' ' -f2,4)" = "$GB10 PASSED" ]
expect "gates run: during the same outage the next request does not wait again" $?
rm -f "$WD/gates/gatebox.down"
g checkout -q --detach "$E"; echo h1 >"$LIVE/backend/server.ts"; g commit -qam h1; H1=$(g rev-parse HEAD)
echo h2 >"$LIVE/backend/server.ts"; g commit -qam h2; H2=$(g rev-parse HEAD); g checkout -q --detach "$E"
(cd "$LIVE" && run gates enqueue "$H1" >/dev/null 2>&1); out=$(cd "$LIVE" && run gates enqueue "$H2" 2>&1)
[[ "$out" == *"Superseded ${H1:0:7}"* ]] && [ "$(ls "$GQ" | grep -c '\.req$')" = 1 ] && grep -q "sha=$H2" "$GQ"/*.req
expect "gates enqueue: a new head replaces its branch's older queued head" $?
rm -f "$GQ"/*.req
g update-ref refs/remotes/origin/main "$H1"
(cd "$LIVE" && run gates enqueue "$H1" >/dev/null 2>&1); (cd "$LIVE" && run gates enqueue "$H2" >/dev/null 2>&1)
[ "$(ls "$GQ" | grep -c '\.req$')" = 2 ]; expect "gates enqueue: a queued commit on origin/main is never superseded" $?
g update-ref -d refs/remotes/origin/main
rm -f "$GQ"/*.req
# Stacked PRs (2026-11-02, #210 on #158): the lower head is still its branch's head and must pass on its own.
g update-ref refs/heads/stack-low "$H1"; g update-ref refs/heads/stack-high "$H2"
(cd "$LIVE" && run gates enqueue "$H1" >/dev/null 2>&1); out=$(cd "$LIVE" && run gates enqueue "$H2" 2>&1)
[[ "$out" == *"Kept ${H1:0:7}: still the head of heads/stack-low"* ]] && [ "$(ls "$GQ" | grep -c '\.req$')" = 2 ]
expect "gates enqueue: a stacked PR's queued head stays queued when the PR above it is queued" $?
rm -f "$GQ"/*.req; g update-ref -d refs/heads/stack-low; g update-ref refs/remotes/origin/stack-low "$H1"
(cd "$LIVE" && run gates enqueue "$H1" >/dev/null 2>&1); (cd "$LIVE" && run gates enqueue "$H2" >/dev/null 2>&1)
[ "$(ls "$GQ" | grep -c '\.req$')" = 2 ]; expect "gates enqueue: a head only on origin (its worktree gone) still counts as a branch head" $?
rm -f "$GQ"/*.req; g update-ref -d refs/remotes/origin/stack-low; g update-ref -d refs/heads/stack-high
g update-ref refs/heads/topic "$H1"; g update-ref refs/remotes/origin/topic "$H1"
(cd "$LIVE" && run gates enqueue "$H1" >/dev/null 2>&1)
g update-ref refs/heads/topic "$H2" # the branch moved on here; origin still has the old head (not pushed yet)
out=$(cd "$LIVE" && run gates enqueue "$H2" 2>&1)
[[ "$out" == *"Superseded ${H1:0:7}"* ]] && [ "$(ls "$GQ" | grep -c '\.req$')" = 1 ] && grep -q "sha=$H2" "$GQ"/*.req
expect "gates enqueue: a branch whose head moved still supersedes its old queued head, pushed or not" $?
g update-ref -d refs/heads/topic; g update-ref -d refs/remotes/origin/topic
rm -f "$GQ"/*.req
sleep 30 & LIVE_RUNNER=$!; mkdir -p "$WD/gates/runner"; echo "$LIVE_RUNNER" >"$WD/gates/runner/pid"; echo old >"$WD/gates/runner.sh"
out=$(cd "$LIVE" && run gates enqueue "$H1" 2>&1); kill "$LIVE_RUNNER" 2>/dev/null; wait "$LIVE_RUNNER" 2>/dev/null
[[ "$out" == *"working (pid $LIVE_RUNNER)"* ]] && cmp -s "$SCRIPT" "$WD/gates/runner.sh"
expect "gates enqueue: refreshes the runner's copy even while a runner is working" $?
rm -rf "$WD/gates/runner" "$GQ"/*.req
# The runner's copy only moves forward (2026-11-03: an older branch's enqueue replaced the merge
# train's runner). A repo whose history carries the script: main M0, the runner's source N1, C1 on
# top of it, and an older branch O1 beside them; a checkout of each runs its own copy.
RR="$T/runner-repo"; rr() { git -C "$RR" -c user.email=t@t -c user.name=t "$@"; }
rcommit() { cp "$SCRIPT" "$RR/scripts/ops/gauss-services.sh"; echo "# $1" >>"$RR/scripts/ops/gauss-services.sh"; rr add -A; rr commit -qm "$1"; rr rev-parse HEAD; }
git init -q "$RR"; mkdir -p "$RR/scripts/ops"
M0=$(rcommit m0); N1=$(rcommit n1); C1=$(rcommit c1); rr checkout -q --detach "$M0"; O1=$(rcommit o1); rr update-ref refs/remotes/origin/main "$M0"
for x in M0 N1 C1 O1; do rr worktree add -q --detach "$T/rr-$x" "${!x}"; done
runner_from() { (cd "$LIVE" && SCRIPT="$T/rr-$1/scripts/ops/gauss-services.sh" run gates enqueue "$H1" 2>&1); }
runs() { [ "$(git -C "$T/rr-$1" show HEAD:scripts/ops/gauss-services.sh | shasum)" = "$(shasum <"$WD/gates/runner.sh")" ] && grep -qx "sha=${!1}" "$WD/gates/runner.src"; }
rm -f "$WD/gates/runner.src"; echo old >"$WD/gates/runner.sh"
runner_from N1 >/dev/null; runs N1; expect "gates runner: with no runner.src, an enqueue refreshes the copy as before and records its commit" $?
out=$(runner_from O1); runs N1 && [[ "$out" == *"Runner kept: it runs ${N1:0:7} and this checkout (${O1:0:7}) doesn't contain it."* ]]
expect "gates runner: an older branch's enqueue keeps a newer runner, and says why" $?
out=$(runner_from C1); runs C1 && [[ "$out" != *"Runner kept"* ]]; expect "gates runner: a checkout that contains the runner's commit refreshes it" $?
runner_from M0 >/dev/null; runs M0; expect "gates runner: origin/main's script always refreshes it" $?
runner_from C1 >/dev/null; echo "# edited" >>"$T/rr-C1/scripts/ops/gauss-services.sh"
out=$(runner_from C1); runs C1 && [[ "$out" == *"Runner kept: it runs ${C1:0:7} and this script isn't committed as is."* ]]
expect "gates runner: a script with uncommitted changes doesn't replace a recorded runner" $?
git -C "$T/rr-C1" checkout -q -- scripts/ops/gauss-services.sh
echo "# by hand" >>"$WD/gates/runner.sh"; runner_from O1 >/dev/null; runs O1
expect "gates runner: a runner.sh changed without runner.src (by hand, or an older script) refreshes as before" $?
out=$(run gates result status); [[ "$out" == *"runner code: ${O1:0:7} (from $T/rr-O1/scripts/ops)"* ]]; expect "gates result status: names the commit the runner's code came from" $?
rm -f "$GQ"/*.req
n=$(wc -l <"$GR"); out=$(run gates run-one "$GQ/withdrawn.req" 2>&1); [ $? = 0 ] && [[ "$out" == *"withdrawn"* ]] && [ "$(wc -l <"$GR")" = "$n" ]
expect "gates run-one: a request withdrawn while waiting is skipped, with no result line" $?
touch "$SW/stray"; out=$(run gates enqueue "$SW" 2>&1); [ $? != 0 ] && [[ "$out" == *"uncommitted or untracked"* ]]; expect "gates enqueue refuses a dirty checkout" $?
rm -f "$SW/stray"
out=$(run gates result status); [[ "$out" == *"runner: not running"*"queue: empty"* ]]; expect "gates result status: runner, queue and recent results" $?

# pipefail lint (2026-11-02): under `set -o pipefail` a reader that quits early (grep -q, head -1,
# awk ... exit) can kill the writer with SIGPIPE, making the pipeline fail at random: alive-beacon
# died hourly for 3 days this way. Use grep -c >/dev/null, grep -m1, sed '...;q' or awk without exit.
early=$(cd "$(dirname "$SCRIPT")/../.." && for f in $(grep -rl 'pipefail' scripts --include='*.sh'); do
  grep -nE '\|[[:space:]]*grep -q|\|[[:space:]]*head -(n[[:space:]]*)?1([^0-9]|$)|\|[[:space:]]*awk [^|]*[{;][[:space:]]*exit[[:space:]]*[;}]' "$f" | sed "s|^|$f:|"
done)
[ -z "$early" ]; expect "pipefail scripts have no early-quitting pipe readers${early:+: $early}" $?
# Merge train (2026-11-03): a request queued with --pr merges main in before its run and merges the
# PR after a pass, under the standing approval's rules. GitHub is a stub that reads PR heads from a
# real bare origin; the runner's merges and pushes are real git.
ORIGIN="$T/origin.git"; git init -q --bare "$ORIGIN"; g remote add origin "$ORIGIN"
git config --file "$T/home/.gitconfig" user.name train-test; git config --file "$T/home/.gitconfig" user.email t@t
GHD="$T/gh"; mkdir -p "$GHD"
cat >"$T/bin/gh" <<GHSTUB
#!/bin/bash
# pr<N> holds "state branch base draft merge-state"; the head is whatever origin has for the branch
case "\$1 \$2" in
  "pr view") read -r st br base dr ms <"$GHD/pr\$3" || exit 1
    echo "\$st \$(git --git-dir="$ORIGIN" rev-parse "refs/heads/\$br") \$br \$base \$dr \$ms" ;;
  "pr merge") echo "gh merge \$3 \${@: -1}" >>"\$ACTIONS"; exit \${GHMERGEFAIL:-0} ;;
  "pr list") base=\$(printf '%s\n' "\$@" | grep -A1 -x -- --base | tail -1)
    if [ -n "\$base" ]; then cat "$GHD/children-\$base" 2>/dev/null; else cat "$GHD/open" 2>/dev/null; fi ;;
  "pr edit") echo "gh retarget \$3" >>"\$ACTIONS" ;;
  *) exit 1 ;;
esac
GHSTUB
chmod +x "$T/bin/gh"
prevhead=$(g rev-parse HEAD)
tc() { g checkout -q --detach "$1"; shift; while [ $# -gt 1 ]; do mkdir -p "$LIVE/$(dirname "$1")"; echo "$2" >"$LIVE/$1"; g add "$1"; shift 2; done; g commit -qm train; g rev-parse HEAD; }
M1=$(tc "$E" main.txt main-1)
P1=$(tc "$E" feature.txt f1)                       # behind main, merges cleanly
P2=$(tc "$M1" backend/auth-extra.ts x)             # contains main, touches auth
P3=$(tc "$E" main.txt mine)                        # conflicts with main
P4=$(tc "$M1" feature4.txt f4)                     # its PR has moved on to P4b
P4b=$(tc "$P4" feature4.txt f4b)
g push -q origin "$M1:refs/heads/main" "$P1:refs/heads/train" "$P2:refs/heads/auth-pr" "$P3:refs/heads/clash" "$P4b:refs/heads/moved" && g fetch -q origin
echo "OPEN train main false CLEAN" >"$GHD/pr7"; echo 8 >"$GHD/children-train"
echo "OPEN auth-pr main false CLEAN" >"$GHD/pr9"
echo "OPEN clash main false CLEAN" >"$GHD/pr11"
echo "OPEN moved main false CLEAN" >"$GHD/pr12"
out=$(cd "$LIVE" && run gates enqueue "$P1" --pr x 2>&1); [ $? = 2 ] && [[ "$out" == *"--pr <number>"* ]] && [ -z "$(ls "$GQ")" ]
expect "train: enqueue --pr needs a PR number" $?
for x in "$P1 7" "$P2 9" "$P3 11" "$P4 12"; do set -- $x; (cd "$LIVE" && run gates enqueue "$1" --pr "$2" >/dev/null 2>&1); done
grep -qx "pr=7" "$GQ"/*-"$(tree_of "$P1")".req; expect "train: enqueue --pr records the PR in the request" $?
out=$(run gates run 2>&1)
N1=$(git --git-dir="$ORIGIN" rev-parse refs/heads/train)
[ "$N1" != "$P1" ] && git --git-dir="$ORIGIN" merge-base --is-ancestor "$M1" "$N1" && [ "$(git --git-dir="$ORIGIN" rev-parse "$N1^1")" = "$P1" ] \
  && grep -q "^[^ ]* $P1 [^ ]* MOVED merged main into PR #7" "$GR" && grep -q "^[^ ]* $N1 [^ ]* PASSED" "$GR"
expect "train: a head behind main gets main merged in (pushed, no force) and the merge is what gets gated" $?
grep -qx "gh merge 7 $N1" "$T/actions" && grep -q "^[^ ]* $N1 [^ ]* MERGED PR #7" "$GR" && grep -qx "gh retarget 8" "$T/actions"
expect "train: after a pass the PR is merged on that exact head, and PRs stacked on it move to main" $?
grep -q "^[^ ]* $P2 [^ ]* PASSED" "$GR" && grep -q "^[^ ]* $P2 [^ ]* HELD passed, not merged: touches backend/auth-extra.ts" "$GR" && ! grep -q "gh merge 9" "$T/actions"
expect "train: a PR touching auth passes but waits for Josh" $?
grep -q "^[^ ]* $P3 [^ ]* CONFLICT PR #11" "$GR" && ! grep -q " $P3 [^ ]* PASSED" "$GR" && [ "$(git --git-dir="$ORIGIN" rev-parse refs/heads/clash)" = "$P3" ] \
  && [[ " $(alerts) " == *" train-11 "* ]]
expect "train: a conflict with main is left alone, not gated, and texted" $?
grep -q "^[^ ]* $P4 [^ ]* SKIPPED PR #12 moved on to ${P4b:0:7}" "$GR" && ! grep -q " $P4 [^ ]* PASSED" "$GR"
expect "train: a request whose PR moved on is dropped without a run" $?
out=$(cd "$LIVE" && run gates result "$N1"); [ $? = 0 ] && [[ "$out" == *MERGED* ]]; expect "train: gates result counts a merged run as passed" $?
[ -z "$(ls "$GQ")" ] && [ -z "$(g worktree list | grep gauss-train)" ]; expect "train: queue drained, scratch worktrees removed" $?
echo "OPEN train main true CLEAN" >"$GHD/pr13"; git --git-dir="$ORIGIN" update-ref refs/heads/train "$N1"
P5=$(tc "$N1" f5.txt x); g push -q origin "$P5:refs/heads/train"; echo "OPEN train main true CLEAN" >"$GHD/pr13"
(cd "$LIVE" && run gates enqueue "$P5" --pr 13 >/dev/null 2>&1); run gates run >/dev/null 2>&1
grep -q "^[^ ]* $P5 [^ ]* HELD passed, not merged: draft" "$GR"; expect "train: a draft passes but isn't merged" $?
P6=$(tc "$N1" f6.txt y); printf 'sha=%s\ntree=%s\nrepo=%s\nqueued=%s\nby=t\npr=7\n' "$P6" "$(tree_of "$P6")" "$(g rev-parse --absolute-git-dir)" "$(date +%s)" \
  >"$GQ/1.000000-$(tree_of "$P1").req" # what train_sync leaves: moved to P6, still named after P1's tree
out=$(cd "$LIVE" && run gates result "$P6" 2>&1); rc=$?
[ $rc = 3 ] && [[ "$out" == QUEUED* ]] && [[ "$(cd "$LIVE" && run gates enqueue "$P6" 2>&1)" == *"Already queued"* ]] && [ "$(ls "$GQ" | wc -l | tr -d ' ')" = 1 ]
expect "train: a request moved to the merged head is found by its tree (gates result says queued; no second request)" $?
rm -f "$GQ"/*.req
# 4 Nov: a train head that already passed (held as a draft) and is then marked ready merges without a
# second run when it still contains main; when main has moved past it, it is queued to sync and re-gate.
: >"$T/actions"; echo "OPEN train main false CLEAN" >"$GHD/pr13"; git --git-dir="$ORIGIN" update-ref refs/heads/train "$P5"
out=$(cd "$LIVE" && run gates enqueue "$P5" --pr 13 2>&1)
grep -qx "gh merge 13 $P5" "$T/actions" && [[ "$out" == *"Merged PR #13"* ]] && [ -z "$(ls "$GQ")" ]
expect "train: an already-passed head that contains main is merged on re-enqueue, without a second run" $?
M2=$(tc "$M1" main.txt main-2); g push -q origin "$M2:refs/heads/main" && g fetch -q origin; : >"$T/actions"
out=$(cd "$LIVE" && run gates enqueue "$P5" --pr 13 2>&1)
[[ "$out" == *"main has moved past it: queueing"* ]] && [ "$(ls "$GQ" | grep -c '\.req$')" = 1 ] && ! grep -q "gh merge" "$T/actions"
expect "train: an already-passed head that main moved past is queued to sync, not merged" $?
# 18 Nov: gates result showed only QUEUED for a re-queued commit, hiding the verdict it already had.
out=$(cd "$LIVE" && run gates result "$P5" 2>&1); rc=$?
[ $rc = 3 ] && [[ "$(sed -n 1p <<<"$out")" =~ ^earlier:\ [^\ ]+\ $P5\ [^\ ]+\ (PASSED|HELD|MERGED|SKIPPED) ]] && [[ "$(tail -1 <<<"$out")" == QUEUED* ]]
expect "gates result: a re-queued commit shows its earlier verdict first, QUEUED last" $?
# 12 Nov: the runner dropped such a request as SKIPPED (its tree had passed) before the train step,
# so the PR never landed. It must merge main in, gate the new head and merge it.
: >"$T/actions"; run gates run >/dev/null 2>&1; N5=$(git --git-dir="$ORIGIN" rev-parse refs/heads/train)
[ "$N5" != "$P5" ] && grep -q "^[^ ]* $P5 [^ ]* MOVED merged main into PR #13" "$GR" && grep -qx "gh merge 13 $N5" "$T/actions" \
  && ! grep -q "^[^ ]* $P5 [^ ]* SKIPPED already passed: PASSED" <(tail -3 "$GR") && [ -z "$(ls "$GQ")" ]
expect "train: the runner syncs and merges an already-passed train head instead of skipping it" $?
rm -f "$GQ"/*.req
# Merge-only trust (GAU-239): with GAUSS_GATEBOX_TRUST=merge a train request the gatebox passed on its
# exact head runs only test:ops here, as a small job, and may merge; it never writes a deploy record.
gbt() { GAUSS_GATEBOX=gatebox GAUSS_GATEBOX_TRUST=merge "$@"; }
mo() { g push -q origin "$1:refs/heads/$2" && g fetch -q origin; echo "OPEN $2 main false CLEAN" >"$GHD/pr$3"; (cd "$LIVE" && run gates enqueue "$1" --pr "$3" >/dev/null 2>&1); }
Q1=$(tc "$M2" q1.txt q1); mo "$Q1" gb-ok 21
out=$(GBRC=say0 gbt run gates run 2>&1)
grep -q "^[^ ]* $Q1 [^ ]* PASSED merge only, no deploy record: gatebox gatebox passed ${Q1:0:7} .*test:ops 99 passed, 0 failed" "$GR" \
  && grep -q "^[^ ]* $Q1 [^ ]* MERGED PR #21" "$GR" && grep -qx "gh merge 21 $Q1" "$T/actions" && [ -z "$(ls "$GQ")" ]
expect "merge only: a train head the gatebox passed is merged after the ops tests here" $?
grep -q "^heavy --wait [0-9]* --max-level 2 --name gates-ops .* gates run-one .* --gatebox-passed $Q1\$" "$T/actions" && ! grep -q -- "--name gates " "$T/actions"
expect "merge only: the ops tests run as a small job (may start on battery), not as the full gate" $?
[ ! -f "$WD/gates/$(tree_of "$Q1").json" ] && [ ! -f "$WD/gates/runs/$Q1.install.log" ] && [ -f "$WD/gates/runs/$Q1.ops.log" ]
expect "merge only: no deploy record is written and nothing is installed" $?
Q2=$(tc "$M1" q2.txt q2); mo "$Q2" gb-behind 22
out=$(GBRC=say0 gbt run gates run 2>&1); N2=$(git --git-dir="$ORIGIN" rev-parse refs/heads/gb-behind)
[ "$N2" != "$Q2" ] && git --git-dir="$ORIGIN" merge-base --is-ancestor "$M2" "$N2" && grep -q "^ssh .*gate@gatebox Pallas117/Constellation $N2\$" "$T/actions" \
  && ! grep -q "^ssh .* $Q2\$" "$T/actions" && grep -q "^[^ ]* $N2 [^ ]* PASSED merge only" "$GR" && grep -qx "gh merge 22 $N2" "$T/actions"
expect "merge only: main is merged in first, and the gatebox screens the head that lands" $?
Q3=$(tc "$M2" q3.txt q3); mo "$Q3" gb-opsfail 23
out=$(GBRC=say0 GATEFAIL=test:ops gbt run gates run 2>&1)
grep -q "^[^ ]* $Q3 [^ ]* FAILED test:ops here (exit 1" "$GR" && ! grep -q "gh merge 23" "$T/actions" && [ -z "$(ls "$GQ")" ]
expect "merge only: failing ops tests here fail the request; nothing is merged" $?
Q4=$(tc "$M2" q4.txt q4); mo "$Q4" gb-anon 24
out=$(GBRC=anon0 gbt run gates run 2>&1)
[[ "$out" == *"without naming the commit"* ]] && grep -q "^heavy --wait [0-9]* --name gates " "$T/actions" && ! grep -q "merge only" <<<"$(grep " $Q4 " "$GR")" \
  && [ -f "$WD/gates/$(tree_of "$Q4").json" ] && grep -qx "gh merge 24 $Q4" "$T/actions"
expect "merge only: a gatebox pass that does not name the commit gets the full gates here" $?
Q5=$(tc "$M2" q5.txt q5); mo "$Q5" gb-down 25
out=$(GBRC=255 gbt run gates run 2>&1)
grep -q "^heavy --wait [0-9]* --name gates " "$T/actions" && [ -f "$WD/gates/$(tree_of "$Q5").json" ] && grep -qx "gh merge 25 $Q5" "$T/actions"
expect "merge only: an unreachable gatebox falls back to the full gates here" $?
Q6=$(tc "$M2" backend/auth-more.ts x); mo "$Q6" gb-auth 26
out=$(GBRC=say0 gbt run gates run 2>&1)
grep -q "^[^ ]* $Q6 [^ ]* HELD passed, not merged: touches backend/auth-more.ts" "$GR" && ! grep -q "gh merge 26" "$T/actions"
expect "merge only: the train's hold rules still apply (auth waits for Josh)" $?
Q7=$(tc "$M2" q7.txt q7); (cd "$LIVE" && run gates enqueue "$Q7" >/dev/null 2>&1)
out=$(GBRC=say0 gbt run gates run 2>&1)
grep -q "^heavy --wait [0-9]* --name gates " "$T/actions" && [ -f "$WD/gates/$(tree_of "$Q7").json" ] && ! grep -q " $Q7 [^ ]* PASSED merge only" "$GR"
expect "merge only: a request without --pr (a deploy record) always gets the full gates here" $?
Q8=$(tc "$M2" q8.txt q8); mo "$Q8" gb-moved 27; req=$(ls "$GQ"/*.req)
gbt run gates run-one "$req" --gatebox-passed "$Q7" >/dev/null 2>&1; rc=$?
[ $rc = 77 ] && [ -f "$req" ] && ! grep -q " $Q8 " "$GR"
expect "merge only: a pass for another commit is never used; the request stays queued to be screened again" $?
rm -f "$GQ"/*.req
Q9=$(tc "$M2" q9.txt q9); mo "$Q9" gb-off 28
out=$(GAUSS_GATEBOX=gatebox GBRC=say0 run gates run 2>&1)
grep -q "^heavy --wait [0-9]* --name gates " "$T/actions" && [ -f "$WD/gates/$(tree_of "$Q9").json" ] && ! grep -q " $Q9 [^ ]* PASSED merge only" "$GR"
expect "merge only: off by default; a gatebox pass alone still gets the full gates here" $?
out=$(gbt run gates result status 2>&1); [[ "$out" == *"a pass lets the train merge after the ops tests here (no deploy record)"* ]]
expect "gates result status: says when a gatebox pass is trusted for merging" $?
rm -f "$GQ"/*.req
# 12 Nov: merging one PR moved main under the next one's run; it sat HELD until a person re-queued it.
M3=$(tc "$M2" main.txt main-3); g push -q origin "$M3:refs/heads/side"; g push -q origin "$M2:refs/heads/main"; g fetch -q origin
P7=$(tc "$M2" f7.txt f7); g push -q origin "$P7:refs/heads/req7" && g fetch -q origin; echo "OPEN req7 main false CLEAN" >"$GHD/pr21"
printf 'git --git-dir="%s" update-ref refs/heads/main %s\n' "$ORIGIN" "$M3" >"$T/movemain.sh"
(cd "$LIVE" && run gates enqueue "$P7" --pr 21 >/dev/null 2>&1); : >"$T/actions"
MOVEMAIN="$T/movemain.sh" run gates run >/dev/null 2>&1; N7=$(git --git-dir="$ORIGIN" rev-parse refs/heads/req7)
grep -q "^[^ ]* $P7 [^ ]* HELD passed, not merged: main moved during the run" "$GR" && grep -q "^[^ ]* $P7 [^ ]* REQUEUED PR #21 re-queued at the front" "$GR" \
  && ! grep -qx "gh merge 21 $P7" "$T/actions"
expect "train: a head main moved past during its run is re-queued at the front, not left HELD" $?
[ "$N7" != "$P7" ] && git --git-dir="$ORIGIN" merge-base --is-ancestor "$M3" "$N7" && grep -q "^[^ ]* $P7 [^ ]* MOVED merged main into PR #21" "$GR" \
  && grep -qx "gh merge 21 $N7" "$T/actions" && [ -z "$(ls "$GQ")" ]
expect "train: the re-queued head gets main merged in, passes and is merged in the same pass" $?
# 18 Nov: a pass the train can't merge itself (held for Josh, or a draft) waited up to 30 min for the
# merge job; the train merged another PR meanwhile, main moved, and the pass was run again (9 of 37 runs).
# The after-pass hook runs right after each pass, before the next request can move main.
HOOKD="$WD/gates/hooks"; mkdir -p "$HOOKD"; : >"$T/hook.log"
printf '#!/bin/bash\necho "hook $*" >>"%s"\necho "merge job says hi"\n' "$T/hook.log" >"$HOOKD/after-pass"; chmod +x "$HOOKD/after-pass"
P10=$(tc "$M3" backend/auth-more.ts x); P11=$(tc "$M3" f11.txt f11); P12=$(tc "$M3" f12.txt f12)
g push -q origin "$P10:refs/heads/held10" "$P11:refs/heads/q11" "$P12:refs/heads/q12" && g fetch -q origin
echo "OPEN held10 main false CLEAN" >"$GHD/pr41"; echo "OPEN q11 main false CLEAN" >"$GHD/pr42"; echo "OPEN q12 main false CLEAN" >"$GHD/pr43"
(cd "$LIVE" && run gates enqueue "$P10" --pr 41 >/dev/null 2>&1; run gates enqueue "$P11" --pr 42 >/dev/null 2>&1)
out=$(run gates run 2>&1)
grep -qx "hook $P10 41" "$T/hook.log" && grep -qx "hook $P11 42" "$T/hook.log" && [[ "$out" == *"  hook: merge job says hi"* ]] \
  && [ "$(grep -n "after-pass hook for ${P10:0:7}" <<<"$out" | cut -d: -f1)" -lt "$(grep -n "gates ${P11:0:7} \.\.\." <<<"$out" | cut -d: -f1)" ]
expect "gates run: the after-pass hook runs after each pass (held or merged), before the next request starts" $?
: >"$T/hook.log"; (cd "$LIVE" && run gates enqueue "$P12" --pr 43 >/dev/null 2>&1); GATEFAIL=test run gates run >/dev/null 2>&1
grep -q "^[^ ]* $P12 [^ ]* FAILED" "$GR" && [ ! -s "$T/hook.log" ]; expect "gates run: no after-pass hook after a failed gate" $?
printf '#!/bin/bash\nsleep 60 &\necho $! >>"%s"\nsleep 60\n' "$T/hook-kids" >"$HOOKD/after-pass"; P13=$(tc "$M3" f13.txt f13); P14=$(tc "$M3" f14.txt f14)
(cd "$LIVE" && run gates enqueue "$P13" >/dev/null 2>&1; run gates enqueue "$P14" >/dev/null 2>&1)
t0=$SECONDS; out=$(GAUSS_GATES_HOOK_S=1 run gates run 2>&1); rc=$?
kids=0; while read -r k; do kill -0 "$k" 2>/dev/null && { kids=$((kids + 1)); kill "$k"; }; done <"$T/hook-kids"
[ $rc = 0 ] && [ $((SECONDS - t0)) -lt 45 ] && [ $kids = 0 ] && [ "$(grep -c "after-pass hook stopped after 1 s" <<<"$out")" = 2 ] \
  && grep -q "^[^ ]* $P14 [^ ]* PASSED" "$GR" && [ -z "$(ls "$GQ")" ]
expect "gates run: a hung after-pass hook is stopped (its children too) and the queue goes on" $?
rm -f "$HOOKD/after-pass"
# 18 Nov: a tree queued for gates only, then enqueued with --pr, dropped the PR (its pass never merged).
P15=$(tc "$M3" f15.txt f15); (cd "$LIVE" && run gates enqueue "$P15" >/dev/null 2>&1)
out=$(cd "$LIVE" && run gates enqueue "$P15" --pr 44 2>&1)
[ "$(ls "$GQ" | grep -c '\.req$')" = 1 ] && grep -qx "pr=44" "$GQ"/*.req && [ "$(grep -c '^pr=' "$GQ"/*.req)" = 1 ] \
  && grep -qx "sha=$P15" "$GQ"/*.req && [[ "$out" == *"on the merge train for PR #44"* ]] && [ -z "$(ls "$GQ" | grep -v '\.req$')" ]
expect "gates enqueue: a tree already queued for gates only joins the train when enqueued again with --pr" $?
rm -f "$GQ"/*.req
# The pass contract for scripts (merge-approved.sh): the record for the exact tree, not the last line's wording.
out=$(cd "$LIVE" && run gates passed "$P11"); rc1=$?; (cd "$LIVE" && run gates passed "$P12" >/dev/null); rc2=$?
(cd "$LIVE" && run gates passed 0000000 >/dev/null 2>&1); rc3=$?
[ $rc1 = 0 ] && [[ "$out" == "PASSED ${P11:0:7}"* ]] && [ $rc2 = 1 ] && [ $rc3 = 2 ]
expect "gates passed: exit 0 only for a commit whose exact tree passed (1 not passed, 2 unknown commit)" $?
(cd "$LIVE" && run gates enqueue "$P11" >/dev/null 2>&1); echo "sha=$P11" >"$GQ/9.000000-$(tree_of "$P11").req"; echo "tree=$(tree_of "$P11")" >>"$GQ/9.000000-$(tree_of "$P11").req"
(cd "$LIVE" && run gates result "$P11" >/dev/null); rcq=$?; (cd "$LIVE" && run gates passed "$P11" >/dev/null); rcp=$?
[ $rcq = 3 ] && [ $rcp = 0 ]; expect "gates passed: a passed commit queued again still counts as passed (gates result says QUEUED)" $?
rm -f "$GQ"/*.req
# 18 Nov: #160 was gated 7 times and #175 5 times in a day: each pass was held for a person, main moved,
# and the same change was gated again with nothing able to merge it. A held pass now waits without runs
# until its own change differs, it stops being a draft, or it is queued with --final.
runs_of() { grep -c "^[^ ]* [^ ]* [^ ]* PASSED" "$GR"; } # gate runs so far
W1=$(tc "$M3" backend/auth-wait.ts a); D1=$(tc "$M3" d52.txt d); g push -q origin "$W1:refs/heads/w51" "$D1:refs/heads/d52" && g fetch -q origin
echo "OPEN w51 main false CLEAN" >"$GHD/pr51"; echo "OPEN d52 main true CLEAN" >"$GHD/pr52"
(cd "$LIVE" && run gates enqueue "$W1" --pr 51 >/dev/null 2>&1; run gates enqueue "$D1" --pr 52 >/dev/null 2>&1); run gates run >/dev/null 2>&1
grep -q "^[^ ]* $W1 [^ ]* HELD passed, not merged: touches backend/auth-wait.ts" "$GR" && grep -q "^[^ ]* $D1 [^ ]* HELD passed, not merged: draft" "$GR" \
  && grep -qx "kind=person" "$WD/gates/held/51" && grep -qx "kind=draft" "$WD/gates/held/52" && grep -qx "sha=$W1" "$WD/gates/held/51"
expect "train: a pass held for a person or as a draft leaves a note" $?
M4=$(tc "$M3" main.txt main-4); g push -q origin "$M4:refs/heads/main" && g fetch -q origin
n=$(runs_of); (cd "$LIVE" && run gates enqueue "$W1" --pr 51 >/dev/null 2>&1; run gates enqueue "$D1" --pr 52 >/dev/null 2>&1); out=$(run gates run 2>&1)
[ "$(runs_of)" = "$n" ] && [ -z "$(ls "$GQ")" ] && [ "$(git --git-dir="$ORIGIN" rev-parse refs/heads/w51)" = "$W1" ] && [ "$(git --git-dir="$ORIGIN" rev-parse refs/heads/d52)" = "$D1" ] \
  && grep -q "^[^ ]* $W1 [^ ]* HELD PR #51 passed on ${W1:0:7} and nothing of its own has changed: not gated again while it waits (Josh merges). When it can merge: gates enqueue ${W1:0:7} --pr 51 --final" "$GR" \
  && grep -q "^[^ ]* $D1 [^ ]* HELD PR #52 passed on ${D1:0:7} and nothing of its own has changed: not gated again while it waits (draft)" "$GR"
expect "train: after main moves, a PR that only waits is not gated or merged into again" $?
out=$(cd "$LIVE" && run gates enqueue "$W1" --final 2>&1); [ $? = 2 ] && [[ "$out" == *"--final needs --pr"* ]]; expect "train: --final needs --pr" $?
n=$(runs_of); (cd "$LIVE" && run gates enqueue "$W1" --pr 51 --final >/dev/null 2>&1); grep -qx "final=1" "$GQ"/*.req; f1=$?
: >"$T/actions"; run gates run >/dev/null 2>&1; W2=$(git --git-dir="$ORIGIN" rev-parse refs/heads/w51)
[ $f1 = 0 ] && [ "$(runs_of)" = $((n + 1)) ] && [ "$W2" != "$W1" ] && git --git-dir="$ORIGIN" merge-base --is-ancestor "$M4" "$W2" \
  && grep -q "^[^ ]* $W1 [^ ]* MOVED merged main into PR #51" "$GR" && grep -q "^[^ ]* $W2 [^ ]* PASSED" "$GR" && ! grep -q "gh merge 51" "$T/actions" \
  && grep -qx "sha=$W2" "$WD/gates/held/51"
expect "train: --final gates a waiting PR against main as it is now (still merged by Josh, not the train)" $?
g fetch -q origin; W3=$(tc "$W2" backend/auth-wait.ts b); g push -q origin "$W3:refs/heads/w51" && g fetch -q origin
n=$(runs_of); (cd "$LIVE" && run gates enqueue "$W3" --pr 51 >/dev/null 2>&1); run gates run >/dev/null 2>&1
[ "$(runs_of)" = $((n + 1)) ] && grep -q "^[^ ]* $W3 [^ ]* PASSED" "$GR"; expect "train: a waiting PR whose own change differs is gated again" $?
echo "OPEN d52 main false CLEAN" >"$GHD/pr52"; : >"$T/actions"; (cd "$LIVE" && run gates enqueue "$D1" --pr 52 >/dev/null 2>&1); run gates run >/dev/null 2>&1
D2=$(git --git-dir="$ORIGIN" rev-parse refs/heads/d52)
[ "$D2" != "$D1" ] && grep -qx "gh merge 52 $D2" "$T/actions" && [ ! -e "$WD/gates/held/52" ]
expect "train: a draft marked ready is synced, gated and merged, and its note is gone" $?
K1=$(tc "$M3" main.txt clash-53); g push -q origin "$K1:refs/heads/k53" && g fetch -q origin; echo "OPEN k53 main false CLEAN" >"$GHD/pr53"
: >"$T/log"; (cd "$LIVE" && run gates enqueue "$K1" --pr 53 >/dev/null 2>&1); run gates run >/dev/null 2>&1
(cd "$LIVE" && run gates enqueue "$K1" --pr 53 >/dev/null 2>&1); run gates run >/dev/null 2>&1
[ "$(grep -c "^[^ ]* $K1 [^ ]* CONFLICT PR #53 can't take main" "$GR")" = 1 ] && [ "$(grep -c "^[^ ]* $K1 [^ ]* CONFLICT PR #53 still can't take main" "$GR")" = 1 ] \
  && [ "$(alerts | tr ' ' '\n' | grep -cx train-53)" -le 1 ] && [ -z "$(ls "$GQ")" ]
expect "train: a conflict is tried and texted once per head, not on every enqueue" $?
K2=$(tc "$M4" k53.txt resolved); g push -q -f origin "$K2:refs/heads/k53" && g fetch -q origin; : >"$T/actions"
(cd "$LIVE" && run gates enqueue "$K2" --pr 53 >/dev/null 2>&1); run gates run >/dev/null 2>&1
grep -qx "gh merge 53 $K2" "$T/actions"; expect "train: once the conflicting branch moves, it is gated and merged" $?
rm -f "$GQ"/*.req; git --git-dir="$ORIGIN" update-ref refs/heads/main "$M3"; g fetch -q origin # main back where the tests below expect it
# Queue tooling: reorder by PR, list the queue by PR, list passes that wait for a person.
P8=$(tc "$M3" f8.txt f8); P9=$(tc "$M3" f9.txt f9); g push -q origin "$P8:refs/heads/q8" "$P9:refs/heads/q9" && g fetch -q origin
(cd "$LIVE" && run gates enqueue "$P8" --pr 31 >/dev/null 2>&1; run gates enqueue "$P9" --pr 32 >/dev/null 2>&1)
out=$(run gates priority 32 front 2>&1); first=$(ls "$GQ" | sort | sed -n 1p)
grep -qx "pr=32" "$GQ/$first" && [[ "$out" == *"Moved 1 request(s) for 32 to the front"* ]] && [[ "$(sed -n 1p <<<"$(run gates queue)")" == *"#32"* ]]
expect "gates priority: a PR moves to the front, and gates queue lists requests in run order by PR" $?
out=$(run gates priority 31 back 2>&1); last=$(ls "$GQ" | sort | tail -1); grep -qx "pr=31" "$GQ/$last"
expect "gates priority: a PR moves to the back" $?
out=$(run gates priority 99 front 2>&1); [ $? = 1 ] && [[ "$out" == *"Nothing queued for 99"* ]]; expect "gates priority: an unknown PR is refused" $?
# 17 Nov: keys matched as prefixes, so "99" hit any sha starting 99 (the test above failed ~1 run in
# 128, failing PR #259's gates) and PR 3 would have moved PR 31.
out=$(run gates priority 3 front 2>&1); [ $? = 1 ] && [[ "$out" == *"Nothing queued for 3"* ]]
expect "gates priority: a PR number never matches a longer PR number" $?
before=$(ls "$GQ" | sort); out=$(run gates priority "${P8:0:5}" front 2>&1); rc=$?
[ "$rc" != 0 ] && [ "$(ls "$GQ" | sort)" = "$before" ]
expect "gates priority: a short sha prefix moves nothing" $?
out=$(run gates priority "${P8:0:7}" front 2>&1); first=$(ls "$GQ" | sort | sed -n 1p); grep -qx "pr=31" "$GQ/$first"
expect "gates priority: a 7-character sha moves its request" $?
out=$(run gates priority 'pr=.*' front 2>&1); [ $? = 2 ]; expect "gates priority: a key that is not a PR or sha is a usage error" $?
rm -f "$GQ"/*.req
# 18 Nov: requirements PRs each bump the baseline "version" and conflicted with each other (#284, #286).
# A conflict on that line alone is settled as main's version plus one patch step and gated; any other
# conflict, even in the same file, still waits for a person.
RJ() { printf '{\n  "version": "%s",\n  "requirements": [\n    {"id": "%s"},\n    {"id": "M"},\n    {"id": "%s"}\n  ]\n}' "$@"; }
R0=$(tc "$M3" requirements/requirements.json "$(RJ 1.0.0 A Z)")
RM=$(tc "$R0" requirements/requirements.json "$(RJ 1.1.0 A Y)")   # main: 1.1.0, Z -> Y
RP=$(tc "$R0" requirements/requirements.json "$(RJ 1.0.1 B Z)")   # PR: 1.0.1, A -> B (version line only clashes)
RX=$(tc "$R0" requirements/requirements.json "$(RJ 1.0.1 A X)")   # PR: 1.0.1, Z -> X (clashes with main's Y too)
g push -q origin "$RM:refs/heads/main" "$RP:refs/heads/reqs" "$RX:refs/heads/reqclash" && g fetch -q origin
echo "OPEN reqs main false CLEAN" >"$GHD/pr41"; echo "OPEN reqclash main false CLEAN" >"$GHD/pr42"; : >"$T/actions"
(cd "$LIVE" && run gates enqueue "$RP" --pr 41 >/dev/null 2>&1; run gates enqueue "$RX" --pr 42 >/dev/null 2>&1); run gates run >/dev/null 2>&1
NR=$(git --git-dir="$ORIGIN" rev-parse refs/heads/reqs); rj=$(git --git-dir="$ORIGIN" show "$NR:requirements/requirements.json")
[ "$NR" != "$RP" ] && git --git-dir="$ORIGIN" merge-base --is-ancestor "$RM" "$NR" && [ "$(git --git-dir="$ORIGIN" rev-parse "$NR^1")" = "$RP" ] \
  && [ "$rj" = "$(RJ 1.1.1 B Y)" ] && grep -q "^[^ ]* $RP [^ ]* MOVED merged main into PR #41" "$GR" && grep -qx "gh merge 41 $NR" "$T/actions"
expect "train: a conflict on the requirements baseline version alone is settled (main's version + 1 patch), gated and merged" $?
grep -q "^[^ ]* $RX [^ ]* CONFLICT PR #42" "$GR" && [ "$(git --git-dir="$ORIGIN" rev-parse refs/heads/reqclash)" = "$RX" ] && ! grep -q "gh merge 42" "$T/actions"
expect "train: a requirements conflict beyond the version line still waits for a person" $?
rm -f "$GQ"/*.req
printf '%s 13 true CLEAN Brand refresh\n%s 21 false CLEAN Already merged head\n' "$N5" "$P8" >"$GHD/open"
out=$(cd "$LIVE" && run gates waiting 2>&1)
[[ "$out" == *"#13 ${N5:0:7} draft, CLEAN: Brand refresh"* ]] && [[ "$out" == *"next: mark it ready (gh pr ready 13)"* ]] && [[ "$out" != *"#21 "* ]]
expect "gates waiting: lists open PRs whose head passed (with the next step), and nothing that hasn't" $?
rm -f "$GHD/open"
g checkout -q --detach "$prevhead"; g remote remove origin; rm -f "$T/bin/gh" "$T/home/.gitconfig"

# Fleet memory watch (GAU-240): the guard texts when another mesh device's memory is at risk or
# critical, from the file the hub keeps; stale states, this Mac and junk are ignored.
FM="$T/fleet-memory.json"; fmnow=$(date -u +%Y-%m-%dT%H:%M:%SZ); fmold=$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ); fmme=$(hostname -s | tr '[:upper:]' '[:lower:]')
printf '{"at":"%s","staleAfterMs":900000,"devices":[{"name":"devbox","state":"critical","why":["memory pressure critical"],"reportedAt":"%s"},{"name":"labbox","state":"risk","why":["swap climbing at warn","<b>x</b>"],"reportedAt":"%s"},{"name":"oldbox","state":"critical","why":["memory pressure critical"],"reportedAt":"%s"},{"name":"%s","state":"critical","why":["memory pressure critical"],"reportedAt":"%s"},{"name":"calm","state":"ok","why":[],"reportedAt":"%s"},{"name":"Bad Name;x","state":"critical","why":[],"reportedAt":"%s"}]}' \
  "$fmnow" "$fmnow" "$fmnow" "$fmold" "$fmme" "$fmnow" "$fmnow" "$fmnow" >"$FM"
GAUSS_FLEET_MEMORY="$FM" run awake guard
[[ " $(alerts) " == *" mesh-mem-devbox "* ]] && [[ " $(alerts) " == *" mesh-mem-labbox "* ]] && grep -q "devbox is out of memory" "$T/log" && grep -q "labbox is short of memory" "$T/log"
expect "fleet memory: a device at risk or critical is texted, once per device" $?
[[ " $(alerts) " != *"mesh-mem-oldbox"* ]] && [[ " $(alerts) " != *"mesh-mem-$fmme "* ]] && [[ " $(alerts) " != *"mesh-mem-calm"* ]] && ! grep -q "Bad Name" "$T/log" && ! grep -q "<b>" "$T/log"
expect "fleet memory: a stale state, this Mac, an ok device and unchecked text are never texted" $?
ev 'any(e["event"] == "fleet-memory" and e["label"] == "devbox" and e.get("state") == "critical" for e in E)'
expect "fleet memory: each finding is an ops event" $?
fmev() { python3 -Ic 'import json,sys; print(sum(1 for l in open(sys.argv[1]) if json.loads(l).get("event") == "fleet-memory"))' "$EV" 2>/dev/null || echo 0; }
n1=$(fmev); GAUSS_FLEET_MEMORY="$FM" run awake guard
[ "$(fmev)" = "$n1" ] && [[ " $(alerts) " != *"mesh-mem-"* ]]; expect "fleet memory: within 2 h a device still at risk adds no event and no text" $?
echo '{not json' >"$FM"; GAUSS_FLEET_MEMORY="$FM" run awake guard; rc=$?
[ $rc = 0 ] && [[ " $(alerts) " != *"mesh-mem-"* ]]; expect "fleet memory: an unreadable file is ignored and the guard carries on" $?
GAUSS_FLEET_MEMORY="$T/none.json" run awake guard; [ $? = 0 ] && [[ " $(alerts) " != *"mesh-mem-"* ]]; expect "fleet memory: no file, no alert" $?

# balance (GAU-126): shed optional load, undo it when conditions recover
acts() { tr '\n' ';' <"$T/actions" | sed 's/;$//'; }
PAUSED="$T/home/Library/Application Support/Gauss/learning-paused"
MLX=1 LEVEL=4 run awake guard
[ "$(acts)" = "pkill -f mlx_lm.server.*--port 8089" ] && [ "$(alerts)" = "memory-low balance" ]; expect "critical pressure with the local model running: stopped, one balance alert" $?
MLX=1 LEVEL=2 run awake guard
[ "$(acts)" = "pkill -f mlx_lm.server.*--port 8089" ] && [ "$(alerts)" = "balance" ]; expect "warn pressure: the local model is shed before it gets critical" $?
MLX=1 SWAPUSED=4200 run awake guard
[ "$(acts)" = "pkill -f mlx_lm.server.*--port 8089" ]; expect "4.1 GB swap: the local model is shed" $?
MLX=1 MLXPORT=3032 LEVEL=4 run awake guard
[ -z "$(acts)" ]; expect "Gauss's memory answer model (:3032) is never shed" $?
MLX=1 FREE=10 run awake guard
[ -z "$(acts)" ]; expect "10% 'free' at normal pressure: nothing shed" $?
LEVEL=4 run awake guard
[ -z "$(acts)" ] && [ "$(alerts)" = "memory-low" ]; expect "memory short, nothing optional running: no action" $?
SRC="Battery Power" BATT="45%; discharging; present: true" run awake guard
[ -f "$PAUSED" ] && [ "$(alerts)" = "battery-low" ]; expect "battery 45%: learning paused quietly (log only)" $?
grep -q "paused nightly learning" "$T/home/Library/Logs/gauss/balance.log"; expect "balance logs what it did" $?
SRC="Battery Power" BATT="55%; discharging; present: true" run awake guard
[ -f "$PAUSED" ]; expect "battery 55%: still paused (hysteresis to warn+10)" $?
SRC="AC Power" BATT="14%; AC attached; not charging present: true" run awake guard
[ -f "$PAUSED" ]; expect "14% on a charger that isn't keeping up: still paused" $?
SRC="AC Power" BATT="26%; charging; present: true" run awake guard
[ ! -f "$PAUSED" ]; expect "back on AC: learning resumed" $?
# The suite can outlast an hour of wall clock if the Mac sleeps mid-run: re-date the existing stamp
STAMP="$T/home/Library/Application Support/Gauss/balance-cleanup"; [ -f "$STAMP" ] && touch "$STAMP"
DISKGB=5 run awake guard
[ -z "$(acts)" ] && [ "$(alerts)" = "disk-low" ]; expect "disk 5 GB again within the hour: no second cleanup" $?
rm -f "$T/home/Library/Application Support/Gauss/balance-cleanup"
DISKGB=5 run awake guard
[ "$(acts)" = "disk-cleanup --apply --if-below 15" ]; expect "disk 5 GB, an hour later: allowlisted cleanup runs" $?
MLX=1 LEVEL=4 GAUSS_BALANCE=0 run awake guard
[ -z "$(acts)" ]; expect "GAUSS_BALANCE=0: balance does nothing" $?
out=$(MLX=1 LEVEL=4 run balance --dry-run)
[ -z "$(acts)" ] && [[ "$out" == *"would: pkill -f mlx_lm.server.*--port 8089"* ]]; expect "balance --dry-run only reports" $?
out=$(run balance --dry-run)
[[ "$out" == "balanced: nothing to do"* ]]; expect "healthy machine: nothing to do" $?

# Leaking macOS helpers (GAU-183): restarted by name once past GAUSS_LEAK_MB (1024), whatever the pressure
LEAKY=CursorUIViewService LEAKFP="3.7 GB" run awake guard
[ "$(acts)" = "pkill -x CursorUIViewService" ] && [ "$(alerts)" = "balance" ]
expect "a 3.7 GB CursorUIViewService is restarted at normal pressure, with one balance text" $?
grep -q "restarted CursorUIViewService (3788 MB" "$T/home/Library/Logs/gauss/balance.log"; expect "the restart is logged with its size" $?
LEAKY=CursorUIViewService LEAKFP="400 MB" run awake guard
[ -z "$(acts)" ]; expect "a 400 MB helper is left alone (limit 512 MB)" $?
LEAKY=CursorUIViewService LEAKFP="512 KB" run awake guard
[ -z "$(acts)" ]; expect "footprint in KB parses (left alone)" $?
LEAKY=Safari LEAKFP="6 GB" run awake guard
[ -z "$(acts)" ]; expect "an app that isn't on the leaky-helper list is never touched" $?
out=$(LEAKY=CursorUIViewService LEAKFP="2 GB" run balance --dry-run)
[ -z "$(acts)" ] && [[ "$out" == *"would: pkill -x CursorUIViewService"* ]]; expect "--dry-run only reports the restart" $?

# resilience checklist
echo '{"phone_to":"+60123456789"}' >"$T/home/.config/argo/config.json"
echo '{"hooks":{"Notification":[{"hooks":[{"type":"command","command":"~/.local/bin/claude-phone-hook"}]}]}}' >"$T/home/.claude/settings.json"
touch "$T/home/.local/share/mesh-heal/state"
out=$(run resilience | plain)
for want in "✓ battery 80% on AC" "✓ memory pressure normal, swap 1.0 GB" "✓ disk 50 GB free" "✓ network: ● OK MY" "✓ tailnet self-heal" \
  "✓ phone alerts: iMessage via argo notify" "✓ Claude Code prompts forwarded"; do
  [[ "$out" == *"$want"* ]]; expect "resilience shows '$want'" $?
done
out=$(OLD_ARGO=1 LEVEL=4 SRC="AC Power" BATT="6%; AC attached; not charging present: true" run resilience | plain); rc=$? # pipefail: resilience's own exit code
[ $rc = 1 ] && [[ "$out" == *"✗ phone alerts: argo is too old"* && "$out" == *"✗ memory pressure critical"* && "$out" == *"✗ battery 6% on AC, not gaining"* ]]
expect "resilience fails on an old argo, low memory and a weak charger" $?
[ -z "$(alerts)" ]; expect "resilience only reports; it sends no alerts" $?
out=$(SRC="AC Power" BATT="7%; charging; 2:00 remaining present: true" run resilience | plain)
[[ "$out" == *"✗ battery 7% on AC, charging but too low to unplug yet"* ]]; expect "resilience: low battery still fails while charging" $?

# phone battery line: percentage, charging and age only; the device name never appears
[[ "$out" == *"– phone battery: no phone has reported"* ]]; expect "resilience: no phone report is a note" $?
phone_store() { # phone_store <level> <charging true|false> <minutes ago> [platform]
  python3 -Ic 'import json,sys
from datetime import datetime,timedelta,timezone
at=(datetime.now(timezone.utc)-timedelta(minutes=float(sys.argv[3]))).isoformat().replace("+00:00","Z")
old=(datetime.now(timezone.utc)-timedelta(minutes=1)).isoformat().replace("+00:00","Z")
json.dump([{"name":"secret-phone","last":{"platform":sys.argv[4],"receivedAt":at,"battery":{"level":float(sys.argv[1]),"charging":sys.argv[2]=="true","lowPower":False}}},
 {"name":"a-mac","last":{"platform":"macos","receivedAt":old,"battery":{"level":3,"charging":False,"lowPower":False}}},{"name":"never-reported"}],open(sys.argv[5],"w"))' "$1" "$2" "$3" "${4:-ios}" "$T/devices.json"
}
phone_store 15 false 4
out=$(GAUSS_MESH_STORE="$T/devices.json" run resilience | plain); rc=$?
[ $rc = 1 ] && [[ "$out" == *"✗ phone battery 15%, not charging (reported 4 min ago): plug it in"* ]]; expect "resilience: a phone at 15% and not charging fails" $?
[[ "$out" != *secret-phone* ]]; expect "resilience: the phone's name is not printed" $?
phone_store 15 true 4 android
out=$(GAUSS_MESH_STORE="$T/devices.json" run resilience | plain); rc=$?
[[ "$out" != *"✗ phone battery"* && "$out" == *"✓ phone battery 15%, charging (reported 4 min ago)"* ]]; expect "resilience: a low phone that is charging passes" $?
phone_store 62 false 4
out=$(GAUSS_MESH_STORE="$T/devices.json" run resilience | plain)
[[ "$out" == *"✓ phone battery 62%, not charging (reported 4 min ago)"* ]]; expect "resilience: a phone at 62% passes (the Mac's 3% is not the phone)" $?
phone_store 5 false 600
out=$(GAUSS_MESH_STORE="$T/devices.json" run resilience | plain); rc=$?
[[ "$out" != *"✗ phone battery"* && "$out" == *"– phone battery: 5% as of 10 h ago, too old to judge"* ]]; expect "resilience: a 10 h old phone report is a note, not a verdict" $?
echo 'not json' >"$T/devices.json"
out=$(GAUSS_MESH_STORE="$T/devices.json" run resilience | plain); rc=$?
[[ "$out" != *"✗ phone battery"* && "$out" == *"– phone battery: no phone has reported"* ]]; expect "resilience: an unreadable store is a note" $?

out=$(ARGOSTATUS="● WIFI_RISK MY ts:on" run resilience | plain)
[[ "$out" == *"✓ network: ● WIFI_RISK MY ts:on (warning:"* ]]; expect "WIFI_RISK is a warning, not a failure" $?
out=$(ARGOSTATUS="● REGION HK ts:on" run resilience | plain)
[[ "$out" == *"✗ network: ● REGION HK"* ]]; expect "REGION still fails the network item" $?
# Boot breadcrumb (GAU-164): the first guard run after kern.boottime changes says when the Mac went
# away and what it looked like; a panic report since the previous boot is named.
rm -f "$WD/watch-kicks" "$WD"/*.strikes "$T/kicks.state"
printf 'ts\tlevel\tfree_pct\twired\tanon\tfile\tcmp_occ\tcmp_data\tswap\n2026-10-21 23:56:00\t2\t40\t1\t1\t1\t1\t1\t5.30\n' >"$T/home/Library/Logs/gauss/memory.tsv"
boots() { python3 -Ic 'import json,sys; print(sum(json.loads(l)["event"]=="boot" for l in open(sys.argv[1])))' "$EV"; }
n0=$(boots); BOOT=1000 run awake guard
[ "$(boots)" = "$n0" ]; expect "boot: same boottime, no boot event" $?
touch -t 202001010000 "$WD/guard.heartbeat"; touch "$T/diag/Kernel-2026-10-21.panic" "$T/diag/JetsamEvent-2026-10-21.ips"
touch -t 202501010000 "$T/diag/old.panic" # before the previous boot: not this crash
echo 1760000000 >"$WD/boottime" # previous boot 2025-10-09
BOOT=1761000000 run awake guard
[ "$(boots)" = $((n0 + 1)) ] && [[ "$(alerts)" == *boot* ]] && grep -q "last seen 00:00, pressure warn, swap 5.30 GB" "$T/log"
expect "boot: simulated reboot gives one boot event and a phone text with the last-seen window" $?
ev '(b:=[e for e in E if e["event"]=="boot"][-1])["prev_boot"]=="2025-10-09T08:53:20Z" and "2019-12-31" <= b["last_seen"] < "2020-01-02" and b["last_memory"].startswith("2026-10-21 23:56:00 pressure warn") and b["shutdown_cause"]=="-128" and sorted(b["reports"].split())==["JetsamEvent-2026-10-21.ips","Kernel-2026-10-21.panic"]'
r=$?; [ $r = 0 ] || grep '"event":"boot"' "$EV" | tail -1 | sed 's/^/    boot event: /'; (exit $r)
expect "boot: the event has the previous boot, last seen, last memory row, reports since then and the shutdown cause" $?
BOOT=1761000000 run awake guard
[ "$(boots)" = $((n0 + 1)) ]; expect "boot: only the first run after a boot writes it" $?
echo 1000 >"$WD/boottime" # back to the default boot for the rest of the suite

# memory.tsv every minute while memory is short (mem-guard lives outside the repo; stubbed here)
rm -f "$T/home/mem-samples" "$T/home/Library/Logs/gauss/memory.tsv"
run awake guard; [ ! -f "$T/home/mem-samples" ]; expect "memory normal: no extra memory.tsv sample" $?
LEVEL=2 run awake guard; [ "$(cat "$T/home/mem-samples")" = sample ]; expect "pressure warn: memory.tsv sampled by the guard" $?
SWAPUSED=4200 run awake guard; [ "$(wc -l <"$T/home/mem-samples" | tr -d ' ')" = 2 ]; expect "swap high: memory.tsv sampled by the guard" $?

# Alerts are events once per key per interval, not every minute
rm -rf "$WD/alerts"
n=$(python3 -Ic 'import json,sys; print(sum(json.loads(l)["event"]=="alert" for l in open(sys.argv[1])))' "$EV")
LEVEL=4 run awake guard; LEVEL=4 run awake guard
ev 'sum(e["event"]=="alert" for e in E)=='"$((n + 1))"' and E[-1]["label"]=="memory-low"'; expect "alerts: a repeated alert is one event per interval" $?

# Escaping and redaction: helpers sourced on their own (the script's case would run otherwise)
lit=$(bash -c 'eval "$(sed -n "/^redact() {/,/^json_opt()/p" "$1")"; json_str "$2"' _ "$SCRIPT" $'say "hi"\\ 	 https://u:pw@h.example/p?token=abc api_key=s3cr3t')
python3 -Ic 'import json,sys; v=json.loads(sys.argv[1]); sys.exit(0 if v=="say \"hi\"\\ \t https://h.example/p?<redacted> api_key=<redacted>" else 1)' "$lit"
expect "events: quotes, backslashes and control characters escaped; credentials, query strings and key= values redacted" $?

# Every line is valid JSON with the required fields
python3 -Ic '
import json, sys
keys = {"ts","host","event","label","reason","live_sha","fallback_sha","pressure","swap_mb","battery","on_ac"}
rows = [json.loads(l) for l in open(sys.argv[1])]
sys.exit(0 if rows and all(keys <= set(r) for r in rows) else 1)' "$EV"
expect "events.jsonl: every line is valid JSON with all fields" $?
# A window of a day, not 2 h: these events are stamped with the real clock, and a mid-run sleep outlasts 2 h
out=$(run events --since 1d); [[ "$out" == *"watchdog_kick"*"uk.lightbound.argo"*"[live"* && "$out" == *"boot"* ]]; expect "events --since 1d: readable timeline" $?
out=$(run events --json --since 1d); [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = "$(wc -l <"$EV" | tr -d ' ')" ]; expect "events --json: raw lines" $?
out=$(run events --since 2x 2>&1); [ $? = 2 ] && [[ "$out" == *"30m, 2h or 1d"* ]]; expect "events: bad --since is refused" $?

# Rotation by size: one old file kept
lines=$(wc -l <"$EV" | tr -d ' ')
GAUSS_EVENTS_MAX_KB=1 run awake guard >/dev/null; LEVEL=4 GAUSS_EVENTS_MAX_KB=1 run fallback off >/dev/null
[ "$(wc -l <"$EV.1" | tr -d ' ')" -ge "$lines" ] && [ "$(wc -l <"$EV" | tr -d ' ')" = 1 ]; expect "events.jsonl rotates by size into events.jsonl.1" $?
out=$(run events --json --since 1d); [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" -gt 1 ]; expect "events reads the rotated file too" $?

[ -z "$JUNIT" ] || junit_write gauss-services "$JUNIT"
echo "gauss-services: $pass passed, $failed failed"
[ "$failed" = 0 ]
