#!/bin/bash
# Tests for the Talos kit (scripts/ops/talos). bootstrap.sh runs for real against a fake machine:
# HOME is a temp dir, /proc, /sys and /etc come from a fake root, and tailscale, sudo, systemctl,
# go, uname, nproc and id are stubs on a PATH that holds nothing else but basic tools. git is the
# real git, pointed at a local copy of "GitHub" (insteadOf), with a wrapper that can drop fetches.
# Nothing here uses sudo, a network, Tailscale or the real ~/.local/bin/argo.
#   bash scripts/ops/talos/talos-kit.test.sh
#   GAUSS_OPS_JUNIT=<file> also writes a JUnit report, one case per expect, named as the expect.
# This proves the script's logic, not that it works on a real Linux laptop (UNVERIFIED).
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
JUNIT="${GAUSS_OPS_JUNIT:-}"; [ -z "$JUNIT" ] || . "$D/../junit.sh"
B="$D/bootstrap.sh"; U="$D/systemd/gauss-argo.service"; FIX="$D/../../../tools/argo/testdata/power_supply"
URL="https://github.com/Pallas117/Constellation.git"
T=$(cd "$(mktemp -d)" && pwd -P); trap 'rm -rf "$T"' EXIT
pass=0; failed=0
expect() { # expect <name> <condition-exit-code>
  if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  ✓ $1"; else failed=$((failed + 1)); echo "  ✗ $1"; fi
  [ -z "$JUNIT" ] || junit_case "$1" "$2"
}
has() { grep -q -- "$1" "$2"; }

# --- the fake machine ---
mkdir -p "$T/bin" "$T/sys" "$T/home" "$T/units" "$T/root/etc" "$T/root/proc" "$T/root/sys/class"
REALGIT=$(command -v git); BASH_BIN=$(command -v bash)
for t in sed awk grep tr df mkdir chmod mv rm cmp ls basename python3 sleep env cat cp; do
  p=$(command -v "$t") && ln -s "$p" "$T/sys/$t"
done
stub() { printf '#!/bin/bash\n%s\n' "$2" >"$T/bin/$1"; chmod +x "$T/bin/$1"; }
stub uname 'case "$1" in -s) echo Linux ;; -sr) echo "Linux 6.12.0-test" ;; -m) echo x86_64 ;; esac'
stub nproc 'echo 8'
stub id 'case "$1" in -u) echo "${FAKE_UID:-501}" ;; -un) echo tester ;; esac'
stub tailscale 'case "$1 ${2:-}" in
  "status --json") printf "{\"BackendState\":\"%s\",\"CurrentTailnet\":{\"Name\":\"%s\"},\"Self\":{\"UserID\":7,\"HostName\":\"talos\",\"TailscaleIPs\":[\"100.64.0.9\"]},\"User\":{\"7\":{\"LoginName\":\"%s\"}}}\n" "${TS_STATE:-Running}" "${TS_TAILNET:-example.org}" "${TS_LOGIN:-pilot@example.org}" ;;
  "debug prefs") echo "\"RunSSH\": ${TS_SSH:-false}," ;;
  *) echo "$*" >>"$LOGS/tailscale-changes"; exit 1 ;;
esac'
stub go 'case "$1" in
  version) echo "go version go1.26.10 linux/amd64" ;;
  build) echo "build in $PWD: $*" >>"$LOGS/go"; [ -z "${GO_FAIL:-}" ] || exit 1
         while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
         printf "#!/bin/sh\necho fake argo %s\n" "$(cat "$LOGS/build-id" 2>/dev/null)" >"$out"; chmod +x "$out" ;;
