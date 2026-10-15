#!/bin/bash
# Tests for the awake guard's phone alerts (battery, memory) and the
# `resilience` checklist. System tools are stubbed on PATH and HOME is a temp
# dir, so nothing touches real power settings or sends a real alert.
#   bash scripts/ops/gauss-services.test.sh      (npm run test:ops)
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/gauss-services.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/home/.config/argo" "$T/home/.claude" "$T/home/.local/share/mesh-heal"
pass=0; failed=0

stub() { printf '#!/bin/bash\n%s\n' "$2" >"$T/bin/$1"; chmod +x "$T/bin/$1"; }
stub pmset 'if [ "$1 $2" = "-g batt" ]; then printf "Now drawing from '"'"'%s'"'"'\n -InternalBattery-0 (id=1)\t%s\n" "$SRC" "$BATT"; else printf " SleepDisabled\t\t%s\n" "${SD:-0}"; fi'
stub memory_pressure 'echo "System-wide memory free percentage: ${FREE:-50}%"'
stub sysctl 'echo "total = 6144.00M  used = ${SWAPUSED:-1000}.00M  free = 0.00M  (encrypted)"'
stub ps 'echo "2097152 node"'
stub ioreg 'echo "\"AppleClamshellState\" = No"'
stub launchctl 'case "$1" in
  print) for l in $LOADED; do [ "$2" = "gui/$(id -u)/$l" ] && exit 0; done; exit 1 ;;
  kickstart) echo "${3##*/}" >>"$KICKS"; exit 0 ;;
esac; exit 1'
stub df 'printf "Filesystem 1G-blocks Used Available\n/dev/disk3s1s1 228 13 %s\n" "${DISKGB:-50}"'
stub curl 'printf "%s" "${HEALTH:-200}"' # code() reads only the HTTP status
stub sudo 'exit 1'
stub argo 'case "$1" in
  notify) [ $# -gt 1 ] || { [ -n "${OLD_ARGO:-}" ] && echo "usage: argo [status|doctor]" >&2 || echo "usage: argo notify [-key K -every 30m] TITLE MESSAGE" >&2; exit 1; }
          shift; echo "$*" >>"$LOG" ;;
  status) echo "● OK MY ts:on" ;;
esac'

# balance stubs: the local model server is "running" when MLX=1; actions land in $ACTIONS
stub pgrep '[ "${MLX:-0}" = 1 ] && [[ "$*" == *mlx_lm.server* ]]'
mkdir -p "$T/home/.local/bin"
printf '#!/bin/bash\necho "local-coder $*" >>"$ACTIONS"\n' >"$T/home/.local/bin/local-coder"
printf '#!/bin/bash\necho "disk-cleanup $*" >>"$ACTIONS"\n' >"$T/home/.local/bin/disk-cleanup"
chmod +x "$T/home/.local/bin/local-coder" "$T/home/.local/bin/disk-cleanup"

run() { # run <args...>: gauss-services.sh with the stubs; alerts land in $LOG
  : >"$T/log"; : >"$T/kicks"; : >"$T/actions"
  env -i PATH="$T/bin:/usr/bin:/bin" HOME="$T/home" ARGO="$T/bin/argo" LOG="$T/log" KICKS="$T/kicks" GAUSS_PUBLIC_URL=http://127.0.0.1:8080 \
    MLX="${MLX:-0}" ACTIONS="$T/actions" GAUSS_BALANCE="${GAUSS_BALANCE:-1}" \
    LOADED="${LOADED:-}" HEALTH="${HEALTH:-200}" DISKGB="${DISKGB:-50}" \
    SRC="${SRC:-AC Power}" BATT="${BATT:-80%; charging; present: true}" SD="${SD:-0}" \
    FREE="${FREE:-50}" SWAPUSED="${SWAPUSED:-1000}" OLD_ARGO="${OLD_ARGO:-}" bash "$SCRIPT" "$@"
}
expect() { # expect <name> <condition-exit-code>
  if [ "$2" = 0 ]; then pass=$((pass + 1)); else failed=$((failed + 1)); echo "FAIL: $1"; sed 's/^/    alerts: /' "$T/log"; fi
}
alerts() { cut -d' ' -f2 "$T/log" | tr '\n' ' ' | sed 's/ $//'; } # the -key of each alert sent
plain() { sed $'s/\033\\[[0-9;]*m//g'; }                          # drop the ✓/✗ colours

# Battery
SRC="AC Power" BATT="6%; AC attached; not charging present: true" SD=1 run awake guard
[ "$(alerts)" = "awake-unguarded charger-weak" ]; expect "6% on a weak charger with sleep disabled and no guard" $?
SRC="AC Power" BATT="80%; charging; 1:00 remaining present: true" run awake guard
[ -z "$(alerts)" ]; expect "80% charging: no alerts" $?
SRC="Battery Power" BATT="18%; discharging; 1:00 remaining present: true" run awake guard
[ "$(alerts)" = "battery-low" ]; expect "18% on battery: low warning" $?
SRC="Battery Power" BATT="9%; discharging; 0:20 remaining present: true" run awake guard
[ "$(alerts)" = "battery-critical" ]; expect "9% on battery: at the floor" $?
SRC="Battery Power" BATT="55%; discharging; 4:00 remaining present: true" run awake guard
[ -z "$(alerts)" ]; expect "55% on battery: no alerts" $?

