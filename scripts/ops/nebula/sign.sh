#!/usr/bin/env bash
# Sign one device's Nebula certificate with the Lightbound mesh CA, on the CA Mac. Josh runs it; never an agent.
#
#   bash scripts/ops/nebula/sign.sh DEVICE OVERLAY_IP GROUPS --pub FILE [--duration 720h] [--out DIR]
#                                   [--cert-version 1|2] [--dry-run]
#
#   DEVICE      lowercase letters, digits, dashes (the certificate name), e.g. talos
#   OVERLAY_IP  10.117.0.N (README "Overlay addresses": .1-.9 lighthouses, .10-.49 servers, .50-.99 laptops,
#               .100-.149 phones)
#   GROUPS      comma list from: hub, gate, dev, phone (hub only on .1-.9, and .1-.9 only for hub)
#   --pub FILE  the device's PUBLIC key, made ON the device with `nebula-cert keygen` (or shown by Mobile Nebula).
#               The private key never leaves the device; a private key given here is refused.
#   --duration  default 720h (30 days); at most 2160h (90 days). Argo warns 7 days before expiry.
#
# The CA key is read from the Keychain (the Mac asks: click Allow, never Always Allow) and goes through a pipe
# into `nebula-cert sign -ca-key -`; it is never written to a file. The new certificate is checked against the CA,
# written to DIR/DEVICE.crt (default ~/.config/gauss/nebula/issued) and recorded in issued.tsv (public facts only).
# Running it again for the same device and address renews the certificate.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
DURATION=720h; OUT=""; PUB=""; VERSION=""; DRY=0; pos=()
while [ $# -gt 0 ]; do
  case "$1" in
    --pub) [ $# -ge 2 ] || die "--pub needs a file"; PUB="$2"; shift ;;
    --duration) [ $# -ge 2 ] || die "--duration needs a value"; DURATION="$2"; shift ;;
    --out) [ $# -ge 2 ] || die "--out needs a directory"; OUT="$2"; shift ;;
    --cert-version) [ $# -ge 2 ] || die "--cert-version needs 1 or 2"; VERSION="$2"; shift ;;
    --dry-run) DRY=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) pos+=("$1") ;;
  esac
  shift
done
[ "${#pos[@]}" -eq 3 ] || die "usage: sign.sh DEVICE OVERLAY_IP GROUPS --pub FILE (try --help)"
device="${pos[0]}"; ip="${pos[1]}"; groups="${pos[2]}"
valid_device "$device" || die "device name must be lowercase letters, digits, dashes (at most 32)"
valid_overlay_ip "$ip" || die "overlay address must be $NEBULA_NET_PREFIX.1 to $NEBULA_NET_PREFIX.254"
valid_groups "$groups" || die "groups must be a comma list from: $NEBULA_GROUPS_ALLOWED (no repeats)"
host="${ip##*.}"
case ",$groups," in
  *,hub,*) [ "$host" -le 9 ] || die "group hub is only for lighthouses on $NEBULA_NET_PREFIX.1-.9" ;;
  *) [ "$host" -ge 10 ] || die "$NEBULA_NET_PREFIX.1-.9 are kept for lighthouses (group hub)" ;;
esac
valid_duration "$DURATION" 2160 || die "--duration must be whole hours, at most 2160h (90 days); default 720h"
case "$VERSION" in ""|1|2) ;; *) die "--cert-version must be 1 or 2" ;; esac
[ -n "$PUB" ] || die "--pub FILE is required: the device's public key (made on the device)"
[ -f "$PUB" ] || die "no such public key file: $PUB"
[ "$(wc -c < "$PUB" | tr -d ' ')" -le 1024 ] || die "$PUB is too big to be a Nebula public key"
if grep -q 'PRIVATE KEY' "$PUB"; then
  die "$PUB is a PRIVATE key. It has left its device: make a new key pair on the device and send only the .pub"
fi
grep -Eq '^-----BEGIN NEBULA (X25519|P256) PUBLIC KEY-----$' "$PUB" || die "$PUB is not a Nebula public key"
[ "$(id -u)" != 0 ] || die "run as yourself, not root: the CA key is in your login Keychain"