esac'
stub systemctl 'echo "$*" >>"$LOGS/systemctl"
case "$1" in is-enabled|is-active) [ -e "$LOGS/unit-on" ] ;; enable) : >"$LOGS/unit-on" ;; esac'
stub sudo 'echo "$*" >>"$LOGS/sudo"
case "$1" in install) for a in "$@"; do src="${dst:-}"; dst="$a"; done; cp "$src" "$dst" ;; systemctl) "$@" ;; *) exit 1 ;; esac'
# git: the real one, with GitHub rewritten to the local origin; DROP holds how many fetches still fail.
stub git 'echo "$*" >>"$LOGS/git"
case " $* " in *" fetch "*) n=$(cat "$LOGS/drop" 2>/dev/null || echo 0); if [ "$n" -gt 0 ]; then echo $((n - 1)) >"$LOGS/drop"; echo "fatal: unable to access (stub: link dropped)" >&2; exit 128; fi ;; esac
exec "$REALGIT" -c "url.file://$ORIGIN.insteadOf='"$URL"'" "$@"'

printf 'PRETTY_NAME="Kali GNU/Linux Rolling"\nID=kali\n' >"$T/root/etc/os-release"
printf 'MemTotal:       16303120 kB\nMemAvailable:   12000000 kB\n' >"$T/root/proc/meminfo"
power() { rm -rf "$T/root/sys/class/power_supply"; cp -R "$FIX/$1" "$T/root/sys/class/power_supply"; }
power weak-charger

# "GitHub": main has two commits (the second adds nothing the kit needs); side is not on main.
export ORIGIN="$T/origin.git" LOGS="$T/logs"; mkdir -p "$LOGS"
gq() { "$REALGIT" -c user.name=t -c user.email=t@example.org -c commit.gpgsign=false -c init.defaultBranch=main "$@"; }
gq init -q "$T/seed"; mkdir -p "$T/seed/tools/argo" "$T/seed/scripts/ops/talos/systemd"
printf 'module example\n\ngo 1.26\n\ntoolchain go1.26.10\n' >"$T/seed/tools/argo/go.mod"
cp "$U" "$T/seed/scripts/ops/talos/systemd/"
gq -C "$T/seed" add -A && gq -C "$T/seed" commit -qm one; SHA1=$(gq -C "$T/seed" rev-parse HEAD)
echo two >"$T/seed/two.txt"; gq -C "$T/seed" add -A && gq -C "$T/seed" commit -qm two; SHA2=$(gq -C "$T/seed" rev-parse HEAD)
gq -C "$T/seed" checkout -qb side; echo x >"$T/seed/side.txt"; gq -C "$T/seed" add -A && gq -C "$T/seed" commit -qm side; SIDE=$(gq -C "$T/seed" rev-parse HEAD)
gq -C "$T/seed" checkout -q main; gq clone -q --bare "$T/seed" "$ORIGIN"

