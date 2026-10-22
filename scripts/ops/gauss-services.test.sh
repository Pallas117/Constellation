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
stub pmset 'if [ "$1 $2" = "-g log" ]; then echo "2026-10-21 00:05:01 +0800 Shutdown Cause  	Shutdown Cause: ${CAUSE:--128}";
elif [ "$1 $2" = "-g batt" ]; then printf "Now drawing from '"'"'%s'"'"'\n -InternalBattery-0 (id=1)\t%s\n" "$SRC" "$BATT"; else printf " SleepDisabled\t\t%s\n" "${SD:-0}"; fi'
stub memory_pressure 'echo "System-wide memory free percentage: ${FREE:-50}%"'
stub sysctl 'case "$*" in
  *pressure_level*) echo "${LEVEL:-1}" ;;
  *boottime*) echo "{ sec = ${BOOT:-1000}, usec = 5 } Thu Oct 22 01:01:27 2026" ;;
  *) echo "total = 6144.00M  used = ${SWAPUSED:-1000}.00M  free = 0.00M  (encrypted)" ;;
esac'
stub ps 'echo "2097152 node"'
stub ioreg 'echo "\"AppleClamshellState\" = No"'
# bootout/bootstrap flip a label in $KICKS.state (over $LOADED) and are logged in $KICKS
stub launchctl 'S="$KICKS.state"; case "$1" in
  print) l=${2##*/}; grep -qx "in $l" "$S" 2>/dev/null && exit 0; grep -qx "out $l" "$S" 2>/dev/null && exit 1
         for x in $LOADED; do [ "$2" = "gui/$(id -u)/$x" ] && exit 0; done; exit 1 ;;
  kickstart) echo "${3##*/}" >>"$KICKS"; exit 0 ;;
  bootout) l=${2##*/}; { grep -vx "in $l" "$S" 2>/dev/null; echo "out $l"; } >"$S.t"; mv "$S.t" "$S"; echo "bootout $l" >>"$KICKS"; exit 0 ;;
  bootstrap) l=$(basename "$3" .plist); { grep -vx "out $l" "$S" 2>/dev/null; echo "in $l"; } >"$S.t"; mv "$S.t" "$S"; echo "bootstrap $l" >>"$KICKS"; exit 0 ;;
esac; exit 1'
stub df 'printf "Filesystem 1G-blocks Used Available\n/dev/disk3s1s1 228 13 %s\n" "${DISKGB:-50}"'
stub curl 'printf "%s" "$(cat "$HEALTH_FILE" 2>/dev/null || echo "${HEALTH:-200}")"' # code() reads only the HTTP status
stub sudo 'exit 1'
stub argo 'case "$1" in
  notify) [ $# -gt 1 ] || { [ -n "${OLD_ARGO:-}" ] && echo "usage: argo [status|doctor]" >&2 || echo "usage: argo notify [-key K -every 30m] TITLE MESSAGE" >&2; exit 1; }
          shift; echo "$*" >>"$LOG" ;;
  status) echo "${ARGOSTATUS:-● OK MY ts:on}" ;;
esac'

# balance stubs: the local model server is "running" when MLX=1; actions land in $ACTIONS
stub pgrep '[ "${MLX:-0}" = 1 ] && [[ "$*" == *mlx_lm.server* && "$*" == *"--port ${MLXPORT:-8089}"* ]]'
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
    GATEFAIL="${GATEFAIL:-}" GAUSS_BY=test-user BOOT="${BOOT:-1000}" GAUSS_DIAG_DIRS="$T/diag" GAUSS_EVENTS_MAX_KB="${GAUSS_EVENTS_MAX_KB:-5120}" \
    GAUSS_DEV_DRY="${GAUSS_DEV_DRY:-0}" GAUSS_DEV_API_PORT="${GAUSS_DEV_API_PORT:-3101}" \
    SRC="${SRC:-AC Power}" BATT="${BATT:-80%; charging; present: true}" SD="${SD:-0}" \
    ARGOSTATUS="${ARGOSTATUS:-}" LEVEL="${LEVEL:-1}" FREE="${FREE:-50}" SWAPUSED="${SWAPUSED:-1000}" OLD_ARGO="${OLD_ARGO:-}" bash "$SCRIPT" "$@"
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
  *boottime*) echo "{ sec = ${BOOT:-1000}, usec = 5 } Thu Oct 22 01:01:27 2026" ;;
  *) echo "total = 6144.00M  used = ${SWAPUSED:-1000}.00M  free = 0.00M  (encrypted)" ;;
