#!/usr/bin/env bash
# The "ops" profile for Talos, a roaming Kali laptop used as a gate box and dev server. Usually
# run through `bootstrap.sh --profile ops`; it also works on its own. Run it as your normal user,
# NOT as root.
#
#   bash ops-profile.sh [--apply] [--no-bluetooth] [--dry-run]
#
#   (no option)     report only: reads the machine and prints what it would change. It never calls
#                   sudo and changes nothing; the report is saved to ~/.local/state/talos-kit/profile.txt
#   --apply         make the changes. Every sudo command is printed before it runs.
#   --no-bluetooth  also disable and stop bluetooth
#   --dry-run       print everything, change and save nothing (works on any OS)
#
# Steps. Each checks first and skips what is already in place, so it is safe to run again:
#   1. trim services: cups, avahi-daemon (bluetooth with --no-bluetooth) disabled and
#      stopped; KDE Connect off for this user. PostgreSQL is NOT disabled (local apps use it): a conf.d
#      drop-in sets listen_addresses = 'localhost' (one restart, only when the file changed).
#      Listening TCP ports printed before and after.
#   2. power: power-saver on battery through TLP or power-profiles-daemon, whichever is installed
#      (never installs one, never both); 80% charge limit where the hardware offers it; lid
#      suspends on battery and is ignored on external power.
#   3. self-restart: systemd feeds the hardware watchdog (RuntimeWatchdogSec=30s); tailscaled and
#      gauss-argo restart after any exit.
#   4. hardening, additive only: an sshd drop-in (keys only, no root login) checked with sshd -t
#      and rolled back if that fails; ufw and AppArmor only reported (the firewall is harden.sh's);
#      security updates (not on Kali, see its message); journald capped at 200M; zram swap.
#   5. work tools: Node 26 and Go reported, with the official install steps (never run here).
#   6. the report, saved to ~/.local/state/talos-kit/profile.txt
#
# Exit: 0 done · 1 refused or bad usage · 7 a step failed (the others still ran; a failed sshd
#       change is rolled back)
# UNTESTED ON A REAL LINUX HOST (24 Nov 2026): only run against stubs (talos-kit.test.sh).
set -euo pipefail

