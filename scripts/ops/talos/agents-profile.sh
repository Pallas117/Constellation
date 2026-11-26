#!/usr/bin/env bash
# The "agents" profile for Talos: a dedicated unprivileged user that runs queued handover tasks.
# Run as your normal user, NOT as root. Usually via `bootstrap.sh --profile agents`.
#
#   bash agents-profile.sh [--apply] [--dry-run]
#
#   (no option)  report only: prints what it would change; no sudo, nothing changed
#   --apply      create the user and install the runner and unit (sudo, every command printed first)
#   --dry-run    print everything, change nothing (works on any OS)
#
# What it sets up (each step checks first):
#   1. user gauss-agent: system user, no sudo, password locked, shell nologin, home /var/lib/gauss-agent
#      mode 0700. It has no access to your home, keys or accounts.
#   2. /usr/local/lib/gauss/agent-runner.sh (root-owned) and spool dirs under the agent's home
#   3. /etc/systemd/system/gauss-agent.service (hardened, see systemd/gauss-agent.service),
#      installed but NOT enabled: it stays OFF until you create the root-only key file and a credit cap.
# Work arrives as *.task files in /var/lib/gauss-agent/spool (copy them in with sudo; a handover from
# the Mac is a later step). Exit: 0 done / reported · 1 refused or bad usage · 7 a step failed
# UNTESTED ON A REAL LINUX HOST (25 Nov 2026): only run against stubs (talos-kit.test.sh).
set -euo pipefail
main() {
  local APPLY=0 DRY=0 ROOT="${TALOS_KIT_SYSROOT:-}" FAILED=0 U=gauss-agent H=/var/lib/gauss-agent
  local KIT; KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=lib.sh
  . "$KIT/lib.sh"
  while [ $# -gt 0 ]; do
    case "$1" in
      --apply) APPLY=1 ;; --dry-run) DRY=1 ;;
      -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die 1 "unknown option: $1 (try --help)" ;;
    esac; shift
  done
  refuse_root; require_linux_or_dry
  [ "$DRY" = 0 ] || APPLY=0
  say "AGENTS PROFILE: $([ "$APPLY" = 1 ] && echo applying || echo 'nothing is changed; add --apply')"

  say "agents 1/3 user $U"
  if id "$U" >/dev/null 2>&1; then note "$U: already exists"
  else
    sudo_act useradd --system --create-home --home-dir "$H" --shell /usr/sbin/nologin --user-group "$U" || FAILED=1
  fi
  sudo_act passwd -l "$U" || FAILED=1
  sudo_act chmod 0700 "$H" || FAILED=1
  note "no sudo: it is in no sudo/adm group (check: id $U)"

  say "agents 2/3 runner and spool"
  local runner="$ROOT/usr/local/lib/gauss/agent-runner.sh"
  if [ -f "$runner" ] && cmp -s "$KIT/agent/agent-runner.sh" "$runner"; then note "$runner: already in place"
  else sudo_act install -D -m 0755 -o root -g root "$KIT/agent/agent-runner.sh" "$runner" || FAILED=1; fi
  sudo_act install -d -m 0700 -o "$U" -g "$U" "$H/spool" "$H/done" "$H/failed" || FAILED=1

  say "agents 3/3 service (installed, NOT enabled)"
  local unit="$ROOT/etc/systemd/system/gauss-agent.service"
  if [ -f "$unit" ] && cmp -s "$KIT/systemd/gauss-agent.service" "$unit"; then note "$unit: already in place"
  else
    sudo_act install -D -m 0644 -o root -g root "$KIT/systemd/gauss-agent.service" "$unit" || FAILED=1
    sudo_act systemctl daemon-reload || FAILED=1
  fi
  note "OFF until you (Josh) do this; the profile never touches the key or enables the unit:"
  note "  sudo install -d -m 0700 /etc/gauss-agent"
  note "  sudo install -m 0600 -o root -g root /dev/stdin /etc/gauss-agent/anthropic.key    # paste the key, Ctrl-D"
  note "  sudo systemctl edit gauss-agent    # add: [Service] Environment=GAUSS_AGENT_CREDIT_CAP_USD=5"
  note "  sudo systemctl enable --now gauss-agent"
  note "the claude CLI must be installed for the agent user (not done here); without it tasks fail and are filed under failed/"
  [ "$FAILED" = 0 ] || exit 7
}
main "$@"
