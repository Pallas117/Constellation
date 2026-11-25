# Shared helpers for the Talos profile scripts (desktop, models, agents, claws). Sourced, never run.
# The caller sets APPLY (0/1) and DRY (0/1) first. Nothing changes unless APPLY=1; DRY only prints.
say() { printf '==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*"; }
die() { local rc="$1"; shift; printf 'talos kit: %s\n' "$*" >&2; exit "$rc"; }
# act: a user-level change. Runs only with APPLY=1.
act() { if [ "${APPLY:-0}" = 1 ]; then printf '    run: %s\n' "$*"; "$@"; else printf '    would run: %s\n' "$*"; fi; }
# sudo_act: always printed first; runs only with APPLY=1.
sudo_act() { if [ "${APPLY:-0}" = 1 ]; then printf '    sudo: %s\n' "$*"; sudo "$@"; else printf '    would run: sudo %s\n' "$*"; fi; }
# put_user_file DST CONTENT: user-owned file written only if it differs (APPLY=1 only).
put_user_file() {
  if [ -f "$1" ] && printf '%s\n' "$2" | cmp -s - "$1"; then note "$1: already in place"; return 0; fi
  if [ "${APPLY:-0}" = 1 ]; then mkdir -p "$(dirname "$1")" && printf '%s\n' "$2" >"$1" && note "wrote $1"
  else note "would write $1"; fi
}
refuse_root() { [ "$(id -u)" != 0 ] || die 1 "do not run this as root: run it as your normal user (sudo is called only with the apply flag, each command printed first)"; }
require_linux_or_dry() { [ "${DRY:-0}" = 1 ] || [ "$(uname -s)" = Linux ] || die 1 "this sets up a Linux machine; on $(uname -s) only --dry-run works"; }