CA_CRT="$GAUSS_NEBULA_DIR/ca.crt"
LEDGER="$GAUSS_NEBULA_DIR/issued.tsv"
OUT="${OUT:-$GAUSS_NEBULA_DIR/issued}"

# One address per device and one device per address, so a typo can't hand one machine another's address.
if [ -f "$LEDGER" ]; then
  other=$(awk -F'\t' -v ip="$ip" -v d="$device" '$3 == ip && $2 != d { print $2; exit }' "$LEDGER")
  [ -z "$other" ] || die "$ip was issued to $other; pick another address (or revoke $other first, README)"
  prev=$(awk -F'\t' -v ip="$ip" -v d="$device" '$2 == d && $3 != ip { print $3; exit }' "$LEDGER")
  [ -z "$prev" ] || die "$device already has $prev; renew it on that address"
fi

vflag=""; [ -z "$VERSION" ] || vflag="-version $VERSION"
if [ "$DRY" = 1 ]; then
  say "DRY RUN: nothing below is executed."
  echo "   + security find-generic-password -s $KEYCHAIN_SERVICE -a $KEYCHAIN_ACCOUNT -w | base64 -d |"
  echo "     nebula-cert sign -ca-key - -ca-crt $CA_CRT -name $device -networks $ip/24 -groups $groups -duration $DURATION ${vflag:+$vflag }-in-pub $PUB -out-crt <0700 temp>/$device.crt"
  echo "   + nebula-cert verify -ca $CA_CRT -crt <0700 temp>/$device.crt"
  echo "   + install -m 0644 <0700 temp>/$device.crt $OUT/$device.crt; append $LEDGER"
  exit 0
fi

[ -f "$CA_CRT" ] || die "no CA certificate at $CA_CRT: run ca.sh first"
command -v nebula-cert >/dev/null || die "nebula-cert not found: brew install nebula (1.12 or newer)"
command -v security >/dev/null || die "security (macOS) not found: the CA key lives in the Mac's Keychain"
keychain_has_ca || die "no CA key in the Keychain ($KEYCHAIN_SERVICE): run ca.sh first"

make_scratch
say "signing $device ($ip, groups $groups, $DURATION). The Mac asks for the Keychain item: click Allow."
# shellcheck disable=SC2086 # vflag is empty or two words
security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w | base64 -d \
  | nebula-cert sign -ca-key - -ca-crt "$CA_CRT" -name "$device" -networks "$ip/24" -groups "$groups" \
      -duration "$DURATION" $vflag -in-pub "$PUB" -out-crt "$SCRATCH/$device.crt" >/dev/null \
  || die "signing failed (Keychain refused, or nebula-cert rejected the request); nothing was written"
nebula-cert verify -ca "$CA_CRT" -crt "$SCRATCH/$device.crt" >/dev/null || die "the new certificate does not verify against $CA_CRT; not written"

json=$(nebula-cert print -json -path "$SCRATCH/$device.crt" | tr ',' '\n')
fp=$(printf '%s\n' "$json" | sed -n 's/.*"fingerprint":"\([0-9a-f]\{64\}\)".*/\1/p' | sed -n 1p)
not_after=$(printf '%s\n' "$json" | sed -n 's/.*"notAfter":"\([^"]*\)".*/\1/p' | sed -n 1p)
[ -n "$fp" ] || die "could not read the new certificate's fingerprint; not written"

install -d -m 0700 "$GAUSS_NEBULA_DIR" "$OUT"
install -m 0644 "$SCRATCH/$device.crt" "$OUT/$device.crt"
[ -f "$LEDGER" ] || printf 'issued\tdevice\tip\tgroups\tfingerprint\tnot_after\n' > "$LEDGER"
printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$device" "$ip" "$groups" "$fp" "$not_after" >> "$LEDGER"
chmod 0600 "$LEDGER"
say "signed: $OUT/$device.crt"
echo "    fingerprint: $fp"
echo "    valid until: ${not_after:-unknown}"
echo "    Copy it and $CA_CRT to $device as /etc/nebula/host.crt and /etc/nebula/ca.crt (both public)."
