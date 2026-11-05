#!/bin/bash
# Check, build and install Argo from this checkout, and roll back if the new binary doesn't run.
#   tools/argo/install.sh            full check (check.sh), then install
#   ARGO_BIN=/path install.sh        install somewhere else (tests use this)
# Steps: check.sh (fails = nothing changes) -> build with the commit stamped in (`argo version`
# shows it) and the Info.plist macOS needs for Local Network access -> ad-hoc sign with a stable
# identifier -> the new binary must answer `version` with this commit and `status` -> swap it in,
# keeping the old one as argo.bak-<time> -> the installed binary must answer again, or the old one
# goes back. Keeps its newest $ARGO_KEEP_BACKUPS (3) backups. The LaunchAgent runs `argo tick`
# every minute, so the next tick uses the new binary; nothing to restart.
set -euo pipefail
cd "$(dirname "$0")"
BIN=${ARGO_BIN:-$HOME/.local/bin/argo}
KEEP=${ARGO_KEEP_BACKUPS:-3}
sha=$(git rev-parse --short=12 HEAD)
[ -z "$(git status --porcelain -- .)" ] || sha="$sha-dirty"
echo "== argo install: $sha -> $BIN ($(date '+%F %T'))"

[ -n "${ARGO_SKIP_CHECK:-}" ] || ./check.sh

mkdir -p "$(dirname "$BIN")"
new="$BIN.new"
trap 'rm -f "$new"' EXIT
ldflags="-X main.commit=$sha"
if [ "$(uname -s)" = Darwin ]; then
  # The linker splits -extldflags on spaces, so the plist goes via a path without any.
  plist=$(mktemp -t argo-plist); cp launchd/Info.plist "$plist"
  CGO_ENABLED=1 go build -trimpath -ldflags "$ldflags -linkmode=external -extldflags \"-sectcreate __TEXT __info_plist $plist\"" -o "$new" .
  rm -f "$plist"
  codesign -f -s - -i uk.lightbound.argo "$new" 2>/dev/null
else
  CGO_ENABLED=0 go build -trimpath -ldflags "$ldflags -s -w" -o "$new" .
fi

healthy() { # healthy <binary>: runs, is this commit, reads its state
  local v; v=$("$1" version 2>&1) || return 1
  [ "$v" = "argo $(sed -n 's/^const version = "\(.*\)"$/\1/p' main.go) $sha" ] || { echo "version says '$v'" >&2; return 1; }
  "$1" status >/dev/null 2>&1
}
healthy "$new" || { echo "== the new binary doesn't run: nothing installed" >&2; exit 1; }

bak=""
if [ -e "$BIN" ]; then bak="$BIN.bak-$(date +%Y%m%d%H%M%S)"; cp -p "$BIN" "$bak"; fi
mv -f "$new" "$BIN"
# macOS kills the first launch of a replaced ad-hoc-signed binary at the same path once
# (OS_REASON_CODESIGNING, 1 Nov 2026): run it once so the LaunchAgent's next tick is clean.
"$BIN" version >/dev/null 2>&1 || true
if ! healthy "$BIN"; then
  if [ -n "$bak" ]; then
    cp -p "$bak" "$BIN"; echo "== installed binary failed its check: rolled back to $bak" >&2
  else
    echo "== installed binary failed its check and there was no previous one" >&2
  fi
  exit 1
fi

# Newest $KEEP of this script's backups (14-digit stamps) stay; older hand-made ones are left alone.
{ ls -1 "$BIN".bak-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9] 2>/dev/null || true; } | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old"; done
echo "== installed $sha${bak:+ (previous kept at $bak)}"
"$BIN" status 2>&1 | sed -n 1,2p # sed reads to the end: no SIGPIPE under pipefail