# Memory
FREE=10 run awake guard
[ "$(alerts)" = "memory-low" ] && grep -q "node 2.0 GB" "$T/log"; expect "10% free memory: alert names the biggest process" $?
SWAPUSED=5800 run awake guard
[ "$(alerts)" = "swap-high" ]; expect "94% swap: alert" $?
FREE=40 SWAPUSED=3000 run awake guard
[ -z "$(alerts)" ]; expect "healthy memory: no alerts" $?

# Disk (seen on the dev Mac: 5 GB free with 5 GB of swap)
DISKGB=5 run awake guard
[ "$(alerts)" = "disk-low balance" ]; expect "5 GB free disk: alert, and balance runs the cleanup" $?
DISKGB=20 run awake guard
[ -z "$(alerts)" ]; expect "20 GB free disk: no alert" $?

# Replay: a real overnight drain from the dev Mac's pmset log (57% down to 2%,
# lid closed, on battery). Alert keys per reading; argo rate-limits repeats.
seq=""
for pct in 57 48 30 21 20 15 11 10 6 2; do
  SRC="Battery Power" BATT="${pct}%; discharging; present: true" run awake guard
  seq+="$pct:$(alerts) "
done
[ "$seq" = "57: 48: 30: 21: 20:battery-low 15:battery-low 11:battery-low 10:battery-critical 6:battery-critical 2:battery-critical " ]
expect "replayed 57→2% drain: warn from 20%, critical from 10%" $?

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

# balance (GAU-126): shed optional load, undo it when conditions recover
acts() { tr '\n' ';' <"$T/actions" | sed 's/;$//'; }
PAUSED="$T/home/Library/Application Support/Gauss/learning-paused"
MLX=1 FREE=10 run awake guard
[ "$(acts)" = "local-coder stop" ] && [ "$(alerts)" = "memory-low balance" ]; expect "memory short with the local model running: stopped, one balance alert" $?
FREE=10 run awake guard
[ -z "$(acts)" ] && [ "$(alerts)" = "memory-low" ]; expect "memory short, nothing optional running: no action" $?
SRC="Battery Power" BATT="18%; discharging; present: true" run awake guard
[ -f "$PAUSED" ] && [ "$(alerts)" = "battery-low" ]; expect "battery 18%: learning paused quietly (log only)" $?
grep -q "paused nightly learning" "$T/home/Library/Logs/gauss/balance.log"; expect "balance logs what it did" $?
SRC="Battery Power" BATT="25%; discharging; present: true" run awake guard
[ -f "$PAUSED" ]; expect "battery 25%: still paused (hysteresis to warn+10)" $?
SRC="AC Power" BATT="26%; charging; present: true" run awake guard
[ ! -f "$PAUSED" ]; expect "back on AC: learning resumed" $?
DISKGB=5 run awake guard
[ "$(acts)" = "disk-cleanup --apply --if-below 8" ] && [ "$(alerts)" = "disk-low balance" ]; expect "disk 5 GB: allowlisted cleanup runs" $?
MLX=1 FREE=10 GAUSS_BALANCE=0 run awake guard
[ -z "$(acts)" ]; expect "GAUSS_BALANCE=0: balance does nothing" $?
out=$(MLX=1 FREE=10 run balance --dry-run)
[ -z "$(acts)" ] && [[ "$out" == *"would: $T/home/.local/bin/local-coder stop"* ]]; expect "balance --dry-run only reports" $?
out=$(run balance --dry-run)
[[ "$out" == "balanced: nothing to do"* ]]; expect "healthy machine: nothing to do" $?

# resilience checklist
echo '{"phone_to":"+60123456789"}' >"$T/home/.config/argo/config.json"
echo '{"hooks":{"Notification":[{"hooks":[{"type":"command","command":"~/.local/bin/claude-phone-hook"}]}]}}' >"$T/home/.claude/settings.json"
touch "$T/home/.local/share/mesh-heal/state"
out=$(run resilience | plain)
for want in "✓ battery 80% on AC" "✓ memory 50% free, swap 16% used" "✓ disk 50 GB free" "✓ network: ● OK MY" "✓ tailnet self-heal" \
  "✓ phone alerts: iMessage via argo notify" "✓ Claude Code prompts forwarded"; do
  [[ "$out" == *"$want"* ]]; expect "resilience shows '$want'" $?
done
out=$(OLD_ARGO=1 FREE=8 SRC="AC Power" BATT="6%; AC attached; not charging present: true" run resilience | plain); rc=$? # pipefail: resilience's own exit code
[ $rc = 1 ] && [[ "$out" == *"✗ phone alerts: argo is too old"* && "$out" == *"✗ memory 8% free"* && "$out" == *"✗ battery 6% on AC, not gaining"* ]]
expect "resilience fails on an old argo, low memory and a weak charger" $?
[ -z "$(alerts)" ]; expect "resilience only reports; it sends no alerts" $?
out=$(SRC="AC Power" BATT="7%; charging; 2:00 remaining present: true" run resilience | plain)
[[ "$out" == *"✗ battery 7% on AC, charging but too low to unplug yet"* ]]; expect "resilience: low battery still fails while charging" $?

echo "gauss-services: $pass passed, $failed failed"
[ "$failed" = 0 ]
