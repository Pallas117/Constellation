#!/bin/bash
# Tests for the Nebula kit (scripts/ops/nebula). Nothing here installs Nebula, touches the real Keychain, runs
# sudo or makes a real key: nebula-cert, security, curl, sudo, systemctl and launchctl are stubs on a private
# PATH (NEBULA_KIT_PATH), and every file lives in a temp dir that is removed at the end.
#   bash scripts/ops/nebula/nebula-kit.test.sh      (part of the ops tests)
#   GAUSS_OPS_JUNIT=<file> also writes a JUnit report, one case per expect, named as the expect.
set -uo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
JUNIT="${GAUSS_OPS_JUNIT:-}"; [ -z "$JUNIT" ] || . "$D/../junit.sh"
pass=0; failed=0
expect() { # expect <name> <condition-exit-code>
  if [ "$2" = 0 ]; then pass=$((pass + 1)); echo "  ✓ $1"; else failed=$((failed + 1)); echo "  ✗ $1"; fi
  [ -z "$JUNIT" ] || junit_case "$1" "$2"
}
has() { grep -q -- "$1" "$2"; }
# Run every script under macOS's own bash 3.2 when it is there, so the kit stays 3.2 safe.
BASH_BIN=/bin/bash; [ -x "$BASH_BIN" ] || BASH_BIN=bash

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
STUB="$W/stub"; mkdir -p "$STUB" "$W/tmp"
SECRET="FAKECAKEYSECRET0123456789"   # what the stub CA key contains; must never reach argv, logs or a file
export STUB SECRET

# --- stubs ---------------------------------------------------------------------------------------------
cat > "$STUB/nebula-cert" <<'EOF'
#!/bin/bash
# Stub nebula-cert: logs argv, imitates the "-" stdio paths of nebula-cert 1.12.
printf '%s\n' "$*" >> "$STUB/nebula-cert.argv"
sub="$1"; shift
get() { local want="$1"; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { printf '%s' "$2"; return; }; shift; done; }
case "$sub" in
  ca)
    printf -- '-----BEGIN NEBULA ED25519 PRIVATE KEY-----\n%s\n-----END NEBULA ED25519 PRIVATE KEY-----\n' "$SECRET"
    printf -- '-----BEGIN NEBULA CERTIFICATE V2-----\nCAPUB\n-----END NEBULA CERTIFICATE V2-----\n' > "$(get -out-crt "$@")" ;;
  keygen)
    printf -- '-----BEGIN NEBULA X25519 PRIVATE KEY-----\nTHROWAWAY\n-----END NEBULA X25519 PRIVATE KEY-----\n'
    printf -- '-----BEGIN NEBULA X25519 PUBLIC KEY-----\nPUB\n-----END NEBULA X25519 PUBLIC KEY-----\n' > "$(get -out-pub "$@")" ;;
  sign)
    key=$(cat)
    case "$key" in *"$SECRET"*) echo ok >> "$STUB/sign.gotkey" ;; *) echo "no ca key on stdin" >&2; exit 1 ;; esac
    out=$(get -out-crt "$@"); [ ! -e "$out" ] || { echo "refusing to overwrite existing cert" >&2; exit 1; }
    printf -- '-----BEGIN NEBULA CERTIFICATE V2-----\n%s\n-----END NEBULA CERTIFICATE V2-----\n' "$(get -name "$@")" > "$out" ;;
  verify) [ -z "${STUB_VERIFY_FAIL:-}" ] ;;
  print) printf '[{"details":{"name":"x","isCa":false,"notAfter":"2026-12-25T12:00:00Z"},"fingerprint":"%s","version":2}]\n' \
           "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ;;
  *) exit 2 ;;
esac
EOF
cat > "$STUB/security" <<'EOF'
#!/bin/bash
# Stub macOS security: a one-item "Keychain" in $STUB/keychain.
printf '%s\n' "$*" >> "$STUB/security.argv"
case "$1" in
  -i) line=$(cat); printf '%s\n' "$line" > "$STUB/security.stdin"
      case "$line" in add-generic-password*' -T ""'*' -w "'*) ;; *) exit 1 ;; esac
      b64=${line##*-w \"}; printf '%s' "${b64%\"}" > "$STUB/keychain" ;;
  find-generic-password)
    [ -f "$STUB/keychain" ] || exit 44
    case " $* " in *" -w "*) cat "$STUB/keychain"; echo ;; esac ;;
  *) exit 2 ;;
