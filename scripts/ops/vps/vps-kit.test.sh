#!/bin/bash
# Tests for the VPS kit (scripts/ops/vps). Nothing here installs, enrols or touches a network:
# bootstrap.sh and confirm-peer.sh are run with --dry-run or with bad input, and the unit files
# and scripts are checked as text.
#   bash scripts/ops/vps/vps-kit.test.sh      (part of the ops tests)
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
B="$D/bootstrap.sh"; C="$D/confirm-peer.sh"; H="$D/systemd/gauss-hub.service"; A="$D/systemd/argo-relay.service"

# --- bootstrap.sh dry run ---
out=$(TS_AUTHKEY=tskey-auth-TESTSECRET0123 bash "$B" --dry-run 2>&1); rc=$?
[ "$rc" = 0 ]; expect "vps bootstrap --dry-run exits 0 without root, network or a prompt" $?
n=$(printf '%s\n' "$out" | grep -c '^==> [1-9]/9 '); [ "$n" = 9 ]; expect "vps bootstrap --dry-run lists all nine steps" $?
[[ "$out" != *TESTSECRET0123* && "$out" != *tskey-* ]]; expect "vps bootstrap never prints the Tailscale auth key" $?
[[ "$out" == *"--auth-key=file:"* && "$out" != *"--auth-key=tskey"* ]]; expect "vps bootstrap passes the auth key to tailscale as a file, not on the command line" $?
[[ "$out" == *"tailscale serve --bg --https=443 http://127.0.0.1:3001"* ]]; expect "vps hub is exposed on the tailnet only through tailscale serve to 127.0.0.1" $?
[[ "$out" == *"ufw default deny incoming"* && "$out" == *"ufw allow in on tailscale0"* ]]; expect "vps firewall denies incoming except on tailscale0" $?
fw=$(printf '%s\n' "$out" | grep -n 'ufw --force enable' | cut -d: -f1); sv=$(printf '%s\n' "$out" | grep -n 'tailscale serve' | tail -n1 | cut -d: -f1)
[ -n "$fw" ] && [ -n "$sv" ] && [ "$fw" -gt "$sv" ]; expect "vps firewall is enabled last, after the tailnet exposure works" $?
[[ "$out" == *"unattended-upgrades"* && "$out" == *"20auto-upgrades"* ]]; expect "vps unattended security upgrades are installed and switched on" $?
[[ "$out" == *"useradd --system"*"/usr/sbin/nologin gauss"* ]]; expect "vps services run as a non-login system user" $?
[[ "$out" != *"enable --now argo-relay"* ]]; expect "vps bootstrap leaves the Argo relay stopped until fingerprints are confirmed" $?
[[ "$out" == *"sha256"* || "$out" == *"SHA-256"* ]]; expect "vps downloads of Node and Go are checked against published checksums" $?

# --- bootstrap.sh --mesh nebula|both (the Nebula lighthouse, scripts/ops/nebula) ---
[[ "$out" != *"4242"* && "$out" != *"nebula"* ]]; expect "vps default (tailscale) path is unchanged: no Nebula" $?
nout=$(bash "$B" --mesh nebula --dry-run 2>&1); rc=$?
[ "$rc" = 0 ] && [ "$(printf '%s\n' "$nout" | grep -c '^==> [1-9]/9 ')" = 9 ]; expect "vps bootstrap --mesh nebula --dry-run exits 0 with all nine steps" $?
[[ "$nout" == *"fetch.sh linux-"* && "$nout" == *"nebula-cert keygen -out-key /etc/nebula/host.key"* && "$nout" == *"config/lighthouse.yml /etc/nebula/config.yml"* ]]
expect "vps nebula: pinned release, key pair made on the VPS, lighthouse config" $?
[[ "$nout" != *"tailscale up"* && "$nout" != *"tailscale serve"* && "$nout" != *"tailscale0"* ]]; expect "vps --mesh nebula never joins or uses Tailscale" $?
[[ "$nout" == *"ufw allow 4242/udp"* && "$nout" == *"ufw allow in on nebula1"* && "$nout" != *"allow 22"* && "$nout" != *"OpenSSH"* ]]
expect "vps nebula firewall opens only UDP 4242 publicly; SSH stays off the public address" $?
fw=$(printf '%s\n' "$nout" | grep -n 'ufw --force enable' | cut -d: -f1); nb=$(printf '%s\n' "$nout" | grep -n 'enable --now nebula.service' | cut -d: -f1)
[ -n "$fw" ] && [ -n "$nb" ] && [ "$fw" -gt "$nb" ]; expect "vps nebula firewall is enabled last, after Nebula starts" $?
[[ "$nout" == *"hub stays on 127.0.0.1:3001"* ]]; expect "vps --mesh nebula keeps the hub on loopback (SSH tunnel over Nebula)" $?
bout=$(bash "$B" --mesh both --dry-run 2>&1); rc=$?
[ "$rc" = 0 ] && [[ "$bout" == *"tailscale up"* && "$bout" == *"tailscale serve"* && "$bout" == *"ufw allow in on tailscale0"* && "$bout" == *"ufw allow 4242/udp"* ]]
expect "vps --mesh both runs Tailscale and the Nebula lighthouse side by side" $?
bash "$B" --mesh wireguard --dry-run >/dev/null 2>&1; [ $? = 1 ]; expect "vps bootstrap refuses an unknown --mesh" $?
grep -q 'UDP 4242' "$D/cloud-init.yaml"; expect "vps cloud-init documents the provider firewall: UDP 4242 only for Nebula" $?

