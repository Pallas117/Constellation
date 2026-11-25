#!/usr/bin/env bash
# Create the Lightbound mesh CA for Nebula, once, on the CA Mac. Josh runs it at the Mac; never an agent.
#
#   bash scripts/ops/nebula/ca.sh [--duration 17520h] [--dry-run] [--help]
#
# - Uses the standard `nebula-cert ca` (Ed25519, certificate format v2), named "Lightbound mesh CA",
#   limited to the overlay 10.117.0.0/24 and the groups hub,gate,dev,phone.
# - The private key goes from nebula-cert's stdout through a pipe into the login Keychain (service
#   gauss-nebula-ca, account nebula-ca), via `security -i` reading the command on stdin: never on a command
#   line, never in a file. The item trusts no application, so every later use asks at the Mac (click Allow,
#   never Always Allow).
# - It then proves the Keychain copy works: it signs a throwaway certificate with it and checks that against
#   the new CA. Only then is the CA certificate (public) published to ~/.config/gauss/nebula/ca.crt.
# - It refuses to run if a CA already exists (Keychain item or published certificate).
# --dry-run prints what it would do and changes nothing.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

DURATION=17520h # 2 years; renew the CA before it ends (README)
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --duration) [ $# -ge 2 ] || die "--duration needs a value"; DURATION="$2"; shift ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done
valid_duration "$DURATION" 26280 || die "--duration must be whole hours, at most 26280h (3 years)"
[ "$(id -u)" != 0 ] || die "run as yourself, not root: the key goes in your login Keychain"

groups_csv=$(printf '%s' "$NEBULA_GROUPS_ALLOWED" | tr ' ' ',')
CA_CRT="$GAUSS_NEBULA_DIR/ca.crt"

if [ "$DRY" = 1 ]; then
  say "DRY RUN: nothing below is executed."
  echo "   + nebula-cert ca -name \"$CA_NAME\" -duration $DURATION -networks $NEBULA_NET_CIDR -groups $groups_csv -out-key - -out-crt <0700 temp>/ca.crt"
  echo "   + (key from stdout, base64) | security -i   # add-generic-password -s $KEYCHAIN_SERVICE -a $KEYCHAIN_ACCOUNT -T \"\" -w <on stdin>"
  echo "   + self-test: sign a throwaway certificate with the Keychain copy, nebula-cert verify it against the new CA"
  echo "   + publish $CA_CRT (0644) and print its fingerprint"
  exit 0
fi

[ "$(uname -s)" = Darwin ] || die "the CA lives in the macOS Keychain: run this on the CA Mac"
command -v security >/dev/null || die "security (macOS) not found"
command -v nebula-cert >/dev/null || die "nebula-cert not found: brew install nebula (1.12 or newer)"
keychain_has_ca && die "a CA key is already in the Keychain ($KEYCHAIN_SERVICE); refusing to overwrite. See README: rotating the CA"
[ ! -e "$CA_CRT" ] || die "$CA_CRT already exists; refusing to overwrite. See README: rotating the CA"

make_scratch
say "creating the CA (Ed25519) and storing its key in the login Keychain"
# The key travels: nebula-cert stdout -> base64 (one line) -> one `security -i` command on stdin.
# base64 has no quote, space or backslash, so the quoted -w argument is parsed as-is.
nebula-cert ca -name "$CA_NAME" -duration "$DURATION" -networks "$NEBULA_NET_CIDR" -groups "$groups_csv" \
    -out-key - -out-crt "$SCRATCH/ca.crt" \
  | { b64=$(base64 | tr -d '\n')
      [ -n "$b64" ] || exit 1
      printf 'add-generic-password -s %s -a %s -l "%s" -D "Nebula CA private key (PEM, base64)" -T "" -w "%s"\n' \
        "$KEYCHAIN_SERVICE" "$KEYCHAIN_ACCOUNT" "$CA_NAME" "$b64"
      b64=""; } \
  | security -i >/dev/null \
  || die "creating or storing the CA failed; nothing was published"
[ -s "$SCRATCH/ca.crt" ] || die "nebula-cert wrote no CA certificate; nothing was published"
keychain_has_ca || die "the Keychain item is missing after adding it; nothing was published"

say "self-test: the Keychain copy signs, and the result verifies against the new CA (the Mac asks: click Allow)"
nebula-cert keygen -out-key - -out-pub "$SCRATCH/selftest.pub" >/dev/null # throwaway key, discarded
security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" -w | base64 -d \
  | nebula-cert sign -ca-key - -ca-crt "$SCRATCH/ca.crt" -name selftest -networks "$NEBULA_LIGHTHOUSE_IP/24" \
      -groups hub -duration 1h -in-pub "$SCRATCH/selftest.pub" -out-crt "$SCRATCH/selftest.crt" >/dev/null \
  && nebula-cert verify -ca "$SCRATCH/ca.crt" -crt "$SCRATCH/selftest.crt" >/dev/null \
  || die "self-test failed: the CA was NOT published. Remove the Keychain item by hand (security delete-generic-password -s $KEYCHAIN_SERVICE -a $KEYCHAIN_ACCOUNT) and run again"

install -d -m 0700 "$GAUSS_NEBULA_DIR"
install -m 0644 "$SCRATCH/ca.crt" "$CA_CRT"
fp=$(fingerprint_of "$CA_CRT")
say "CA ready. Public certificate: $CA_CRT"
echo "    fingerprint: ${fp:-unknown}"
echo "    Copy ca.crt (public) to each device. The key stays in the Keychain; back it up only to an offline,"
echo "    encrypted place you control (README: backup). Next: sign the lighthouse with sign.sh."
