# shellcheck shell=bash
# Shared by the Nebula kit scripts (scripts/ops/nebula). Sourced, never run. Bash 3.2 safe (macOS).
# Nothing here holds a secret.

# The overlay: 10.117.0.0/24. Why this range (README "Overlay addresses"): Tailscale uses 100.64.0.0/10 and
# both meshes run side by side during the move; the usual defaults (10.0.x cloud networks, 10.8 OpenVPN,
# 10.32-10.47 Weave, 10.42/10.43 k3s, 10.96 Kubernetes services, 10.128.0.0/9 GCP, 10.244 flannel, 172.16/12
# Docker and the iPhone hotspot, 192.168/16 home routers) are all avoided. A /24 is more specific than any LAN
# /8 or /16, so the overlay route wins unless a LAN uses exactly this /24.
NEBULA_NET_PREFIX="10.117.0"
NEBULA_NET_CIDR="10.117.0.0/24"
NEBULA_LIGHTHOUSE_IP="10.117.0.1"
NEBULA_PORT=4242

# Groups a certificate may carry. Firewall rules match on these (config/*.yml); the CA is limited to them.
NEBULA_GROUPS_ALLOWED="hub gate dev phone"

# The CA private key lives only in the login Keychain under this service and account.
KEYCHAIN_SERVICE="gauss-nebula-ca"
KEYCHAIN_ACCOUNT="nebula-ca"
CA_NAME="Lightbound mesh CA"

# Public material (CA certificate, issued-certificate ledger) on the CA Mac. Never a private key.
GAUSS_NEBULA_DIR="${GAUSS_NEBULA_DIR:-$HOME/.config/gauss/nebula}"

# System tools come from system directories first, so a file in a user-writable bin directory can't stand
# in for `security`. Homebrew is last (nebula-cert lives there). Tests set NEBULA_KIT_PATH to their stubs.
PATH="${NEBULA_KIT_PATH:-/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin}"
export PATH

die() { printf '%s: %s\n' "${0##*/}" "$*" >&2; exit 1; }
say() { printf '==> %s\n' "$*"; }

valid_device() { [[ "$1" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]]; }

# valid_overlay_ip 10.117.0.N with N in 1..254, no leading zeros.
valid_overlay_ip() {
  local n
  case "$1" in "$NEBULA_NET_PREFIX".*) n="${1#"$NEBULA_NET_PREFIX".}" ;; *) return 1 ;; esac
  [[ "$n" =~ ^(0|[1-9][0-9]{0,2})$ ]] || return 1
  [ "$n" -ge 1 ] && [ "$n" -le 254 ]
}

# valid_groups "a,b": every group allowed, none repeated, at least one.
valid_groups() {
  local g seen=" " IFS=,
  [ -n "$1" ] || return 1
  case "$1" in ,*|*,|*,,*) return 1 ;; esac
  for g in $1; do
    case " $NEBULA_GROUPS_ALLOWED " in *" $g "*) ;; *) return 1 ;; esac
    case "$seen" in *" $g "*) return 1 ;; esac
    seen="$seen$g "
  done
}

# valid_duration: hours only, as nebula-cert takes them (e.g. 720h); 1h..8760h for device certs.
valid_duration() {
  [[ "$1" =~ ^[1-9][0-9]{0,4}h$ ]] || return 1
  [ "${1%h}" -le "${2:-8760}" ]
}

# A 0700 scratch directory, removed on exit. It holds public material and the new certificate only: the CA
# key goes through pipes (nebula-cert's "-" paths, nebula-cert 1.12+), never into a file, so there is nothing
# to shred (overwriting a file doesn't reliably erase it on APFS or an SSD anyway).
SCRATCH=""
wipe_scratch() {
  [ -n "$SCRATCH" ] && [ -d "$SCRATCH" ] || return 0
  rm -rf "$SCRATCH"
}
make_scratch() {
  SCRATCH=$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/gauss-nebula.XXXXXX") || die "could not make a temp dir"
  chmod 0700 "$SCRATCH"
  trap wipe_scratch EXIT
  trap 'wipe_scratch; exit 130' INT TERM HUP
}

keychain_has_ca() { security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$KEYCHAIN_ACCOUNT" >/dev/null 2>&1; }

# fingerprint_of <cert>: the hex fingerprint nebula-cert prints (public; used for the blocklist).
fingerprint_of() {
  nebula-cert print -json -path "$1" | tr ',' '\n' | sed -n 's/.*"fingerprint":"\([0-9a-f]\{64\}\)".*/\1/p' | sed -n 1p
}
