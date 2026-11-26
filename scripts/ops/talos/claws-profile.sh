#!/usr/bin/env bash
# The "claws" profile for Talos: a sandbox for OpenClaw-style autonomous agents, which are treated as
# UNTRUSTED (see CLAWS-THREAT-MODEL.md). Run as your normal user, NOT as root. Usually via
# `bootstrap.sh --profile claws`.
#
#   bash claws-profile.sh [--image NAME@sha256:DIGEST] [--name NAME] [--apply] [--apply-claws] [--dry-run]
#
#   (no option)     report only: prints everything it would do, including the exact podman command
#   --apply         create the gauss-claw user, the skills allowlist and the gateway unit (sudo, printed)
#   --apply-claws   with --image: pull the image (a DOWNLOAD, needs Josh's OK) and CREATE the container.
#                   It never starts it: you start it by hand after reading the threat model.
#   --image REF     must be pinned by digest. Without it nothing is pulled.
#   --name NAME     container name suffix (default claw1)
#   --dry-run       print everything, change nothing (works on any OS)
#
# The container: rootless podman as gauss-claw; --network=none (no LAN, tailnet or internet); read-only
# root; one named scratch volume and the gateway socket (read-only) as the only mounts, no host paths,
# no $HOME; all capabilities dropped; no-new-privileges; memory, CPU and pids limits; local models
# only (the loopback Ollama through the gateway socket); no credentials. Root inside the container is
# gauss-claw outside it (user namespace), with every capability dropped.
# Exit: 0 done / reported · 1 refused or bad usage · 7 a step failed
# UNTESTED ON A REAL LINUX HOST (25 Nov 2026): only run against stubs (talos-kit.test.sh).
set -euo pipefail
main() {
  local APPLY=0 ACLAWS=0 DRY=0 ROOT="${TALOS_KIT_SYSROOT:-}" FAILED=0 U=gauss-claw H=/var/lib/gauss-claw IMAGE="" NAME=claw1
  local KIT; KIT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  # shellcheck source=lib.sh
  . "$KIT/lib.sh"
  while [ $# -gt 0 ]; do
    case "$1" in
      --apply) APPLY=1 ;; --apply-claws) ACLAWS=1 ;; --dry-run) DRY=1 ;;
      --image) [ $# -ge 2 ] || die 1 "--image needs a value"; IMAGE="$2"; shift ;;
      --name) [ $# -ge 2 ] || die 1 "--name needs a value"; NAME="$2"; shift ;;
      -h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) die 1 "unknown option: $1 (try --help)" ;;
    esac; shift
  done
  refuse_root; require_linux_or_dry
  [[ "$NAME" =~ ^[a-z0-9][a-z0-9_-]{0,30}$ ]] || die 1 "--name: lowercase letters, digits, - and _ only"
  [ -z "$IMAGE" ] || [[ "$IMAGE" =~ ^[A-Za-z0-9./_:-]+@sha256:[0-9a-f]{64}$ ]] || die 1 "--image must be pinned by digest: name@sha256:<64 hex>"
  [ "$ACLAWS" = 0 ] || [ -n "$IMAGE" ] || die 1 "--apply-claws needs --image"
  if [ "$DRY" = 1 ]; then APPLY=0; ACLAWS=0; fi
  say "CLAWS PROFILE: $([ "$APPLY$ACLAWS" = 00 ] && echo 'nothing is changed or downloaded' || echo applying)"

  say "claws 1/4 user $U (own user, no sudo, no password, no shell)"
  if id "$U" >/dev/null 2>&1; then note "$U: already exists"
  else sudo_act useradd --system --create-home --home-dir "$H" --shell /usr/sbin/nologin --user-group "$U" || FAILED=1; fi
  sudo_act passwd -l "$U" || FAILED=1
  sudo_act chmod 0700 "$H" || FAILED=1
  if [ -r "$ROOT/etc/subuid" ] && grep -q "^$U:" "$ROOT/etc/subuid"; then note "subuid range: present"
  else sudo_act usermod --add-subuids 200000-265535 --add-subgids 200000-265535 "$U" || FAILED=1; fi
  sudo_act loginctl enable-linger "$U" || FAILED=1
  command -v podman >/dev/null 2>&1 || warn "podman not found: sudo apt install -y podman uidmap socat"
  command -v socat >/dev/null 2>&1 || warn "socat not found (the gateway needs it): sudo apt install -y socat"

  say "claws 2/4 skills allowlist (vetted skills only)"
  local al="$ROOT$H/skills-allowlist.txt"
  if [ -f "$al" ]; then note "$al: already in place (not overwritten)"
  else
    local stage="$HOME/.local/state/talos-kit/stage-skills-allowlist.txt"
    if [ "$APPLY" = 1 ]; then
      mkdir -p "$(dirname "$stage")"
      printf '%s\n' "# sha256  skill-file    (one line per skill Josh has READ and approved; empty = no skills may be installed)" >"$stage"
    fi
    sudo_act install -D -m 0644 -o root -g root "$stage" "$al" || FAILED=1
  fi
  note "a skill goes into a claw only if 'sha256sum -c' against this file passes; nothing is fetched by a claw itself"

  say "claws 3/4 gateway (unix socket to loopback Ollama; the only way out)"
  local gw="$ROOT/etc/systemd/system/gauss-claw-gw.service"
  if [ -f "$gw" ] && cmp -s "$KIT/systemd/gauss-claw-gw.service" "$gw"; then note "$gw: already in place"
  else
    sudo_act install -D -m 0644 -o root -g root "$KIT/systemd/gauss-claw-gw.service" "$gw" || FAILED=1
    sudo_act systemctl daemon-reload || FAILED=1
    sudo_act systemctl enable --now gauss-claw-gw.service || FAILED=1
  fi

  say "claws 4/4 container $NAME"
  local img="${IMAGE:-<image@sha256:digest>}" uid; uid=$(id -u "$U" 2>/dev/null || echo '<uid>')
  local -a pod=(sudo -u "$U" -H env "XDG_RUNTIME_DIR=/run/user/$uid" podman)
  local -a args=(create --name "claw-$NAME" --network=none --read-only
    --tmpfs /tmp:rw,noexec,nosuid,size=64m --cap-drop=all --security-opt no-new-privileges
    --memory 1g --memory-swap 1g --cpus 1 --pids-limit 128 --restart=no
    --volume "claw-scratch-$NAME:/scratch:rw"
    --volume /run/gauss-claw-gw:/gw:ro
    --env OLLAMA_HOST=http://127.0.0.1:11434
    "$img")
  note "command: ${pod[*]} ${args[*]}"
  note "inside the image a shim (e.g. socat TCP-LISTEN:11434 to UNIX:/gw/ollama.sock) must serve 127.0.0.1:11434 in the container and forward to /gw/ollama.sock; no network exists otherwise (UNVERIFIED for any real claw image)"
  if [ -z "$IMAGE" ]; then note "no --image: nothing to pull or create"
  elif [ "$ACLAWS" = 1 ]; then
    printf '    run (DOWNLOAD): sudo -u %s podman pull %s\n' "$U" "$IMAGE"
    "${pod[@]}" pull "$IMAGE" || FAILED=1
    printf '    sudo: %s\n' "${pod[*]} ${args[*]}"
    sudo "${pod[@]:1}" "${args[@]}" || FAILED=1
  else note "to download and create (needs Josh's OK): re-run with --apply-claws"; fi
  note "start by hand, after reading the threat model: sudo -u $U -H env XDG_RUNTIME_DIR=/run/user/$uid podman start claw-$NAME"
  note "check it is isolated: podman inspect claw-$NAME (NetworkMode none) and, inside, that no route or address exists besides lo"
  [ "$FAILED" = 0 ] || exit 7
}
main "$@"
