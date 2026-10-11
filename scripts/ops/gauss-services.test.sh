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
stub launchctl 'exit 1'
stub sudo 'exit 1'
stub argo 'case "$1" in
  notify) [ $# -gt 1 ] || { [ -n "${OLD_ARGO:-}" ] && echo "usage: argo [status|doctor]" >&2 || echo "usage: argo notify [-key K -every 30m] TITLE MESSAGE" >&2; exit 1; }
          shift; echo "$*" >>"$LOG" ;;
  status) echo "● OK MY ts:on" ;;
esac'

run() { # run <args...>: gauss-services.sh with the stubs; alerts land in $LOG
  : >"$T/log"
  env -i PATH="$T/bin:/usr/bin:/bin" HOME="$T/home" ARGO="$T/bin/argo" LOG="$T/log" GAUSS_PUBLIC_URL=http://127.0.0.1:8080 \
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

# resilience checklist
echo '{"phone_to":"+60123456789"}' >"$T/home/.config/argo/config.json"
echo '{"hooks":{"Notification":[{"hooks":[{"type":"command","command":"~/.local/bin/claude-phone-hook"}]}]}}' >"$T/home/.claude/settings.json"
touch "$T/home/.local/share/mesh-heal/state"
out=$(run resilience | plain)
for want in "✓ battery 80% on AC" "✓ memory 50% free, swap 16% used" "✓ network: ● OK MY" "✓ tailnet self-heal" \
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