main() {
  local APPLY=0 DRY=0 NOBT=0 FAILED=0 REPORT="" WROTE=0
  # Test hook (talos-kit.test.sh): a fake / for every file read or written under /etc, /proc, /sys.
  local ROOT="${TALOS_KIT_SYSROOT:-}"
  local STATE="$HOME/.local/state/talos-kit"
  local KIT; KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

  say() { printf '==> %s\n' "$*"; }
  note() { printf '    %s\n' "$*"; }
  warn() { printf '    WARNING: %s\n' "$*"; }
  die() { local rc="$1"; shift; printf 'talos ops profile: %s\n' "$*" >&2; exit "$rc"; }
  usage() { sed -n '2,29p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
  first_line() { [ -r "$1" ] && sed -n 1p "$1" 2>/dev/null | tr -d '\r' || true; }
  rec() { REPORT="$REPORT$(printf '%-22s %s' "$1" "$2")
"; }
  fail() { FAILED=1; rec "$1" "FAILED: $2"; warn "$1: $2"; }
  # A change. With --apply it runs (sudo ones printed first); otherwise it is only printed.
  act() { if [ "$APPLY" = 1 ]; then printf '    run: %s\n' "$*"; "$@"; else printf '    would run: %s\n' "$*"; fi; }
  sudo_act() { if [ "$APPLY" = 1 ]; then printf '    sudo: %s\n' "$*"; sudo "$@"; else printf '    would run: sudo %s\n' "$*"; fi; }
  # A read that needs root. Only ever called with --apply: the report mode never asks for a password.
  sudo_read() { printf '    sudo: %s\n' "$*" >&2; sudo "$@" 2>/dev/null; }
  pkg_installed() { [ "$(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true)" = "install ok installed" ]; }
  unit_present() { systemctl "$@" >/dev/null 2>&1; } # unit_present [--user] cat UNIT
  unit_on() { # unit_on [--user] UNIT: enabled at boot or running now
    if [ "$1" = --user ]; then
      [ "$(systemctl --user is-enabled "$2" 2>/dev/null || true)" = enabled ] || systemctl --user is-active --quiet "$2" 2>/dev/null
    else
      [ "$(systemctl is-enabled "$1" 2>/dev/null || true)" = enabled ] || systemctl is-active --quiet "$1" 2>/dev/null
    fi
  }
  # put_file PATH LABEL CONTENT: a root-owned file (mode 0644) holding CONTENT and a final newline,
  # written only if it differs. Sets WROTE=1 when it changed the file; non-zero only if writing failed.
  put_file() {
    local dst="$ROOT$1" label="$2" stage
    WROTE=0
    if [ -f "$dst" ] && printf '%s\n' "$3" | cmp -s - "$dst"; then
      note "$1: already in place"; rec "$label" "already in place"; return 0
    fi
    if [ "$APPLY" = 0 ]; then
      note "would write $1:"; printf '%s\n' "$3" | sed 's/^/      | /'
      rec "$label" "would write $1"; return 0
    fi
    stage="$STATE/stage/$(basename "$dst")"
    printf '%s\n' "$3" >"$stage"
    if sudo_act install -D -m 0644 -o root -g root "$stage" "$dst"; then
      WROTE=1; rec "$label" "wrote $1"
    else
      fail "$label" "could not write $1"; return 1
    fi
  }
  listening() {
    if command -v ss >/dev/null 2>&1; then ss -ltnp 2>/dev/null | sed 's/^/      /' || true
    else note "(ss not found: cannot list listening ports)"; fi
  }

  while [ $# -gt 0 ]; do
    case "$1" in
      --apply) APPLY=1 ;;
      --no-bluetooth) NOBT=1 ;;
      --dry-run) DRY=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die 1 "unknown option: $1 (try --help)" ;;
    esac
    shift
  done
  [ "$(id -u)" != 0 ] || die 1 "do not run this as root: run it as your normal user. With --apply it asks for sudo itself and prints each command first."
  if [ "$DRY" = 1 ]; then
    APPLY=0
    say "OPS PROFILE, DRY RUN: nothing below is changed or saved."
  else
    [ "$(uname -s)" = Linux ] || die 1 "this sets up a Linux machine; on $(uname -s) only --dry-run works"
    if [ "$APPLY" = 1 ]; then say "OPS PROFILE: applying (every sudo command is printed first)"
    else say "OPS PROFILE, REPORT ONLY: nothing is changed (add --apply to make these changes)"; fi
  fi
  local ME; ME=$(id -un)
  if [ "$APPLY" = 1 ]; then mkdir -p "$STATE/stage"; chmod 700 "$STATE" "$STATE/stage"; fi
  local have_systemd=0; command -v systemctl >/dev/null 2>&1 && have_systemd=1

  # --- 1. trim services ----------------------------------------------------------------------
  say "ops 1/6 trim services"
  note "listening TCP ports now (ss -ltnp; process names only for your own processes):"
  listening
  # postgresql is NOT in this list: gauss_aurora and vaultmcp use it locally. It is kept running and
  # only stopped from listening on the network (the PostgreSQL step below).
  local u units="cups.socket cups.path cups.service cups-browsed.service avahi-daemon.socket avahi-daemon.service"
  [ "$NOBT" = 0 ] || units="$units bluetooth.service"
  local trimmed=0
  if [ "$have_systemd" = 1 ]; then
    for u in $units; do # sockets and paths first, so nothing re-activates the service behind them
      if ! unit_present cat "$u"; then continue; fi
      if unit_on "$u"; then
        if sudo_act systemctl disable --now "$u"; then rec "$u" "$([ "$APPLY" = 1 ] && echo disabled || echo 'would disable')"; trimmed=1
        else fail "$u" "systemctl disable --now failed"; fi
      else
        note "$u: already off"; rec "$u" "already off"
      fi
    done
    if [ "$NOBT" = 0 ] && unit_present cat bluetooth.service && unit_on bluetooth.service; then
      note "bluetooth.service: kept (add --no-bluetooth to stop it)"; rec bluetooth.service "kept"
    fi
  else
    warn "systemctl not found: services not checked"
  fi
  # PostgreSQL: keep the service, drop the network listener. Local apps use localhost or the socket.
  # The drop-in is byte-identical to the one talos-sudo-once.sh writes, so running both restarts once.
  # Undo: remove /etc/postgresql/<ver>/main/conf.d/10-gauss-loopback.conf, then restart postgresql.
  local pgdir pgrel
  pgdir=$(ls -d "$ROOT"/etc/postgresql/*/main 2>/dev/null | sed -n 1p || true)
  if [ -z "$pgdir" ]; then note "postgresql: no /etc/postgresql/*/main (not installed here)"; rec postgresql "not installed"
  elif grep -Eq "^[[:space:]]*include_dir[[:space:]]*=[[:space:]]*'conf\.d'" "$pgdir/postgresql.conf" 2>/dev/null; then
    pgrel="${pgdir#"$ROOT"}/conf.d/10-gauss-loopback.conf"
    local pgnew=1
    [ ! -f "$ROOT$pgrel" ] || ! printf '%s\n' "# Gauss, 25 Nov 2026: no network listeners; local apps use localhost or the socket.
listen_addresses = 'localhost'" | cmp -s - "$ROOT$pgrel" || pgnew=0
    if put_file "$pgrel" postgresql "# Gauss, 25 Nov 2026: no network listeners; local apps use localhost or the socket.
listen_addresses = 'localhost'"; then
      if [ "$WROTE" = 1 ] || [ "$pgnew" = 1 ]; then
        if sudo_act systemctl restart postgresql.service; then rec "postgresql restart" "restarted"; else fail "postgresql restart" "systemctl restart failed"; fi
      fi
    fi
  else
    warn "postgresql: $pgdir/postgresql.conf has no include_dir = 'conf.d': set listen_addresses = 'localhost' by hand"
    rec postgresql "set listen_addresses = 'localhost' by hand"
  fi
  # KDE Connect listens on the LAN (ports 1714-1764). It runs per user: no sudo needed.
  local kc_sys="$ROOT/etc/xdg/autostart/org.kde.kdeconnect.daemon.desktop"
  local kc_user="$HOME/.config/autostart/org.kde.kdeconnect.daemon.desktop" kc=0
  if [ "$have_systemd" = 1 ] && unit_present --user cat kdeconnect.service; then
    kc=1
    if unit_on --user kdeconnect.service; then act systemctl --user disable --now kdeconnect.service || fail kdeconnect "could not disable the user service"; fi
  fi
  if [ -f "$kc_sys" ]; then
    kc=1
    if grep -qx 'Hidden=true' "$kc_user" 2>/dev/null; then :
    elif [ -e "$kc_user" ]; then warn "$kc_user exists without Hidden=true: yours, left alone. Add Hidden=true to stop KDE Connect at login."
    elif [ "$APPLY" = 1 ]; then
      note "run: write $kc_user (Hidden=true: KDE Connect no longer starts at login; delete the file to undo)"
      mkdir -p "$(dirname "$kc_user")" && printf '[Desktop Entry]\nHidden=true\n' >"$kc_user"
    else
      note "would write $kc_user (Hidden=true: KDE Connect no longer starts at login)"
    fi
  fi
  if pgrep -u "$ME" -x kdeconnectd >/dev/null 2>&1; then kc=1; act pkill -u "$ME" -x kdeconnectd || true; fi
  if [ "$kc" = 1 ]; then rec kdeconnect "$([ "$APPLY" = 1 ] && echo off || echo 'would turn off')"; else rec kdeconnect "not installed"; fi
  if [ "$APPLY" = 1 ] && { [ "$trimmed" = 1 ] || [ "$kc" = 1 ]; }; then
    note "listening TCP ports after:"
    listening
  fi

  # --- 2. power --------------------------------------------------------------------------------
  say "ops 2/6 power"
  local psu="$ROOT/sys/class/power_supply" d n t on_ac=0 bats=""
  for d in "$psu"/*/; do
    [ -d "$d" ] || continue
    d=${d%/}; t=$(first_line "$d/type")
    case "$t" in
      Mains|USB) [ "$(first_line "$d/online")" = 1 ] && on_ac=1 ;;
      Battery) [ "$(first_line "$d/scope")" = Device ] || bats="$bats $d" ;;
    esac
  done
  note "on $([ "$on_ac" = 1 ] && echo 'external power' || echo battery)"
  local has_tlp=0 ppc=""
  command -v tlp >/dev/null 2>&1 && has_tlp=1
  ppc=$(command -v powerprofilesctl 2>/dev/null || true)
  if [ "$has_tlp" = 1 ] && [ -n "$ppc" ]; then
    warn "TLP and power-profiles-daemon are both installed and fight over the same settings. Left alone: remove one yourself (sudo apt-get remove tlp, or power-profiles-daemon)."
    rec "power saving" "left alone: TLP and power-profiles-daemon both installed"
  elif [ "$has_tlp" = 1 ]; then
    note "power manager: TLP"
    c=$(cat <<'EOF'
# Gauss ops profile (bootstrap.sh --profile ops): save power on battery.
PLATFORM_PROFILE_ON_BAT=low-power
CPU_ENERGY_PERF_POLICY_ON_BAT=power
CPU_BOOST_ON_BAT=0
EOF
    )
    put_file /etc/tlp.d/50-gauss-ops.conf "power saving (TLP)" "$c" || true
    if [ "$WROTE" = 1 ]; then sudo_act tlp start || fail "power saving (TLP)" "tlp start failed"; fi
  elif [ -n "$ppc" ]; then
    note "power manager: power-profiles-daemon (now: $(powerprofilesctl get 2>/dev/null || echo unknown))"
    if [[ "$ppc" =~ ^/[A-Za-z0-9/._-]+$ ]]; then
      c=$(cat <<EOF
# Gauss ops profile (bootstrap.sh --profile ops): power-saver on battery, balanced on external power.
SUBSYSTEM=="power_supply", ATTR{type}=="Mains", ATTR{online}=="0", RUN+="$ppc set power-saver"
SUBSYSTEM=="power_supply", ATTR{type}=="Mains", ATTR{online}=="1", RUN+="$ppc set balanced"
EOF
      )
      put_file /etc/udev/rules.d/60-gauss-power-profile.rules "power saving (ppd)" "$c" || true
      if [ "$WROTE" = 1 ]; then sudo_act udevadm control --reload || fail "power saving (ppd)" "udevadm reload failed"; fi
    else
      warn "powerprofilesctl is at an odd path ($ppc): no udev rule written"
    fi
    if [ "$on_ac" = 0 ] && [ -n "$bats" ] && [ "$(powerprofilesctl get 2>/dev/null || true)" != power-saver ]; then
      sudo_act powerprofilesctl set power-saver || fail "power profile" "could not set power-saver"
    fi
  else
    note "no power manager installed. To get power-saver on battery, install ONE yourself:"
    note "  sudo apt-get install power-profiles-daemon     (or tlp, never both)"
    rec "power saving" "no power manager installed (not installed by this profile)"
  fi
  local tmpf="" cur
  for d in $bats; do
    n=$(basename "$d")
    if [ -e "$d/charge_control_end_threshold" ]; then
      tmpf="${tmpf}w ${d#"$ROOT"}/charge_control_end_threshold - - - - 80
"
      cur=$(first_line "$d/charge_control_end_threshold")
      if [ "$cur" = 80 ]; then note "$n charge limit: already 80%"; rec "$n charge limit" "already 80%"
      elif [ "$APPLY" = 0 ]; then note "would run: sudo tee $d/charge_control_end_threshold  (80, now $cur)"; rec "$n charge limit" "would set 80% (now $cur%)"
      else
        printf '    sudo: tee %s  (value 80, was %s)\n' "$d/charge_control_end_threshold" "$cur"
        if printf '80\n' | sudo tee "$d/charge_control_end_threshold" >/dev/null; then rec "$n charge limit" "set 80% (was $cur%)"
        else fail "$n charge limit" "the driver refused 80 (some need the start threshold below it first)"; fi
      fi
    else
      note "$n: charge limit not offered by this hardware or driver (nothing to set)"
      rec "$n charge limit" "not offered by the hardware"
    fi
  done
  [ -n "$bats" ] || { note "no battery found"; rec battery "none found"; }
  if [ -n "$tmpf" ]; then # sysfs forgets the value at reboot; systemd-tmpfiles writes it again at boot
    put_file /etc/tmpfiles.d/50-gauss-charge-limit.conf "charge limit at boot" \
      "# Gauss ops profile (bootstrap.sh --profile ops): stop charging at 80%, set again at every boot.
${tmpf%$'\n'}" || true
  fi
  c=$(cat <<'EOF'
# Gauss ops profile (bootstrap.sh --profile ops): keep working with the lid shut on external
# power; suspend on battery, which protects it.
[Login]
HandleLidSwitch=suspend
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
  )
  put_file /etc/systemd/logind.conf.d/50-gauss-lid.conf "lid switch" "$c" || true
  note "the lid setting applies after a reboot (restarting systemd-logind can end your desktop session);"
  note "Xfce's power manager has its own lid setting that may override it: check it too."

  # --- 3. self-restart -------------------------------------------------------------------------
  say "ops 3/6 self-restart"
  c=$(cat <<'EOF'
# Gauss ops profile (bootstrap.sh --profile ops): systemd pets the hardware watchdog; if the
# machine hangs for 30 s, the watchdog reboots it.
[Manager]
RuntimeWatchdogSec=30s
EOF
  )
  put_file /etc/systemd/system.conf.d/50-gauss-watchdog.conf "hardware watchdog" "$c" || true
  if [ "$WROTE" = 1 ]; then sudo_act systemctl daemon-reexec || fail "hardware watchdog" "daemon-reexec failed (applies at next boot)"; fi
  if ! compgen -G "$ROOT/dev/watchdog*" >/dev/null; then
    warn "no /dev/watchdog found: the setting does nothing until a watchdog driver is loaded"
  fi
  local reload=0
  for u in tailscaled.service gauss-argo.service; do
    if [ "$have_systemd" = 1 ] && unit_present cat "$u"; then
      c=$(cat <<'EOF'
# Gauss ops profile (bootstrap.sh --profile ops): restart after any exit, and never give up.
# `systemctl stop` still stops it.
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=5
EOF
      )
      put_file "/etc/systemd/system/$u.d/50-gauss-restart.conf" "$u restart" "$c" || true
      [ "$WROTE" = 0 ] || reload=1
    else
      note "$u: not installed yet (run this again after it is)"; rec "$u restart" "unit not installed yet"
    fi
  done
  if [ "$reload" = 1 ]; then sudo_act systemctl daemon-reload || fail "restart drop-ins" "daemon-reload failed"; fi

  # --- 4. hardening (additive only) ------------------------------------------------------------
  say "ops 4/6 hardening"
  # sshd keeps the FIRST value it reads for each setting, and reads sshd_config.d in name order,
  # so 05- is read before harden.sh's 10-gauss.conf (which allows root by key).
  local SSHD drop=/etc/ssh/sshd_config.d/05-gauss-ops.conf sshd_conf
  SSHD=$(command -v sshd 2>/dev/null || echo /usr/sbin/sshd)
  sshd_conf='# Gauss ops profile (bootstrap.sh --profile ops): keys only, no root login.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no'
  if [ ! -x "$SSHD" ]; then
    note "no OpenSSH server installed: nothing to harden"; rec sshd "not installed"
  elif ! grep -qiE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' "$ROOT/etc/ssh/sshd_config" 2>/dev/null; then
    warn "/etc/ssh/sshd_config does not include sshd_config.d/*.conf: the main file is not edited here; sshd skipped"
    rec sshd "skipped: sshd_config has no Include for sshd_config.d"
  elif [ -f "$ROOT$drop" ] && printf '%s\n' "$sshd_conf" | cmp -s - "$ROOT$drop"; then
    note "$drop: already in place"; rec sshd "already keys only"
  else
    local keys=0 tsssh=0 sshon=0
    grep -qE '^(ssh-ed25519|ecdsa-sha2|ssh-rsa|sk-)' "$HOME/.ssh/authorized_keys" 2>/dev/null && keys=1
    grep -q '"RunSSH": *true' <<<"$(tailscale debug prefs 2>/dev/null || true)" && tsssh=1
    [ "$have_systemd" = 1 ] && systemctl is-active --quiet ssh.service 2>/dev/null && sshon=1
    if [ "$sshon" = 1 ] && [ "$keys" = 0 ] && [ "$tsssh" = 0 ]; then
      warn "SSH is running but $ME has no key in ~/.ssh/authorized_keys and Tailscale SSH is off:"
      warn "keys-only would lock you out. Add the Mac's public key first, then run this again. Skipped."
      rec sshd "skipped: no SSH key installed (would lock out)"
    elif [ "$APPLY" = 0 ]; then
      put_file "$drop" sshd "$sshd_conf"
      note "would run: sudo $SSHD -t   (and roll the file back if it fails)"
      [ "$sshon" = 0 ] || note "would run: sudo systemctl reload ssh.service"
    elif ! sudo_act "$SSHD" -t; then
      fail sshd "the sshd config is already invalid before this change: fix it first (sudo sshd -t). Nothing changed."
    else
      local prev="$STATE/stage/sshd-prev.conf" had=0
      if [ -f "$ROOT$drop" ]; then cp "$ROOT$drop" "$prev"; had=1; fi
      if put_file "$drop" sshd "$sshd_conf" && sudo_act "$SSHD" -t; then
        if [ "$sshon" = 1 ]; then sudo_act systemctl reload ssh.service || fail sshd "reload failed (the new file applies at the next start)"; fi
        local eff k
        eff=$(sudo_read "$SSHD" -T || true)
        for k in "passwordauthentication no" "kbdinteractiveauthentication no" "permitrootlogin no"; do
          grep -qix "$k" <<<"$eff" || warn "sshd -T does not show '$k': another setting wins over $drop. Check: sudo sshd -T"
        done
      else
        warn "sshd -t rejected the new config: rolling $drop back"
        if [ "$had" = 1 ]; then sudo_act install -m 0644 -o root -g root "$prev" "$ROOT$drop" || true
        else sudo_act rm -f "$ROOT$drop" || true; fi
        if sudo_act "$SSHD" -t; then note "rolled back: sshd's config is as it was, nothing was reloaded"
        else warn "sshd -t still fails after the rollback: do NOT restart ssh; look at sudo sshd -t now"; fi
        fail sshd "sshd -t failed; rolled back, not reloaded"
      fi
    fi
  fi
  # ufw: report only. harden.sh --node (the private ops kit) owns the rules.
  local ufw_conf="$ROOT/etc/ufw/ufw.conf" ufw_def="$ROOT/etc/default/ufw" en pol
  if [ -f "$ufw_conf" ]; then
    en=$(sed -n 's/^ENABLED=//p' "$ufw_conf" | tr -d '"' | sed -n 1p)
    pol=$(sed -n 's/^DEFAULT_INPUT_POLICY=//p' "$ufw_def" 2>/dev/null | tr -d '"' | sed -n 1p)
    note "ufw: enabled=${en:-unknown}, default incoming=${pol:-unknown} (rules not changed here: harden.sh --node owns them)"
    if [ "$en" = yes ] && { [ "$pol" = DROP ] || [ "$pol" = REJECT ]; }; then rec ufw "on, default incoming $pol (not changed)"
    else
      warn "the firewall does not deny incoming by default: run harden.sh --node (private ops kit) on your own hotspot"
      rec ufw "WARNING: incoming not denied by default (enabled=${en:-?}, policy=${pol:-?}); not changed"
    fi
  else
    warn "ufw is not installed: nothing blocks the LAN. harden.sh --node (private ops kit) installs and sets it"
    rec ufw "WARNING: not installed; not changed"
  fi
  # AppArmor: report only.
  local aa AAS
  aa=$(first_line "$ROOT/sys/module/apparmor/parameters/enabled")
  if [ "$aa" = Y ]; then
    note "AppArmor: enabled in the kernel"
    AAS=$(command -v aa-status 2>/dev/null || echo /usr/sbin/aa-status)
    if [ "$APPLY" = 1 ] && [ -x "$AAS" ]; then
      sudo_read "$AAS" | grep -E 'profiles are (loaded|in enforce mode|in complain mode)|processes are in enforce mode' | sed 's/^/      /' || true
    else
      note "(profile counts need root: shown with --apply, or run sudo aa-status)"
    fi
    rec apparmor "enabled (reported only)"
  else
    warn "AppArmor is not enabled in the kernel (reported only, not changed)"; rec apparmor "NOT enabled (reported only)"
  fi
  # Security updates.
  local osid; osid=$( (. "$ROOT/etc/os-release" 2>/dev/null && echo "${ID:-unknown}") || echo unknown)
  if [ "$osid" = kali ]; then
    note "security updates: Kali is rolling and has no separate security archive, so unattended-upgrades"
    note "(security origins only) would install nothing, and unattended full upgrades of a rolling"
    note "distribution can break the machine. harden.sh skips it for the same reason. On a network you trust:"
    note "  sudo apt update && sudo apt full-upgrade"
    rec "security updates" "manual on Kali (no security archive); not installed"
  else
    if pkg_installed unattended-upgrades; then note "unattended-upgrades: installed"
    elif sudo_act env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends unattended-upgrades; then :
    else fail "security updates" "could not install unattended-upgrades (offline? try sudo apt-get update)"; fi
    put_file /etc/apt/apt.conf.d/20auto-upgrades "security updates" 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' || true
  fi
  # journald: cap the journal.
  put_file /etc/systemd/journald.conf.d/50-gauss.conf "journald cap" '# Gauss ops profile (bootstrap.sh --profile ops): keep the journal small on a small disk.
[Journal]
SystemMaxUse=200M' || true
  if [ "$WROTE" = 1 ]; then sudo_act systemctl restart systemd-journald.service || fail "journald cap" "restart failed (applies at next boot)"; fi
  # zram swap.
  if grep -q '^/dev/zram' "$ROOT/proc/swaps" 2>/dev/null; then
    note "zram swap: already active"; rec "zram swap" "already active"
  else
    local zok=1
    if ! pkg_installed zram-tools; then
      sudo_act env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends zram-tools ||
        { zok=0; fail "zram swap" "could not install zram-tools (offline? try sudo apt-get update)"; }
    fi
    if [ "$zok" = 1 ]; then
      put_file /etc/default/zramswap "zram swap" '# Gauss ops profile (bootstrap.sh --profile ops): compressed swap in RAM, half of it.
ALGO=zstd
PERCENT=50
PRIORITY=100' || true
      if [ "$(systemctl is-enabled zramswap.service 2>/dev/null || true)" != enabled ]; then
        sudo_act systemctl enable zramswap.service || fail "zram swap" "enable failed"
      fi
      if [ "$WROTE" = 1 ] || ! systemctl is-active --quiet zramswap.service 2>/dev/null; then
        sudo_act systemctl restart zramswap.service || fail "zram swap" "start failed"
      fi
    fi
  fi

  # --- 5. work tools (reported, never installed here) ------------------------------------------
  say "ops 5/6 work tools"
  local arch v want_go=""
  case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; *) arch=x64 ;; esac
  v=$(node --version 2>/dev/null || true)
  if [ "${v%%.*}" = v26 ]; then note "Node $v: OK (.nvmrc wants 26)"; rec node "$v"
  else
    if [ -n "$v" ]; then warn "Node $v: the repo needs Node 26 (.nvmrc)"; else note "Node: not installed (the repo needs 26)"; fi
    rec node "${v:-missing}: needs 26 (install steps printed)"
    note "Install Node 26 yourself from nodejs.org, checked against its SHASUMS256, into your home:"
    note "  cd /tmp && base=https://nodejs.org/dist/latest-v26.x && curl -fsSLO \"\$base/SHASUMS256.txt\""
    note "  f=\$(grep -o \"node-v26[^ ]*-linux-$arch.tar.xz\" SHASUMS256.txt | sed -n 1p) && curl -fsSLO \"\$base/\$f\""
    note "  grep \" \$f\\\$\" SHASUMS256.txt | sha256sum -c -"
    note "  mkdir -p ~/.local/node && tar -xJf \"\$f\" -C ~/.local/node --strip-components=1"
    note "  then add ~/.local/node/bin to PATH in ~/.zshrc"
  fi
  [ ! -f "$KIT/../../../tools/argo/go.mod" ] || want_go=$(awk '$1=="toolchain"{sub(/^go/,"",$2); print $2}' "$KIT/../../../tools/argo/go.mod")
  v=$(go version 2>/dev/null | awk '{print $3}' || true)
  if [ -n "$v" ]; then note "Go: $v (tools/argo wants go${want_go:-1.26 or newer})"; rec go "$v"
  else
    note "Go: not installed. Argo needs Go ${want_go:-1.26 or newer}: download it from https://go.dev/dl/,"
    note "check the sha256 listed there, then: tar -C ~/.local -xzf go<version>.linux-${arch/x64/amd64}.tar.gz"
    note "and add ~/.local/go/bin to PATH"
    rec go "missing (install steps printed)"
  fi

  # --- 6. report ---------------------------------------------------------------------------------
  say "ops 6/6 report"
  local mode="applied"
  [ "$APPLY" = 1 ] || mode="report only, nothing changed"
  [ "$DRY" = 0 ] || mode="dry run, nothing changed"
  local text
  text="talos-kit ops profile, $(date -u +%Y-%m-%dT%H:%M:%SZ), $mode
$REPORT"
  printf '%s' "$text" | sed 's/^/    /'
  if [ "$DRY" = 0 ]; then
    mkdir -p "$STATE"; chmod 700 "$STATE"
    printf '%s' "$text" >"$STATE/profile.txt.new" && mv -f "$STATE/profile.txt.new" "$STATE/profile.txt"
    note "saved to $STATE/profile.txt"
  fi
  if [ "$FAILED" = 1 ]; then say "done, with failures (see above)"; exit 7; fi
  say "done"
}

main "$@"