esac'
LEVEL=1 SWAPUSED=3000 run awake guard
[ -z "$(alerts)" ]; expect "healthy memory: no alerts" $?

# Disk (seen on the dev Mac: 5 GB free with 5 GB of swap)
DISKGB=5 run awake guard
[ "$(alerts)" = "disk-low" ]; expect "5 GB free disk: alert; a cleanup that frees nothing is not claimed" $?
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
out=$(run dev "$FBDIR" 2>&1); [[ "$out" == *"is the fallback checkout"* ]]; expect "dev refuses the fallback checkout (path with a space)" $?
for _ in 1 2; do HEALTH=000 LOADED="$B uk.lightbound.gauss-frontend" run awake guard; done
[ "$(kicked)" = "bootout $B bootout uk.lightbound.gauss-frontend bootout uk.lightbound.gauss-fallback-backend bootstrap uk.lightbound.gauss-fallback-backend bootout uk.lightbound.gauss-fallback-frontend bootstrap uk.lightbound.gauss-fallback-frontend" ] \
  && [ "$(alerts)" = "fallback" ] && [ -f "$FB/active" ]
expect "out of restarts and still down: fails over to the fallback and texts the phone" $?
out=$(LOADED="$B" run status); [[ "$out" == *"fallback serving from fallback since"* ]]; expect "status shows the fallback is serving" $?
for _ in 1 2; do HEALTH=000 LOADED="$B" run awake guard; done
[ "$(kicked)" = "uk.lightbound.gauss-fallback-backend uk.lightbound.gauss-fallback-frontend" ]; expect "on fallback: the guard restarts the fallback, never fails over again" $?
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
  case "$2" in
    test:ops) echo "gauss-services: 99 passed, 0 failed"; echo "ok  	argo	1.0s" ;;
    test) if [ "$GATEFAIL" = test ]; then printf "ℹ tests 5\nℹ pass 4\nℹ fail 1\n"; else printf "ℹ tests 5\nℹ pass 5\nℹ fail 0\n"; fi ;;
    verify) echo "▶ VCRM: 40/40 requirements verified"; echo "▶ FMEA: 12/14 failure modes mitigated"; echo "✅ VERIFY PASSED at $(git rev-parse --short HEAD)" ;;
  esac
  [ "$GATEFAIL" != "$2" ]; exit
fi
echo "npm $*" >>"$ACTIONS"; mkdir -p node_modules'
g() { git -C "$LIVE" -c user.email=t@t -c user.name=t "$@"; }
head_is() { [ "$(g rev-parse HEAD)" = "$1" ]; }
mkdir -p "$LIVE/data/bedrock" "$LIVE/node_modules"
printf 'node_modules/\nfrontend/dist/\n' >"$LIVE/.gitignore"
echo 200 >"$LIVE/health"; echo a >"$LIVE/package-lock.json"; echo t0 >"$LIVE/data/bedrock/telemetry.jsonl"
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
out=$(run deploy "$Bc" "$FB2" 2>&1); rc=$?
[ $rc = 0 ] && head_is "$Bc" && [[ "$out" == *"Deployed ${Bc:0:7}"* ]] && grep -q t1 "$LIVE/data/bedrock/telemetry.jsonl" && [ ! -d "$WD/deploying" ]
expect "deploy: live switched, its local data kept, lock released" $?
[[ "$(cat "$FB/ready")" == "$A $FB2 "* ]] && [ "$(grep -c '^npm ci' "$T/actions")" = 1 ]
expect "deploy: fallback refreshed to the previous version; npm ci only for the new fallback (live's lockfile unchanged)" $?
out=$(run deploy "$C" 2>&1); rc=$?
[ $rc = 1 ] && head_is "$Bc" && [[ "$out" == *"Rolled back: live is on ${Bc:0:7}"* ]] && [ "$(alerts)" = "deploy" ] && [[ "$(cat "$FB/ready")" == "$Bc $FB2 "* ]]
expect "deploy of a bad commit: rolls back by itself and texts the phone; fallback is the last good one" $?
grep -q "${C:0:7} failed, rolled back to ${Bc:0:7}" "$T/home/Library/Logs/gauss/deploy.log"; expect "deploy log records the rollback" $?
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
out=$(run deploy "$D" --emergency 2>&1); [ $? = 2 ] && [[ "$out" == *"needs a reason"* ]]; expect "--emergency needs a reason" $?

