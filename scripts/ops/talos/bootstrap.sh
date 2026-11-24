#!/usr/bin/env bash
# Bring a Linux laptop ("Talos") into service from its own keyboard. Pull model: it needs no
# inbound SSH, no tokens and no auth keys. Run it as your normal user, NOT as root.
#
#   bash bootstrap.sh --tailnet-login NAME [--commit SHA] [--dir DIR] [--install-service] [--dry-run]
#   bash bootstrap.sh [--tailnet-login NAME ...] --profile ops [--apply-profile] [--no-bluetooth] [--dry-run]
#
#   --tailnet-login NAME  the Tailscale login (you@example.com) or tailnet name this machine must be
#                         on. Anything else is refused, with the commands to fix it.
#   --commit SHA          full 40-character commit to check out. It must be on origin/main. Without
#                         it the newest origin/main is used and printed (compare it yourself).
#   --dir DIR             where the public repo lives (default ~/src/Constellation)
#   --install-service     also install and start the systemd unit that runs `argo loop`. This is the
#                         only part that uses sudo; every sudo command is printed before it runs.
#   --profile ops         shape the machine for gate and dev work (ops-profile.sh: services, power,
#                         self-restart, sshd keys only, journald, zram, tool check). Without
#                         --tailnet-login only the profile runs (first boot, no network needed).
#                         It reports what it would change and changes nothing unless also
#   --apply-profile       is given: then it uses sudo, printing every command first.
#   --no-bluetooth        with --profile ops: also disable bluetooth.
#   --dry-run             print every action, change nothing (works on any OS)
#
# What it does, in order. Every step is safe to re-run; after a dropped connection run the same
# command again and it carries on (git cannot resume half a download, so that part starts over):
#   1. machine facts: OS, CPU, RAM, disk, battery, charger, charge limit, lid setting
#   2. Tailscale: installed? logged in? on the expected tailnet? It never runs `tailscale up`,
#      `login`, `logout` or `set`: it prints what you should run.
#   3. the public repo over https at a commit it verifies (on origin/main, HEAD equals it)
#   4. builds tools/argo into ~/.local/bin/argo if Go is installed (else says what is missing)
#   5. only with --install-service: the systemd unit (systemd/gauss-argo.service)
#   then, only with --profile ops: ops-profile.sh from the same checkout
#
# Exit: 0 done · 1 refused or bad usage · 3 Tailscale missing or logged out · 4 wrong tailnet ·
#       5 repo could not be fetched or verified · 6 build or service step failed ·
#       7 a profile step failed (the others still ran)
# UNTESTED ON A REAL LINUX HOST (18 Nov 2026): only run against stubs (talos-kit.test.sh).
set -euo pipefail