esac
EOF
for t in sudo systemctl launchctl; do printf '#!/bin/bash\necho "%s $*" >> "$STUB/forbidden.log"\nexit 1\n' "$t" > "$STUB/$t"; done
cat > "$STUB/curl" <<'EOF'
#!/bin/bash
printf '%s\n' "$*" >> "$STUB/curl.argv"
while [ $# -gt 0 ]; do [ "$1" = -o ] && { echo "not the real release" > "$2"; }; shift; done
EOF
printf '#!/bin/bash\ncase "$1" in -m) echo arm64 ;; *) echo Darwin ;; esac\n' > "$STUB/uname"
chmod +x "$STUB"/*
export NEBULA_KIT_PATH="$STUB:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH="$STUB:$PATH" # belt and braces: no script here may reach the real curl, sudo or security
export TMPDIR="$W/tmp" GAUSS_NEBULA_DIR="$W/neb"
CA="$D/ca.sh"; S="$D/sign.sh"; F="$D/fetch.sh"; N="$D/node-setup.sh"
no_secret_anywhere() { ! grep -rqs -- "$SECRET" "$W/neb" "$W/tmp" "$STUB/nebula-cert.argv" "$STUB/security.argv"; }

# --- ca.sh ---------------------------------------------------------------------------------------------
out=$("$BASH_BIN" "$CA" --dry-run 2>&1); rc=$?
[ "$rc" = 0 ] && [ ! -e "$W/neb" ] && [ ! -e "$STUB/keychain" ] && [[ "$out" == *"-out-key -"* ]]
expect "nebula ca --dry-run changes nothing and shows the key going to stdout, not a file" $?
out=$("$BASH_BIN" "$CA" 2>&1); rc=$?
[ "$rc" = 0 ] && [ -f "$W/neb/ca.crt" ] && [ -s "$STUB/keychain" ]; expect "nebula ca stores the key in the Keychain and publishes the CA certificate" $?
[ "$(stat -f %Lp "$W/neb/ca.crt" 2>/dev/null || stat -c %a "$W/neb/ca.crt")" = 644 ]; expect "nebula ca certificate is published world-readable (it is public)" $?
has 'ca -name Lightbound mesh CA -duration 17520h -networks 10.117.0.0/24 -groups hub,gate,dev,phone -out-key -' "$STUB/nebula-cert.argv"
expect "nebula CA is Ed25519 by default, two years, limited to the overlay /24 and the four groups" $?
has '^-i$' "$STUB/security.argv" && ! grep -q 'add-generic-password' "$STUB/security.argv"
expect "nebula ca hands the key to security on stdin (security -i), never on its command line" $?
has '-s gauss-nebula-ca -a nebula-ca' "$STUB/security.stdin" && has '-T ""' "$STUB/security.stdin"
expect "nebula ca Keychain item is service gauss-nebula-ca and trusts no app (every use asks at the Mac)" $?
[ "$(base64 -d < "$STUB/keychain" 2>/dev/null | grep -c "$SECRET")" = 1 ]; expect "nebula ca Keychain copy holds the whole key (base64 PEM)" $?
no_secret_anywhere && [[ "$out" != *"$SECRET"* && "$out" != *"$(cat "$STUB/keychain")"* ]]
expect "nebula ca never writes the CA key to a file, argv or its output" $?
[ -z "$(ls -A "$W/tmp")" ]; expect "nebula ca removes its temp dir" $?
[ -f "$STUB/sign.gotkey" ] && has 'verify -ca' "$STUB/nebula-cert.argv"; expect "nebula ca self-tests the Keychain copy by signing and verifying before publishing" $?
before=$(cksum < "$W/neb/ca.crt"); "$BASH_BIN" "$CA" >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ] && [ "$(cksum < "$W/neb/ca.crt")" = "$before" ]; expect "nebula ca refuses to overwrite an existing CA" $?
mv "$STUB/keychain" "$W/kc.bak"; "$BASH_BIN" "$CA" >/dev/null 2>&1; rc=$?; mv "$W/kc.bak" "$STUB/keychain"
[ "$rc" = 1 ]; expect "nebula ca refuses when a CA certificate is already published" $?
rm -rf "$W/neb2"; mv "$STUB/keychain" "$W/kc.keep"
STUB_VERIFY_FAIL=1 GAUSS_NEBULA_DIR="$W/neb2" "$BASH_BIN" "$CA" >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ] && [ ! -e "$W/neb2/ca.crt" ]; expect "nebula ca publishes nothing when the self-test fails" $?
mv "$W/kc.keep" "$STUB/keychain"
"$BASH_BIN" "$CA" --duration 999999h --dry-run >/dev/null 2>&1; [ $? = 1 ]; expect "nebula ca refuses an absurd CA lifetime" $?

# --- sign.sh -------------------------------------------------------------------------------------------
PUB="$W/talos.pub"; printf -- '-----BEGIN NEBULA X25519 PUBLIC KEY-----\nPUB\n-----END NEBULA X25519 PUBLIC KEY-----\n' > "$PUB"
PRIV="$W/oops.key"; printf -- '-----BEGIN NEBULA X25519 PRIVATE KEY-----\nX\n-----END NEBULA X25519 PRIVATE KEY-----\n' > "$PRIV"
refuse() { "$BASH_BIN" "$S" "$@" --dry-run >/dev/null 2>&1; [ $? = 1 ]; }
bad=""
for args in "Ta los|10.117.0.10|gate" "talos|10.117.1.10|gate" "talos|100.64.0.10|gate" "talos|10.117.0.0|gate" \
            "talos|10.117.0.255|gate" "talos|10.117.0.010|gate" "talos|10.117.0.10|admin" "talos|10.117.0.10|dev,dev" \
            "talos|10.117.0.10|dev," "talos|10.117.0.10|" "talos|10.117.0.50|hub" "talos|10.117.0.1|gate"; do
  IFS='|' read -r a b c <<< "$args"
  refuse "$a" "$b" "$c" --pub "$PUB" || bad="$bad [$args]"
done
[ -z "$bad" ]; expect "nebula sign refuses bad names, addresses outside 10.117.0.1-254, unknown or repeated groups, and hub outside .1-.9" $?
refuse talos 10.117.0.10 gate; expect "nebula sign needs the device's public key" $?
out=$("$BASH_BIN" "$S" talos 10.117.0.10 gate --pub "$PRIV" --dry-run 2>&1); [ $? = 1 ] && [[ "$out" == *"has left its device"* ]]
expect "nebula sign refuses a private key and says it must be replaced" $?
refuse talos 10.117.0.10 gate --pub "$D/README.md"; expect "nebula sign refuses a file that is not a Nebula public key" $?
refuse talos 10.117.0.10 gate --pub "$PUB" --duration 9000h; expect "nebula sign refuses certificates longer than 90 days" $?
: > "$STUB/nebula-cert.argv"; rm -f "$STUB/sign.gotkey"
out=$("$BASH_BIN" "$S" talos 10.117.0.10 gate,dev --pub "$PUB" 2>&1); rc=$?
[ "$rc" = 0 ] && [ -f "$W/neb/issued/talos.crt" ] && [ -f "$STUB/sign.gotkey" ]; expect "nebula sign writes the certificate, with the CA key arriving on stdin" $?
has 'sign -ca-key - .* -name talos -networks 10.117.0.10/24 -groups gate,dev -duration 720h' "$STUB/nebula-cert.argv"
expect "nebula sign defaults to 30-day certificates on the given address and groups" $?
has 'verify -ca' "$STUB/nebula-cert.argv"; expect "nebula sign checks the new certificate against the CA before writing it" $?
awk -F'\t' '$2=="talos" && $3=="10.117.0.10" && $5 ~ /^[0-9a-f]{64}$/' "$W/neb/issued.tsv" | grep -q .; expect "nebula sign records device, address and fingerprint in issued.tsv" $?
no_secret_anywhere && [[ "$out" != *"$SECRET"* ]] && [ -z "$(ls -A "$W/tmp")" ]; expect "nebula sign leaves no CA key in files, argv, output or temp" $?
"$BASH_BIN" "$S" talos 10.117.0.10 gate,dev --pub "$PUB" >/dev/null 2>&1; expect "nebula sign renews the same device on the same address" $?
"$BASH_BIN" "$S" other 10.117.0.10 gate --pub "$PUB" >/dev/null 2>&1; [ $? = 1 ]; expect "nebula sign refuses an address already issued to another device" $?
"$BASH_BIN" "$S" talos 10.117.0.11 gate --pub "$PUB" >/dev/null 2>&1; [ $? = 1 ]; expect "nebula sign refuses to move a device to a second address" $?
: > "$STUB/nebula-cert.argv"; "$BASH_BIN" "$S" phone1 10.117.0.100 phone --pub "$PUB" --cert-version 1 >/dev/null 2>&1
has '-version 1' "$STUB/nebula-cert.argv"; expect "nebula sign can issue a v1 certificate for an older client" $?
mv "$STUB/keychain" "$W/kc.keep"; "$BASH_BIN" "$S" lh 10.117.0.1 hub --pub "$PUB" >/dev/null 2>&1; rc=$?; mv "$W/kc.keep" "$STUB/keychain"
[ "$rc" = 1 ]; expect "nebula sign refuses without a CA key in the Keychain" $?

# --- fetch.sh ------------------------------------------------------------------------------------------
"$BASH_BIN" "$F" linux-amd64 "$W/dl" >/dev/null 2>&1; rc=$?
[ "$rc" = 1 ] && [ ! -e "$W/dl/nebula" ]; expect "nebula fetch refuses a download whose SHA-256 differs from the pinned one" $?
has '--proto =https --tlsv1.2' "$STUB/curl.argv" && has 'releases/download/v1.12.0/nebula-linux-amd64.tar.gz' "$STUB/curl.argv"
expect "nebula fetch downloads the pinned release over https only" $?
[ "$(grep -cE '^SUM_linux_(amd64|arm64)=[0-9a-f]{64}$' "$F")" = 2 ]; expect "nebula fetch pins a SHA-256 for both Linux architectures" $?
"$BASH_BIN" "$F" darwin "$W/dl" >/dev/null 2>&1; [ $? = 1 ]; expect "nebula fetch refuses an unknown platform" $?

# --- node-setup.sh -------------------------------------------------------------------------------------
: > "$STUB/forbidden.log"
mac=$("$BASH_BIN" "$N" darwin --lighthouse 203.0.113.7 2>&1); rc1=$?
lin=$("$BASH_BIN" "$N" linux 2>&1); rc2=$?
[ "$rc1" = 0 ] && [ "$rc2" = 0 ] && [ ! -s "$STUB/forbidden.log" ]; expect "nebula node-setup only prints: it never runs sudo, systemctl or launchctl" $?
[[ "$mac" == *"sudo launchctl bootstrap system"* && "$lin" == *"sudo systemctl enable --now nebula"* ]]; expect "nebula node-setup prints the service commands for each platform" $?
[[ "$mac" == *"keygen -out-key /etc/nebula/host.key"* && "$mac" != *"cat /etc/nebula/host.key"* && "$lin" == *"chown nebula:nebula /etc/nebula/host.key"* ]]
expect "nebula node-setup makes the key pair on the device and only ever shows the public key" $?
[[ "$mac" == *"/usr/local/libexec/lightbound/"* && "$mac" == *"203.0.113.7"* && "$lin" == *"<lighthouse-public-ip>"* && "$lin" == *'fetch.sh" linux-'* ]]
expect "nebula node-setup uses a root-owned binary on the Mac, the pinned release on Linux, and the lighthouse address given" $?
"$BASH_BIN" "$N" darwin --lighthouse '1.2.3.4;rm' >/dev/null 2>&1; [ $? = 1 ]; expect "nebula node-setup refuses a lighthouse address with shell characters" $?

# --- configs -------------------------------------------------------------------------------------------
L="$D/config/lighthouse.yml"; T="$D/config/node-talos.yml"; M="$D/config/node-mac.yml"
has 'am_lighthouse: true' "$L" && has 'am_relay: true' "$L" && has 'port: 4242' "$L" && has 'hosts: \[\]' "$L"
expect "nebula lighthouse config: lighthouse and relay on UDP 4242, no upstream lighthouses" $?
bad=""
for c in "$T" "$M"; do
  has 'am_lighthouse: false' "$c" && has '"10.117.0.1": \["<lighthouse-public-ip>:4242"\]' "$c" && has 'punch: true' "$c" \
    && has 'use_relays: true' "$c" && has '- 10.117.0.1' "$c" && has 'port: 0' "$c" || bad=1
done
[ -z "$bad" ]; expect "nebula node configs: static host map to the lighthouse, punchy, relay through it" $?
inbound() { awk '/^  inbound:/{f=1;next} f&&/^  [a-z]/{f=0} f' "$1"; }
[ "$(inbound "$M" | grep -c 'port:')" = 1 ] && inbound "$M" | grep -q 'proto: icmp'; expect "nebula Mac accepts nothing inbound except ICMP" $?
ti=$(inbound "$T"); [ "$(printf '%s\n' "$ti" | grep -c 'port: 22')" = 2 ] && [[ "$ti" == *"group: gate"* && "$ti" == *"group: dev"* ]]
expect "nebula Talos allows SSH only from group gate or group dev (two rules)" $?
! grep -hv '^ *#' "$L" "$T" "$M" | grep -q 'groups:'; expect "nebula configs avoid groups: lists (they mean ALL groups, not any)" $?
bad=""; for c in "$L" "$T" "$M"; do has 'inbound_action: drop' "$c" && has 'disconnect_invalid: true' "$c" && has 'blocklist:' "$c" || bad=1; done
[ -z "$bad" ]; expect "nebula configs deny inbound by default, drop invalid certificates and carry a blocklist" $?
! grep -qE '^ *sshd:|^ *enabled: true' "$L" "$T" "$M"; expect "nebula configs leave Nebula's debug SSH server off" $?
if [ -x /usr/bin/ruby ]; then /usr/bin/ruby -ryaml -e 'ARGV.each { |f| YAML.safe_load(File.read(f)) }' "$L" "$T" "$M"; expect "nebula configs are valid YAML" $?
else expect "nebula configs are valid YAML (no YAML parser here: UNVERIFIED)" 0; fi

# --- service units -------------------------------------------------------------------------------------
U="$D/service/nebula.service"; P="$D/service/uk.lightbound.nebula.plist"
has '^User=nebula' "$U" && has '^CapabilityBoundingSet=CAP_NET_ADMIN$' "$U" && has 'NoNewPrivileges=true' "$U" && has 'ProtectSystem=strict' "$U" && has 'MemoryMax=' "$U"
expect "nebula systemd unit runs as user nebula with only CAP_NET_ADMIN, hardened and capped" $?
has '<string>/usr/local/libexec/lightbound/nebula</string>' "$P" && ! grep -q '<string>/opt/homebrew' "$P"
expect "nebula LaunchDaemon runs a root-owned copy, never a binary in user-writable Homebrew" $?
if [ -x /usr/bin/plutil ]; then /usr/bin/plutil -lint "$P" >/dev/null; expect "nebula LaunchDaemon plist is valid" $?; fi

# --- hygiene -------------------------------------------------------------------------------------------
! grep -rIEn 'BEGIN [A-Z0-9 ]*PRIVATE KEY' "$D" --exclude=nebula-kit.test.sh >/dev/null; expect "nebula kit contains no keys" $?
! grep -rIEn 'curl +(-[A-Za-z]*k|--insecure)|InsecureSkipVerify|--no-check-certificate' "$D" --exclude=nebula-kit.test.sh >/dev/null; expect "nebula kit never weakens TLS verification" $?
! grep -hEv '^ *#' "$CA" "$S" "$F" "$D/common.sh" | grep -qE '(^|[^a-z_-])sudo '; expect "nebula scripts never call sudo themselves" $?
ips=$(grep -rhoE '\b([0-9]{1,3}\.){3}[0-9]{1,3}\b' "$D" --exclude=nebula-kit.test.sh | sort -u | grep -vE '^(10\.117\.0\.[0-9]+|10\.0\.0\.0|10\.128\.0\.0|0\.0\.0\.0|127\.0\.0\.1|100\.64\.0\.0|172\.16\.0\.0|192\.168\.0\.0|172\.20\.10\.0|203\.0\.113\.[0-9]+|1\.2\.3\.4)$')
[ -z "$ips" ] || echo "    unexpected addresses: $ips"
[ -z "$ips" ]; expect "nebula kit holds no real public addresses (placeholders and the overlay only)" $?
bad=""; for f in "$CA" "$S" "$F" "$N" "$D/common.sh" "$0"; do "$BASH_BIN" -n "$f" || bad=1; done
if command -v shellcheck >/dev/null; then shellcheck -S warning -x "$CA" "$S" "$F" "$N" "$0" || bad=1; fi
[ -z "$bad" ]; expect "nebula scripts parse under bash 3.2 (shellcheck when installed)" $?

[ -z "$JUNIT" ] || junit_write nebula-kit "$JUNIT"
echo "nebula-kit: $pass passed, $failed failed"
[ "$failed" = 0 ]