# gates record: the five gates on a clean checkout (path with a space), recorded by tree
GW="$T/gates checkout"; git clone -q "$LIVE" "$GW"; git -C "$GW" checkout -q --detach "$D"; mkdir -p "$GW/node_modules"
rec="$WD/gates/$(g rev-parse "$D^{tree}").json"; rm -f "$rec"
out=$(run gates record "$GW" 2>&1); rc=$?
[ $rc = 0 ] && [[ "$out" == *"PASSED ${D:0:7}"*"npm test 5/5, test:ops 99 passed, build ok, quality ok, VCRM 40/40, FMEA 12/14"* ]] \
  && python3 -Ic 'import json,sys; r=json.load(open(sys.argv[1])); sys.exit(0 if r["passed"] and r["sha"]==sys.argv[2] and r["by"]=="test-user" and r["test_ops"]["go_ok"]==1 else 1)' "$rec" "$D"
expect "gates record: runs the five gates and records the counts by tree" $?
[ ! -d "$T/home/.local/state/gauss-gate.lock" ]; expect "gates record releases the shared gate lock" $?
out=$(run gates); [[ "$out" == *"PASSED ${D:0:7}"* ]]; expect "gates lists the records" $?
out=$(GATEFAIL=test run gates record "$GW" 2>&1); rc=$?
[ $rc != 0 ] && [[ "$out" == *"FAILED (test) ${D:0:7}"* ]] && ! python3 -Ic 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["passed"] else 1)' "$rec"
expect "gates record: a failing gate is recorded as FAILED, so the tree can't be deployed" $?
touch "$GW/stray"; out=$(run gates record "$GW" 2>&1); [[ "$out" == *"uncommitted or untracked"* ]]; expect "gates record refuses a dirty checkout" $?
rm -f "$GW/stray"

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
SRC="Battery Power" BATT="18%; discharging; present: true" run awake guard
[ -f "$PAUSED" ] && [ "$(alerts)" = "battery-low" ]; expect "battery 18%: learning paused quietly (log only)" $?
grep -q "paused nightly learning" "$T/home/Library/Logs/gauss/balance.log"; expect "balance logs what it did" $?
SRC="Battery Power" BATT="25%; discharging; present: true" run awake guard
[ -f "$PAUSED" ]; expect "battery 25%: still paused (hysteresis to warn+10)" $?
SRC="AC Power" BATT="26%; charging; present: true" run awake guard
[ ! -f "$PAUSED" ]; expect "back on AC: learning resumed" $?
DISKGB=5 run awake guard
[ -z "$(acts)" ] && [ "$(alerts)" = "disk-low" ]; expect "disk 5 GB again within the hour: no second cleanup" $?
rm -f "$T/home/Library/Application Support/Gauss/balance-cleanup"
DISKGB=5 run awake guard
[ "$(acts)" = "disk-cleanup --apply --if-below 8" ]; expect "disk 5 GB, an hour later: allowlisted cleanup runs" $?
MLX=1 LEVEL=4 GAUSS_BALANCE=0 run awake guard
[ -z "$(acts)" ]; expect "GAUSS_BALANCE=0: balance does nothing" $?
out=$(MLX=1 LEVEL=4 run balance --dry-run)
[ -z "$(acts)" ] && [[ "$out" == *"would: pkill -f mlx_lm.server.*--port 8089"* ]]; expect "balance --dry-run only reports" $?
out=$(run balance --dry-run)
[[ "$out" == "balanced: nothing to do"* ]]; expect "healthy machine: nothing to do" $?

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
out=$(run events --since 2h); [[ "$out" == *"watchdog_kick"*"uk.lightbound.argo"*"[live"* && "$out" == *"boot"* ]]; expect "events --since 2h: readable timeline" $?
out=$(run events --json --since 1d); [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" = "$(wc -l <"$EV" | tr -d ' ')" ]; expect "events --json: raw lines" $?
out=$(run events --since 2x 2>&1); [ $? = 2 ] && [[ "$out" == *"30m, 2h or 1d"* ]]; expect "events: bad --since is refused" $?

# Rotation by size: one old file kept
lines=$(wc -l <"$EV" | tr -d ' ')
GAUSS_EVENTS_MAX_KB=1 run awake guard >/dev/null; LEVEL=4 GAUSS_EVENTS_MAX_KB=1 run fallback off >/dev/null
[ "$(wc -l <"$EV.1" | tr -d ' ')" -ge "$lines" ] && [ "$(wc -l <"$EV" | tr -d ' ')" = 1 ]; expect "events.jsonl rotates by size into events.jsonl.1" $?
out=$(run events --json --since 1d); [ "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" -gt 1 ]; expect "events reads the rotated file too" $?

echo "gauss-services: $pass passed, $failed failed"
[ "$failed" = 0 ]