# Everything lives in main() so bash has read the whole file before step 3 may replace it on disk.
main() {
  local REPO_URL="https://github.com/Pallas117/Constellation.git" # fixed: no --repo option
  local UNIT=gauss-argo.service
  local LOGIN="" COMMIT="" DIR="$HOME/src/Constellation" INSTALL=0 DRY=0 PROFILE="" PAPPLY=0 NOBT=0
  # Test hooks (talos-kit.test.sh): a fake / for the files that are read, and the unit directory.
  local ROOT="${TALOS_KIT_SYSROOT:-}" UNIT_DIR="${TALOS_KIT_UNIT_DIR:-/etc/systemd/system}"
  local TRIES="${TALOS_KIT_FETCH_TRIES:-5}" WAIT="${TALOS_KIT_FETCH_WAIT:-15}"
  local STATE="$HOME/.local/state/talos-kit" BIN="$HOME/.local/bin/argo"

  say() { printf '==> %s\n' "$*"; }
  note() { printf '    %s\n' "$*"; }
  die() { local rc="$1"; shift; printf 'talos bootstrap: %s\n' "$*" >&2; exit "$rc"; }
  usage() { sed -n '2,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
  # run: the one place a changing command executes. A dry run only prints it.
  run() { if [ "$DRY" = 1 ]; then printf '    + %s\n' "$*"; else "$@"; fi; }
  # sudo_run: always printed first, so nothing happens as root that was not shown.
  sudo_run() { printf '    sudo: %s\n' "$*"; [ "$DRY" = 1 ] || sudo "$@"; }
  first_line() { [ -r "$1" ] && sed -n 1p "$1" 2>/dev/null | tr -d '\r' || true; }

  while [ $# -gt 0 ]; do
    case "$1" in
      --tailnet-login) [ $# -ge 2 ] || die 1 "--tailnet-login needs a value"; LOGIN="$2"; shift ;;
      --commit) [ $# -ge 2 ] || die 1 "--commit needs a value"; COMMIT="$2"; shift ;;
      --dir) [ $# -ge 2 ] || die 1 "--dir needs a value"; DIR="$2"; shift ;;
      --install-service) INSTALL=1 ;;
      --profile) [ $# -ge 2 ] || die 1 "--profile needs a value"; PROFILE="$2"; shift ;;
      --apply-profile) PAPPLY=1 ;;
      --no-bluetooth) NOBT=1 ;;
      --dry-run) DRY=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die 1 "unknown option: $1 (try --help)" ;;
    esac
    shift
  done
  [ -z "$PROFILE" ] || [ "$PROFILE" = ops ] || die 1 "unknown profile: $PROFILE (the only one is ops)"
  [ -n "$PROFILE" ] || [ "$PAPPLY$NOBT" = 00 ] || die 1 "--apply-profile and --no-bluetooth go with --profile ops"
  [ -n "$LOGIN" ] || [ -n "$PROFILE" ] || die 1 "--tailnet-login is required: the Tailscale login or tailnet this machine must be on"
  [ -z "$LOGIN" ] || [[ "$LOGIN" =~ ^[A-Za-z0-9@._+-]{3,128}$ ]] || die 1 "--tailnet-login has odd characters"
  [ -z "$COMMIT" ] || [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die 1 "--commit must be a full 40-character sha"
  case "$DIR" in /*) ;; *) die 1 "--dir must be an absolute path" ;; esac
  [[ "$DIR" =~ ^[A-Za-z0-9/._-]+$ ]] || die 1 "--dir has odd characters (spaces are not supported)"
  [ "$(id -u)" != 0 ] || die 1 "do not run this as root: run it as your normal user. It asks for sudo itself, only for --install-service and --apply-profile, and prints each command first."
  # ops_profile: the profile script next to this one (after step 3, from the verified commit).
  ops_profile() {
    local kit; kit=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    set --
    if [ "$PAPPLY" = 1 ]; then set -- "$@" --apply; fi
    if [ "$NOBT" = 1 ]; then set -- "$@" --no-bluetooth; fi
    if [ "$DRY" = 1 ]; then set -- "$@" --dry-run; fi
    [ -f "$kit/ops-profile.sh" ] || die 1 "no $kit/ops-profile.sh in this checkout"
    bash "$kit/ops-profile.sh" "$@"
  }
  if [ -z "$LOGIN" ]; then # profile only: no facts, no Tailscale, no repo, no build
    local prc=0; ops_profile || prc=$?
    exit "$prc"
  fi
  local ME; ME=$(id -un)
  if [ "$DRY" = 1 ]; then
    say "DRY RUN: nothing below is changed."
  else
    [ "$(uname -s)" = Linux ] || die 1 "this sets up a Linux machine; on $(uname -s) only --dry-run works"
  fi
  LOGIN=$(printf '%s' "$LOGIN" | tr '[:upper:]' '[:lower:]')

  # --- 1. machine facts (read-only) ------------------------------------------------------
  say "1/5 machine facts"
  local facts
  facts=$(
    os=$( (. "$ROOT/etc/os-release" 2>/dev/null && printf '%s (ID=%s)' "${PRETTY_NAME:-unknown}" "${ID:-unknown}") || echo unknown)
    echo "os        $os"
    echo "kernel    $(uname -sr) $(uname -m)"
    echo "cores     $(nproc 2>/dev/null || echo unknown)"
    kb=$(awk '/^MemTotal:/{print $2}' "$ROOT/proc/meminfo" 2>/dev/null || true)
    if [ -n "$kb" ]; then echo "ram       $(awk -v k="$kb" 'BEGIN{printf "%.1f GB", k/1048576}')"; else echo "ram       unknown"; fi
    echo "disk      $(df -Pk "$HOME" 2>/dev/null | awk 'NR==2{printf "%.0f GB free of %.0f GB on %s", $4/1048576, $2/1048576, $6}')"
    psu="$ROOT/sys/class/power_supply"; online=0; battery=0
    for d in "$psu"/*/; do
      [ -d "$d" ] || continue
      n=$(basename "$d"); t=$(first_line "$d/type")
      case "$t" in # patterns in ( ) so bash 3.2 can parse a case inside $( )
        (Mains|USB)
          o=$(first_line "$d/online"); [ "$o" = 1 ] && online=1
          echo "charger   $n: $([ "$o" = 1 ] && echo online || echo offline)" ;;
        (Battery)
          [ "$(first_line "$d/scope")" = Device ] && continue # a mouse or headset
          battery=1; st=$(first_line "$d/status")
          echo "battery   $n: $(first_line "$d/capacity")% ${st:-unknown}"
          full=$(first_line "$d/energy_full"); design=$(first_line "$d/energy_full_design")
          [ -n "$full" ] || { full=$(first_line "$d/charge_full"); design=$(first_line "$d/charge_full_design"); }
          if [[ "$full" =~ ^[0-9]+$ && "$design" =~ ^[1-9][0-9]*$ ]]; then
            echo "          holds $((full * 100 / design))% of its design capacity, $(first_line "$d/cycle_count") cycles"
          fi
          # The charge limit exists only on some hardware: say so, never assume.
          if [ -e "$d/charge_control_end_threshold" ]; then
            echo "          charge limit: offered, now $(first_line "$d/charge_control_end_threshold")% ($n/charge_control_end_threshold)"
          else
            echo "          charge limit: not offered by this hardware or driver"
          fi
          if [ "$st" = Discharging ]; then echo "__discharging"; fi ;;
      esac
    done
    [ "$battery" = 1 ] || echo "battery   none found (mains only, or not reported)"
    echo "__online=$online"
    lid=$(grep -hs '^HandleLidSwitch' "$ROOT/etc/systemd/logind.conf" "$ROOT"/etc/systemd/logind.conf.d/*.conf 2>/dev/null | tr '\n' ' ' || true)
    echo "lid       ${lid:-systemd default (suspend on lid close, also on mains)}"
  )
  # here-strings, not pipes: under pipefail a reader that quits early can fail the pipeline at random
  if grep -q '^__discharging' <<<"$facts" && grep -q '^__online=1' <<<"$facts"; then
    facts="$facts
power     PLUGGED IN BUT DISCHARGING: this charger cannot carry the machine. Use a stronger one."
  fi
  facts=$(printf '%s\n' "$facts" | grep -v '^__')
  printf '%s\n' "$facts" | sed 's/^/    /'
  if [ "$DRY" = 0 ]; then
    mkdir -p "$STATE"; chmod 700 "$STATE"
    # One run at a time (flock is part of util-linux; without it a second run is merely redundant).
    if command -v flock >/dev/null 2>&1; then exec 9>"$STATE/lock"; flock -n 9 || die 1 "another bootstrap is running"; fi
    printf '%s\n' "$facts" >"$STATE/facts.txt.new" && mv -f "$STATE/facts.txt.new" "$STATE/facts.txt"
    note "saved to $STATE/facts.txt"
  fi

  # --- 2. Tailscale (read-only: this script never changes Tailscale) -----------------------
  say "2/5 Tailscale (expected: $LOGIN)"
  local ts_rc=""
  ts_stop() { # ts_stop <exit code>: a dry run reports and carries on, to show the remaining steps
    if [ "$DRY" = 1 ]; then note "(dry run: a real run stops here with exit $1)"; ts_rc=$1; else exit "$1"; fi
  }
  join_help() {
    note "  sudo tailscale up            # opens a login link: sign in as $LOGIN"
    note "First contact from the Mac is easiest with Tailscale SSH: add --ssh to that command."
    note "Before this machine gets the gate user, turn it off again (sudo tailscale set --ssh=false):"
    note "Tailscale SSH ignores authorized_keys, so the gate user's forced command would not apply."
  }
  if ! command -v tailscale >/dev/null 2>&1; then
    note "Tailscale is not installed. Install it yourself with Tailscale's official installer"
    note "(https://tailscale.com/download/linux):"
    note "  curl -fsSL https://tailscale.com/install.sh | sh"
    note "then join, and run this script again:"
    join_help
    ts_stop 3
  elif ! command -v python3 >/dev/null 2>&1; then
    die 1 "python3 is needed to read Tailscale's status: sudo apt-get install -y python3"
  else
    local state="" tailnet="" login="" host="" ip=""
    # Only these five fields are read, and only characters a name can hold are kept.
    { read -r state; read -r tailnet; read -r login; read -r host; read -r ip; } < <(
      tailscale status --json 2>/dev/null | python3 -I -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
s = d.get("Self") or {}
u = (d.get("User") or {}).get(str(s.get("UserID")), {})
ips = s.get("TailscaleIPs") or [""]
def clean(x):
    return "".join(c for c in str(x or "") if c.isalnum() or c in "@._+:-")[:128].lower()
for v in (d.get("BackendState"), (d.get("CurrentTailnet") or {}).get("Name"), u.get("LoginName"), s.get("HostName"), ips[0]):
    print(clean(v))
' 2>/dev/null || true) || true
    if [ "$state" != running ]; then
      note "Tailscale is installed but not connected (state: ${state:-unknown}). Run:"
      join_help
      ts_stop 3
    elif [ "$login" != "$LOGIN" ] && [ "$tailnet" != "$LOGIN" ]; then
      note "REFUSED: this machine is on tailnet '${tailnet:-unknown}' as '${login:-unknown}', not '$LOGIN'."
      note "It cannot see the other Gauss machines from there. To move it, run:"
      note "  sudo tailscale logout"
      join_help
      ts_stop 4
    else
      note "on tailnet '$tailnet' as '$login': this machine is '$host' at $ip"
      if grep -q '"RunSSH": *true' <<<"$(tailscale debug prefs 2>/dev/null)"; then
        note "Tailscale SSH: ON (fine for first contact; turn it off before adding the gate user)"
      else
        note "Tailscale SSH: off or not readable"
      fi
      note "From the Mac: tailscale ping $host"
    fi
  fi

  # --- 3. the public repo at a verified commit -------------------------------------------
  say "3/5 repo $REPO_URL -> $DIR"
  command -v git >/dev/null 2>&1 || die 5 "git is missing: sudo apt-get install -y git"
  local sha="$COMMIT" have=""
  g() { git -C "$DIR" "$@"; }
  fetch_main() {
    local n=1
    while ! g fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main"; do
      [ "$n" -lt "$TRIES" ] || return 1
      note "fetch failed (attempt $n of $TRIES): the link may have dropped; trying again in ${WAIT}s"
      sleep "$WAIT"; n=$((n + 1))
    done
  }
  if [ "$DRY" = 1 ]; then
    [ -d "$DIR/.git" ] || { run mkdir -p "$DIR"; run git -C "$DIR" init --quiet; run git -C "$DIR" remote add origin "$REPO_URL"; }
    run git -C "$DIR" fetch --quiet origin "+refs/heads/main:refs/remotes/origin/main"
    note "would verify that ${sha:-the newest origin/main} is a commit on origin/main, and refuse a checkout with local changes"
    run git -C "$DIR" checkout --quiet --detach "${sha:-origin/main}"
  else
    # init + fetch instead of clone: each part can be repeated, so a dropped link leaves nothing to clean up.
    if [ ! -d "$DIR/.git" ]; then
      if [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then die 5 "$DIR exists and is not a git checkout: move it away or use --dir"; fi
      mkdir -p "$DIR"; git -C "$DIR" init --quiet
    fi
    have=$(g config --get remote.origin.url || true)
    if [ -z "$have" ]; then g remote add origin "$REPO_URL"
    elif [ "$have" != "$REPO_URL" ]; then die 5 "$DIR has a different origin ($have): not touching it"; fi
    if g rev-parse -q --verify HEAD >/dev/null && [ -n "$(g status --porcelain)" ]; then
      die 5 "$DIR has local changes: commit or remove them first (nothing was changed)"
    fi
    fetch_main || die 5 "could not fetch from GitHub after $TRIES tries. Nothing is half done: run the same command again when the link is back."
    [ -n "$sha" ] || { sha=$(g rev-parse --verify refs/remotes/origin/main); note "no --commit given: using the newest origin/main (UNVERIFIED: compare this sha with the one you expect)"; }
    g cat-file -e "$sha^{commit}" 2>/dev/null || die 5 "commit $sha is not in the public repo's main history"
    g merge-base --is-ancestor "$sha" refs/remotes/origin/main || die 5 "commit $sha is not on origin/main: refused"
    if [ "$(g rev-parse -q --verify HEAD || true)" != "$sha" ]; then g -c advice.detachedHead=false checkout --quiet --detach "$sha"; fi
    [ "$(g rev-parse HEAD)" = "$sha" ] || die 5 "checkout did not land on $sha"
    note "verified: $DIR is at $sha (on origin/main)"
  fi

  # --- 4. build Argo -----------------------------------------------------------------------
  say "4/5 Argo (tools/argo -> $BIN)"
  local rebuilt=0 want_go=""
  [ ! -f "$DIR/tools/argo/go.mod" ] || want_go=$(awk '$1=="toolchain"{sub(/^go/,"",$2); print $2}' "$DIR/tools/argo/go.mod")
  if [ "$DRY" = 1 ]; then
    run mkdir -p "$HOME/.local/bin" "$HOME/.local/state/argo" "$HOME/.config/argo"
    note "in $DIR/tools/argo:"
    run env CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -o "$BIN.new" .
    run mv -f "$BIN.new" "$BIN"
  elif ! command -v go >/dev/null 2>&1; then
    note "Go is not installed, so Argo was not built. Argo needs Go ${want_go:-1.26 or newer}:"
    note "download it from https://go.dev/dl/ and check the sha256 listed there, then run this again."
  elif [ -x "$BIN" ] && [ "$(first_line "$STATE/argo.sha")" = "$sha" ]; then
    note "already built from $sha"
  else
    # GOTOOLCHAIN=local: an older Go fails with a clear message instead of downloading a toolchain.
    # The new binary replaces the old one in a single rename, so a failed build leaves the old one.
    mkdir -p "$HOME/.local/bin" "$HOME/.local/state/argo" "$HOME/.config/argo"
    chmod 700 "$HOME/.local/state/argo" "$HOME/.config/argo"
    if (cd "$DIR/tools/argo" && env CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -o "$BIN.new" .); then
      mv -f "$BIN.new" "$BIN"; printf '%s\n' "$sha" >"$STATE/argo.sha"; rebuilt=1
      note "built $BIN from $sha. Try: argo status ; argo guard"
    else
      rm -f "$BIN.new"
      die 6 "the build failed (found $(go version 2>/dev/null | awk '{print $3}'), tools/argo wants go${want_go:-?}). Any earlier $BIN is untouched."
    fi
  fi

  # --- 5. the service, only when asked -----------------------------------------------------
  say "5/5 service $UNIT"
  if [ "$INSTALL" = 0 ]; then
    note "not installed (run again with --install-service when you want Argo to run by itself)"
  else
    local tpl="$DIR/scripts/ops/talos/systemd/$UNIT" rendered="$STATE/$UNIT" changed=0
    [[ "$ME" =~ ^[a-z_][a-z0-9_-]*$ ]] || die 6 "user name '$ME' is not one a unit file can hold safely"
    [[ "$HOME" =~ ^/[A-Za-z0-9/._-]+$ ]] || die 6 "home directory has odd characters"
    if [ "$DRY" = 1 ]; then
      note "would write $rendered from $tpl for user $ME (home $HOME)"
      sudo_run install -m 0644 -o root -g root "$rendered" "$UNIT_DIR/$UNIT"
      sudo_run systemctl daemon-reload
      sudo_run systemctl enable --now "$UNIT"
    else
      [ -x "$BIN" ] || die 6 "no $BIN yet (see step 4): nothing to run, so the service was not installed"
      [ -f "$tpl" ] || die 6 "this commit has no $tpl"
      command -v systemctl >/dev/null 2>&1 || die 6 "systemctl not found: this machine does not use systemd"
      sed -e "s|@USER@|$ME|g" -e "s|@HOME@|$HOME|g" "$tpl" >"$rendered.new" && mv -f "$rendered.new" "$rendered"
      ! grep -q '@[A-Z]*@' "$rendered" || die 6 "the unit template has a placeholder this script does not know"
      if ! cmp -s "$rendered" "$UNIT_DIR/$UNIT"; then
        note "the next commands need sudo (your password may be asked):"
        sudo_run install -m 0644 -o root -g root "$rendered" "$UNIT_DIR/$UNIT"
        sudo_run systemctl daemon-reload
        changed=1
      fi
      if ! systemctl is-enabled --quiet "$UNIT" 2>/dev/null || ! systemctl is-active --quiet "$UNIT" 2>/dev/null; then
        sudo_run systemctl enable --now "$UNIT"
      elif [ "$changed" = 1 ] || [ "$rebuilt" = 1 ]; then
        sudo_run systemctl restart "$UNIT"
      else
        note "already installed, enabled and running: nothing to do"
      fi
      note "check it: systemctl status $UNIT ; journalctl -u $UNIT -n 20"
    fi
  fi
  if [ -n "$PROFILE" ]; then
    local prc=0; ops_profile || prc=$?
    [ "$prc" = 0 ] || exit "$prc"
  fi
  say "done${ts_rc:+ (dry run; Tailscale needs attention, see step 2)}"
}

main "$@"