# --- bootstrap.sh refuses bad input ---
bash "$B" --repo http://example.com/x.git --dry-run >/dev/null 2>&1; [ $? = 1 ]; expect "vps bootstrap refuses a non-https repo URL" $?
bash "$B" --ref 'main;rm -rf /' --dry-run >/dev/null 2>&1; [ $? = 1 ]; expect "vps bootstrap refuses a git ref with shell characters" $?
bash "$B" --nope >/dev/null 2>&1; [ $? = 1 ]; expect "vps bootstrap refuses an unknown option" $?
bash "$B" --help | grep -c -- '--dry-run' >/dev/null; expect "vps bootstrap --help documents --dry-run" $?
if [ "$(id -u)" != 0 ]; then bash "$B" >/dev/null 2>&1; [ $? = 1 ]; expect "vps bootstrap refuses to run for real without root" $?; fi

# --- confirm-peer.sh ---
bash "$C" laptop >/dev/null 2>&1; [ $? = 1 ]; expect "vps confirm-peer needs a device and a fingerprint" $?
bash "$C" laptop "AAAA BBBB" --dry-run >/dev/null 2>&1; [ $? = 1 ]; expect "vps confirm-peer refuses a short fingerprint" $?
bash "$C" 'Ju dith' "AAAA BBBB CCCC DDDD EEEE" --dry-run >/dev/null 2>&1; [ $? = 1 ]; expect "vps confirm-peer refuses an odd device name" $?
out=$(bash "$C" laptop "aaaa bbbb cccc dddd eeee" --dry-run 2>&1); [ $? = 0 ] && [[ "$out" == *"argo keys trust laptop"* ]]; expect "vps confirm-peer --dry-run accepts a valid fingerprint and changes nothing" $?
has 'MISMATCH: not trusting' "$C" && has 'enable --now argo-relay' "$C"; expect "vps confirm-peer refuses on mismatch and is the only thing that starts the relay" $?
has 'Type yes' "$C"; expect "vps confirm-peer asks for a typed yes before pinning" $?

# --- units ---
! grep -q '0\.0\.0\.0' "$H" "$A" && has 'EnvironmentFile=/etc/gauss/hub.env' "$H"; expect "vps hub unit reads its secrets from /etc/gauss/hub.env, not the unit" $?
has 'PROXY_HOST=127.0.0.1' "$B"; expect "vps hub environment binds the backend to 127.0.0.1" $?
bad=""
for u in "$H" "$A"; do has '^User=gauss' "$u" && has 'NoNewPrivileges=true' "$u" && has 'ProtectSystem=strict' "$u" && has 'MemoryMax=' "$u" || bad=1; done
[ -z "$bad" ]; expect "vps units run as gauss with NoNewPrivileges, ProtectSystem=strict and a memory cap" $?
has 'ExecStart=/usr/local/bin/argo loop' "$A" && has 'keys publish' "$A"; expect "vps relay unit runs argo loop and publishes its key" $?
has '^Requires=gauss-hub.service' "$A"; expect "vps relay unit starts after the hub it uses" $?

# --- no secrets, no weakened TLS anywhere in the kit ---
! grep -rIEn 'tskey-(auth|api|client)-[A-Za-z0-9]{6,}|BEGIN [A-Z ]*PRIVATE KEY' "$D" --exclude=vps-kit.test.sh >/dev/null; expect "vps kit contains no keys or tokens" $?
! grep -rIEn 'curl +(-[A-Za-z]*k|--insecure)|InsecureSkipVerify|NODE_TLS_REJECT_UNAUTHORIZED|--no-check-certificate' "$D" --exclude=vps-kit.test.sh >/dev/null; expect "vps kit never weakens TLS verification" $?
! { grep -hEv '^ *#' "$B" "$C" | grep -v 'sudo bash' | grep -E 'curl[^|]*\| *(ba)?sh|sudo '; } >/dev/null; expect "vps scripts never pipe a download into a shell or call sudo themselves" $?

# --- static checks ---
if command -v shellcheck >/dev/null; then shellcheck -S warning "$B" "$C" "$0"; expect "vps scripts are shellcheck-clean" $?
else bash -n "$B" && bash -n "$C" && bash -n "$0"; expect "vps scripts parse (shellcheck not installed here, UNVERIFIED lint)" $?; fi

[ -z "$JUNIT" ] || junit_write vps-kit "$JUNIT"
echo "vps-kit: $pass passed, $failed failed"
[ "$failed" = 0 ]
