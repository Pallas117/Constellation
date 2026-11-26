#!/bin/bash
# install-gate-run.sh: for Josh, at the gate box (Talos or the cloud VM), from a checkout of this repo.
# Installs scripts/ops/gatebox/gauss-gate-run as /usr/local/bin/gauss-gate-run (the gate user's forced
# command), keeping the old one as gauss-gate-run.bak-<date>. The only step that needs sudo is the install;
# each sudo command is printed before it runs. Agents never run this.
#   bash scripts/ops/gatebox/install-gate-run.sh [--dry-run]
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd)/gauss-gate-run"
dst=/usr/local/bin/gauss-gate-run
dry=0; [ "${1:-}" = --dry-run ] && dry=1
[ "$(uname -s)" = Linux ] || [ "$dry" = 1 ] || { echo "run this on the gate box (Linux), not here"; exit 1; }
bash -n "$src"
if [ -f "$dst" ] && cmp -s "$src" "$dst"; then echo "$dst is already this version"; exit 0; fi
run() { echo "+ sudo $*"; [ "$dry" = 1 ] || sudo "$@"; }
[ -f "$dst" ] && run cp -p "$dst" "$dst.bak-$(date +%Y%m%d%H%M)"
run install -m 0755 -o root -g root "$src" "$dst"
[ "$dry" = 1 ] && exit 0
# Read back what is installed: a forced command that did not change would silently keep the old behaviour.
cmp -s "$src" "$dst" || { echo "FAILED: $dst differs from $src after install"; exit 1; }
echo "installed: $dst ($(sha256sum "$dst" | cut -c1-12)). Tools for the ops tests here:"
for t in bash git go plutil timeout npm; do printf '  %-8s %s\n' "$t" "$(command -v "$t" || echo MISSING)"; done
echo "Any MISSING tool: the box prints 'ops skipped' and the Mac runs the ops tests itself."
