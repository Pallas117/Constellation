#!/usr/bin/env bash
# Download the pinned Nebula release for Linux, check it, and unpack nebula + nebula-cert into DIR.
# Needs no root and installs nothing: the caller installs the two files (the VPS bootstrap does, as root;
# on Talos, node-setup.sh prints the sudo command).
#
#   bash scripts/ops/nebula/fetch.sh linux-amd64|linux-arm64 DIR [--dry-run]
#
# The tarball's SHA-256 is pinned below, copied from the release's SHASUM256.txt (v1.12.0, read
# 25 Nov 2026 over HTTPS). A download that doesn't match is deleted and the script stops. To move to a new
# release: update NEBULA_VERSION and both sums from https://github.com/slackhq/nebula/releases, in a PR.
set -euo pipefail

NEBULA_VERSION=1.12.0
SUM_linux_amd64=44bf6ae565cf7e5391ca49e8c5f9e3b825755c385eacf79a1f0d28a0b7d3fe51
SUM_linux_arm64=1279bdde8ccaa0e8c0f90276a295cb471a1d10b5a5308d68d3ed519803df503a

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh" # fixed PATH (system tools first)
DRY=0; pos=()
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;; -*) die "unknown option: $a" ;; *) pos+=("$a") ;; esac; done
[ "${#pos[@]}" -eq 2 ] || die "usage: fetch.sh linux-amd64|linux-arm64 DIR [--dry-run]"
plat="${pos[0]}"; dest="${pos[1]}"
case "$plat" in linux-amd64) want="$SUM_linux_amd64" ;; linux-arm64) want="$SUM_linux_arm64" ;; *) die "platform must be linux-amd64 or linux-arm64" ;; esac
file="nebula-$plat.tar.gz"
url="https://github.com/slackhq/nebula/releases/download/v$NEBULA_VERSION/$file"

if [ "$DRY" = 1 ]; then
  echo "   + curl --proto =https --tlsv1.2 -fsSL -o <temp>/$file $url"
  echo "   + check sha256 = $want, then unpack nebula and nebula-cert into $dest"
  exit 0
fi
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
curl --proto =https --tlsv1.2 -fsSL -o "$T/$file" "$url" || die "download failed: $url"
got=$(sha256 "$T/$file")
[ "$got" = "$want" ] || die "checksum mismatch for $file (got $got): deleted, nothing unpacked"
tar -xzf "$T/$file" -C "$T" nebula nebula-cert || die "the archive has no nebula/nebula-cert"
mkdir -p "$dest"
install -m 0755 "$T/nebula" "$T/nebula-cert" "$dest/"
echo "nebula $NEBULA_VERSION ($plat) checked and unpacked into $dest"