HOME_DIR="$T/home"; REPO="$T/home/src/Constellation"; ARGO="$T/home/.local/bin/argo"
bs() { # run bootstrap.sh on the fake machine; output in $out, exit code in $rc
  out=$(env -i HOME="$HOME_DIR" PATH="$T/bin:$T/sys" LOGS="$LOGS" ORIGIN="$ORIGIN" REALGIT="$REALGIT" \
    TALOS_KIT_SYSROOT="$T/root" TALOS_KIT_UNIT_DIR="$T/units" TALOS_KIT_FETCH_TRIES=3 TALOS_KIT_FETCH_WAIT=0 \
    FAKE_UID="${FAKE_UID:-}" TS_STATE="${TS_STATE:-}" TS_TAILNET="${TS_TAILNET:-}" TS_LOGIN="${TS_LOGIN:-}" TS_SSH="${TS_SSH:-}" GO_FAIL="${GO_FAIL:-}" \
    "$BASH_BIN" "$B" "$@" 2>&1); rc=$?
}
tree() { (cd "$T" && find home units logs | sort; cat logs/* 2>/dev/null); }
OK=(--tailnet-login pilot@example.org)

# --- usage and refusals that happen before anything is touched ---
before=$(tree)
bs; [ "$rc" = 1 ] && [[ "$out" == *"--tailnet-login is required"* ]]; expect "talos bootstrap needs the expected tailnet login" $?
bs "${OK[@]}" --commit abc123; [ "$rc" = 1 ]; expect "talos bootstrap refuses a short commit sha" $?
bs --tailnet-login 'a b;rm' ; [ "$rc" = 1 ]; expect "talos bootstrap refuses a login with shell characters" $?
bs "${OK[@]}" --dir relative/path; [ "$rc" = 1 ]; expect "talos bootstrap refuses a relative --dir" $?
bs "${OK[@]}" --nope; [ "$rc" = 1 ]; expect "talos bootstrap refuses an unknown option" $?
FAKE_UID=0 bs "${OK[@]}" --install-service; [ "$rc" = 1 ] && [[ "$out" == *"do not run this as root"* ]]; expect "talos bootstrap refuses to run as root" $?
bs --help; [ "$rc" = 0 ] && [[ "$out" == *"--dry-run"* && "$out" == *"--install-service"* ]]; expect "talos bootstrap --help documents --dry-run and --install-service" $?

# --- dry run ---
bs "${OK[@]}" --install-service --dry-run
[ "$rc" = 0 ] && [ "$(printf '%s\n' "$out" | grep -c '^==> [1-5]/5 ')" = 5 ]; expect "talos bootstrap --dry-run exits 0 and lists all five steps" $?
[ "$(tree)" = "$before" ]; expect "talos bootstrap --dry-run changes nothing: no files, no git, go, sudo, systemctl or tailscale calls" $?
[[ "$out" == *"sudo: install -m 0644 -o root -g root"* && "$out" == *"sudo: systemctl enable --now gauss-argo.service"* ]]; expect "talos bootstrap --dry-run prints each sudo command it would run" $?
[[ "$out" == *"Kali GNU/Linux Rolling"* && "$out" == *"15.5 GB"* && "$out" == *"cores     8"* && "$out" == *"BAT0: 41% Discharging"* ]]; expect "talos bootstrap prints OS, RAM, cores and battery from /proc and /sys" $?
[[ "$out" == *"PLUGGED IN BUT DISCHARGING"* ]]; expect "talos bootstrap says when the laptop discharges on a charger" $?
[[ "$out" == *"charge limit: not offered by this hardware or driver"* ]]; expect "talos bootstrap never assumes a charge limit the hardware lacks" $?
power charge-limit; bs "${OK[@]}" --dry-run
[[ "$out" == *"charge limit: offered, now 80%"* && "$out" != *"PLUGGED IN BUT DISCHARGING"* ]]; expect "talos bootstrap reports a charge limit where the file exists" $?
TS_TAILNET=other.example TS_LOGIN=someone@other.example bs "${OK[@]}" --dry-run
[ "$rc" = 0 ] && [[ "$out" == *"REFUSED"* && "$out" == *"a real run stops here with exit 4"* && "$out" == *"4/5 Argo"* ]]; expect "talos bootstrap --dry-run reports a wrong tailnet and still shows the remaining steps" $?
[ "$(tree)" = "$before" ]; expect "talos bootstrap --dry-run on a wrong tailnet still changes nothing" $?

# --- Tailscale: missing, logged out, wrong tailnet ---
mv "$T/bin/tailscale" "$T/tailscale.off"; bs "${OK[@]}"; mv "$T/tailscale.off" "$T/bin/tailscale"
[ "$rc" = 3 ] && [[ "$out" == *"https://tailscale.com/install.sh"* && "$out" == *"official installer"* ]]; expect "talos bootstrap without Tailscale stops and points to the official installer for the human" $?
TS_STATE=NeedsLogin bs "${OK[@]}"; [ "$rc" = 3 ] && [[ "$out" == *"sudo tailscale up"* ]]; expect "talos bootstrap on a logged-out Tailscale stops and prints the join command" $?
TS_TAILNET=other.example TS_LOGIN=someone@other.example bs "${OK[@]}" --install-service
[ "$rc" = 4 ] && [[ "$out" == *"REFUSED"*"other.example"* && "$out" == *"sudo tailscale logout"* && "$out" == *"sign in as pilot@example.org"* ]]; expect "talos bootstrap refuses the wrong tailnet and prints exactly what to run" $?
[ ! -e "$REPO" ] && [ ! -e "$ARGO" ] && [ ! -e "$LOGS/sudo" ] && [ ! -e "$LOGS/git" ] && [ ! -e "$LOGS/go" ]; expect "talos bootstrap on the wrong tailnet fetches, builds and installs nothing" $?
[[ "$out" == *"forced command"* ]]; expect "talos bootstrap carries the gatebox --ssh caveat next to the join command" $?

# --- a dropped connection, then the same command again ---
echo 9 >"$LOGS/drop"; bs "${OK[@]}" --commit "$SHA1"
[ "$rc" = 5 ] && [[ "$out" == *"attempt 2 of 3"* && "$out" == *"run the same command again"* ]] && [ ! -e "$ARGO" ]; expect "talos bootstrap retries a dropped fetch, then stops with nothing built" $?
echo 2 >"$LOGS/drop"; bs "${OK[@]}" --commit "$SHA1"
[ "$rc" = 0 ] && [[ "$out" == *"fetch failed (attempt 1 of 3)"* ]] && [ "$("$REALGIT" -C "$REPO" rev-parse HEAD)" = "$SHA1" ]; expect "talos bootstrap resumes after a dropped connection and lands on the requested commit" $?
[[ "$out" == *"verified: "*"$SHA1 (on origin/main)"* ]] && [ "$(cat "$T/home/.local/state/talos-kit/argo.sha")" = "$SHA1" ] && [ -x "$ARGO" ]; expect "talos bootstrap verifies the commit is on origin/main and builds Argo from it" $?
[ "$("$REALGIT" -C "$REPO" config --get remote.origin.url)" = "$URL" ]; expect "talos bootstrap clones the public repo over https only" $?
has 'GOTOOLCHAIN=local' "$B" && grep -q "build in $REPO/tools/argo: build -trimpath -o $ARGO.new" "$LOGS/go"; expect "talos bootstrap builds in tools/argo with the local toolchain and swaps the binary in one rename" $?
[ ! -e "$LOGS/sudo" ] && [ ! -e "$LOGS/systemctl" ] && [ ! -e "$T/units/gauss-argo.service" ]; expect "talos bootstrap without --install-service never calls sudo or systemctl" $?
has 'ram       15.5 GB' "$T/home/.local/state/talos-kit/facts.txt"; expect "talos bootstrap saves the machine facts for the Mac to fetch" $?

# --- idempotent ---
builds=$(wc -l <"$LOGS/go"); bs "${OK[@]}" --commit "$SHA1"
[ "$rc" = 0 ] && [[ "$out" == *"already built from $SHA1"* ]] && [ "$(wc -l <"$LOGS/go")" = "$builds" ]; expect "talos bootstrap re-run is idempotent: same commit, no rebuild" $?
TS_TAILNET=pilot-net.example TS_LOGIN=Other@Example.org bs --tailnet-login PILOT-net.example --commit "$SHA1"; [ "$rc" = 0 ]; expect "talos bootstrap accepts the tailnet name as well as the login, in any case" $?

# --- commits that must be refused ---
bs "${OK[@]}" --commit "$SIDE"; [ "$rc" = 5 ] && [ "$("$REALGIT" -C "$REPO" rev-parse HEAD)" = "$SHA1" ]; expect "talos bootstrap refuses a commit that is not on origin/main" $?
bs "${OK[@]}" --commit 0123456789abcdef0123456789abcdef01234567; [ "$rc" = 5 ]; expect "talos bootstrap refuses a commit GitHub does not have" $?
echo local >"$REPO/two.txt.local"; bs "${OK[@]}"; rm "$REPO/two.txt.local"
[ "$rc" = 5 ] && [[ "$out" == *"local changes"* ]] && [ "$("$REALGIT" -C "$REPO" rev-parse HEAD)" = "$SHA1" ]; expect "talos bootstrap leaves a checkout with local changes alone" $?
"$REALGIT" -C "$REPO" config remote.origin.url https://example.com/evil.git; bs "${OK[@]}"; "$REALGIT" -C "$REPO" config remote.origin.url "$URL"
[ "$rc" = 5 ] && [[ "$out" == *"different origin"* ]]; expect "talos bootstrap refuses a checkout whose origin is not the public repo" $?

# --- update, and a failed build keeps the old binary ---
echo OLD >"$LOGS/build-id"; rm "$T/home/.local/state/talos-kit/argo.sha"; bs "${OK[@]}" --commit "$SHA1"; old=$(cat "$ARGO")
GO_FAIL=1 bs "${OK[@]}"; [ "$rc" = 6 ] && [ "$(cat "$ARGO")" = "$old" ] && [ ! -e "$ARGO.new" ]; expect "talos bootstrap keeps the old Argo when the new build fails" $?
echo NEW >"$LOGS/build-id"; bs "${OK[@]}"
[ "$rc" = 0 ] && [[ "$out" == *"UNVERIFIED: compare this sha"* ]] && [ "$("$REALGIT" -C "$REPO" rev-parse HEAD)" = "$SHA2" ] && grep -q NEW "$ARGO"; expect "talos bootstrap without --commit moves to the newest main, says it is unverified, and rebuilds" $?

# --- the service ---
bs "${OK[@]}" --install-service
[ "$rc" = 0 ] && [ "$(wc -l <"$LOGS/sudo" | tr -d ' ')" = 3 ] && has '^install -m 0644 -o root -g root ' "$LOGS/sudo" && has '^systemctl daemon-reload$' "$LOGS/sudo" && has '^systemctl enable --now gauss-argo.service$' "$LOGS/sudo"; expect "talos bootstrap --install-service runs exactly three sudo commands: install, daemon-reload, enable" $?
ok=0; while read -r line; do [[ "$out" == *"sudo: $line"* ]] || ok=1; done <"$LOGS/sudo"; expect "talos bootstrap prints every sudo command it runs" $ok
I="$T/units/gauss-argo.service"
has '^User=tester$' "$I" && has "^ExecStart=$HOME_DIR/.local/bin/argo loop$" "$I" && ! grep -q '@' "$I"; expect "talos unit is installed for the non-root user who ran the bootstrap" $?
bs "${OK[@]}" --install-service
[ "$rc" = 0 ] && [ "$(wc -l <"$LOGS/sudo" | tr -d ' ')" = 3 ] && [[ "$out" == *"nothing to do"* ]]; expect "talos bootstrap --install-service re-run is idempotent: no further sudo" $?
rm "$T/home/.local/state/talos-kit/argo.sha"; bs "${OK[@]}" --install-service
[ "$rc" = 0 ] && [ "$(tail -n1 "$LOGS/sudo")" = "systemctl restart gauss-argo.service" ]; expect "talos bootstrap restarts the service after it rebuilds Argo" $?
mv "$T/bin/go" "$T/go.off"; HOME_DIR="$T/home2"; mkdir -p "$HOME_DIR"; n=$(wc -l <"$LOGS/sudo")
bs "${OK[@]}"; r1=$rc; o1=$out; bs "${OK[@]}" --install-service; mv "$T/go.off" "$T/bin/go"
[ "$r1" = 0 ] && [[ "$o1" == *"Go is not installed"*"1.26.10"*"https://go.dev/dl/"* ]] && [ "$rc" = 6 ] && [ "$(wc -l <"$LOGS/sudo")" = "$n" ]; expect "talos bootstrap without Go says what is missing and installs no service" $?
[ ! -e "$LOGS/tailscale-changes" ]; expect "talos bootstrap never ran a Tailscale command other than status and debug prefs" $?

# --- the unit template and the kit as text ---
has '^ExecStart=@HOME@/.local/bin/argo loop$' "$U" && has '^User=@USER@$' "$U" && ! grep -qE '^User=root|^User=$' "$U"; expect "talos unit runs argo loop as a non-root user" $?
has '^Restart=on-failure$' "$U" && has '^RestartSec=' "$U" && has '^StartLimitIntervalSec=0$' "$U"; expect "talos unit restarts on failure and never gives up" $?
bad=""; for k in NoNewPrivileges=true ProtectSystem=strict ProtectHome=read-only PrivateTmp=true CapabilityBoundingSet= RestrictSUIDSGID=true MemoryMax=; do has "^$k" "$U" || bad="$bad $k"; done
[ -z "$bad" ]; expect "talos unit is hardened: NoNewPrivileges, ProtectSystem=strict, read-only home, no capabilities, memory cap" $?
has '^ReadWritePaths=@HOME@/.local/state/argo @HOME@/.config/argo$' "$U"; expect "talos unit may write only Argo's state and config" $?
! grep -rIEn 'tskey-(auth|api|client)-[A-Za-z0-9]{6,}|BEGIN [A-Z ]*PRIVATE KEY|--auth-?key' "$D" --exclude=talos-kit.test.sh >/dev/null; expect "talos kit contains no keys, tokens or auth-key options" $?
! grep -rIEn 'curl +(-[A-Za-z]*k|--insecure)|InsecureSkipVerify|NODE_TLS_REJECT_UNAUTHORIZED|--no-check-certificate|sslVerify' "$D" --exclude=talos-kit.test.sh >/dev/null; expect "talos kit never weakens TLS verification" $?
! { grep -Ev '^ *(#|note )' "$B" | grep -E '(curl|wget)[^|]*\| *(ba)?sh|tailscale +(up|login|logout|set|serve|funnel)'; } >/dev/null; expect "talos bootstrap only prints the installer and tailscale commands, never runs them" $?
R="$D/README.md"
has 'tailscale ping' "$R" && has 'tailscale ssh' "$R" && has 'known_hosts' "$R" && has 'forced command' "$R" && has 'UNVERIFIED' "$R" && has '\.auth\.db' "$R" && has 'charge_control_end_threshold' "$R"; expect "talos README covers verification from the Mac, the --ssh caveat, what is unverified and what must not be copied" $?

O="$D/ollama-override.conf"
python3 - "$O" <<'PY'
import configparser, sys
c = configparser.ConfigParser(strict=False, interpolation=None); c.optionxform = str
c.read(sys.argv[1])
env = [l.strip() for l in open(sys.argv[1]) if l.startswith('Environment=')]
want = ['Environment="OLLAMA_KEEP_ALIVE=30m"', 'Environment="OLLAMA_CONTEXT_LENGTH=8192"', 'Environment="OLLAMA_NUM_PARALLEL=1"']
sys.exit(0 if c.sections() == ['Service'] and env == want else 1)
PY
expect "talos ollama drop-in parses: one [Service] section with keep-alive 30m, context 8192, one parallel request" $?
! grep -qE '^(ExecStart|User|ExecStartPre)=|OLLAMA_HOST' "$O"; expect "talos ollama drop-in changes no command, user or listen address" $?
has 'sudo install -m 0644 -o root -g root scripts/ops/talos/ollama-override.conf' "$R" && has 'NVIDIA driver (Josh only)' "$R" && has 'mokutil --sb-state' "$R" && has 'No script or agent reboots Talos' "$R"; expect "talos README has the Josh-run Ollama install steps and the NVIDIA driver cautions" $?
! grep -rIEn '(^|[^#a-z])(reboot|shutdown|systemctl +(reboot|poweroff))' "$B" >/dev/null; expect "talos bootstrap never reboots" $?

# --- static checks ---
if command -v shellcheck >/dev/null; then shellcheck -S warning "$B" "$0"; expect "talos scripts are shellcheck-clean" $?
else bash -n "$B" && bash -n "$0"; expect "talos scripts parse (shellcheck not installed here, UNVERIFIED lint)" $?; fi

[ -z "$JUNIT" ] || junit_write talos-kit "$JUNIT"
echo "talos-kit: $pass passed, $failed failed"
[ "$failed" = 0 ]
