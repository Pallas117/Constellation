#!/usr/bin/env bash
# Trust another device's key on the VPS, only after you have compared fingerprints, then start
# the Argo relay service. Run as root on the VPS:
#
#   sudo bash confirm-peer.sh DEVICE "XXXX XXXX XXXX XXXX XXXX" [--dry-run]
#
# DEVICE is the name it enrolled under (e.g. laptop). The fingerprint is what `argo keys` prints
# ON THAT DEVICE (you read it there, not here). Argo pins an unknown key the first time it sees
# one, so the relay service stays stopped until this script has pinned the key you checked.
# It refuses on any mismatch, and asks you to type "yes" before pinning.
set -euo pipefail

SRC=/opt/gauss/src; DATA=/var/lib/gauss; SVC_USER=gauss
DRY=0; args=()
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;; *) args+=("$a") ;; esac; done
die() { printf 'confirm-peer: %s\n' "$*" >&2; exit 1; }
[ ${#args[@]} -eq 2 ] || die 'usage: confirm-peer.sh DEVICE "XXXX XXXX XXXX XXXX XXXX" [--dry-run]'
device="${args[0]}"; expected="${args[1]}"
[[ "$device" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || die "device name must be lowercase letters, digits, dashes"

# Compare ignoring spaces and case.
norm() { printf '%s' "$1" | tr -d ' \t' | tr '[:lower:]' '[:upper:]'; }
[[ "$(norm "$expected")" =~ ^[0-9A-F]{20}$ ]] || die "the fingerprint should be 20 hex digits (five groups of four)"

if [ "$DRY" = 1 ]; then
  echo "DRY RUN: would read $device's fingerprint from the hub, refuse unless it equals the one you gave,"
  echo "ask you to type yes, run: argo keys trust $device (as $SVC_USER), then systemctl enable --now argo-relay"
  exit 0
fi
[ "$(id -u)" = 0 ] || die "run as root"

offered=$(runuser -u "$SVC_USER" -- env -i HOME="$DATA" PATH=/usr/local/bin:/usr/bin:/bin MESH_STORE_PATH="$DATA/mesh/devices.json" \
  sh -c "cd $SRC && node --import tsx -e 'import(\"./backend/mesh/store.ts\").then(({MeshStore})=>{const d=new MeshStore(process.env.MESH_STORE_PATH).list().find((x)=>x.name===process.argv[1]);console.log(d&&d.keyFingerprint||\"\")})' $device")
[ -n "$offered" ] || die "the hub has no key for $device yet (has it run: argo enroll ...?)"
echo "The hub offers for $device: $offered"
echo "You gave (read on $device):  $expected"
[ "$(norm "$offered")" = "$(norm "$expected")" ] || die "MISMATCH: not trusting. Re-read the fingerprint on $device; if it still differs, treat the hub as suspect."
if [ -t 0 ]; then read -rp "They match. Type yes to trust $device: " ans; [ "$ans" = yes ] || die "not confirmed"; else die "needs a terminal to confirm"; fi

run_argo() { runuser -u "$SVC_USER" -- env -i HOME="$DATA" PATH=/usr/local/bin:/usr/bin:/bin ARGO_NO_DESKTOP=1 argo "$@"; }
run_argo keys trust "$device"
run_argo keys list | grep -F "$device" | { read -r _ rest; [ "$(norm "$rest")" = "$(norm "$expected")" ] || die "pinned key differs from what you confirmed; stopping"; }
systemctl enable --now argo-relay.service
echo "trusting $device; argo-relay is running. Check: systemctl status argo-relay"
