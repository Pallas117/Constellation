#!/usr/bin/env bash
# Print the commands that put one machine on the Nebula mesh. It PRINTS them only: it never runs sudo, never
# installs anything and never makes a key. You read them and run them yourself at that machine.
#
#   bash scripts/ops/nebula/node-setup.sh darwin|linux [--lighthouse ADDRESS] [--arch amd64|arm64]
#
#   darwin  the CA Mac (LaunchDaemon; Nebula from Homebrew, copied to a root-owned path)
#   linux   Talos (systemd; Nebula from the pinned release via fetch.sh)
#   --lighthouse  the VPS's public IPv4 address or DNS name; without it the commands show <lighthouse-public-ip>
#
# Step A makes the key pair ON the machine (the private key never leaves it) and shows the public key.
# Step B runs on the CA Mac (sign.sh). Step C (in the folder holding ca.crt and the signed .crt) installs the certificate, config and service, and starts Nebula.
# Tailscale keeps running throughout; nothing here touches it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"

os=""; LH="<lighthouse-public-ip>"; ARCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    darwin|linux) [ -z "$os" ] || die "one platform only"; os="$1" ;;
    --lighthouse) [ $# -ge 2 ] || die "--lighthouse needs an address"; LH="$2"; shift ;;
    --arch) [ $# -ge 2 ] || die "--arch needs amd64 or arm64"; ARCH="$2"; shift ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
  shift
done
[ -n "$os" ] || die "usage: node-setup.sh darwin|linux [--lighthouse ADDRESS] (try --help)"
if [ "$LH" != "<lighthouse-public-ip>" ]; then
  [[ "$LH" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$ ]] || die "--lighthouse must be an IPv4 address or a DNS name"
fi
case "$ARCH" in "") ARCH=$( [ "$(uname -m)" = aarch64 ] || [ "$(uname -m)" = arm64 ] && echo arm64 || echo amd64) ;; amd64|arm64) ;; *) die "--arch must be amd64 or arm64" ;; esac
REPO_NEBULA="$HERE"

cat <<EOF
Nothing below has been run. Read each line, then run it yourself on this $os machine.

# --- A. Key pair, made here (private key never leaves this machine) ---------------------------------------
EOF
if [ "$os" = darwin ]; then
  cat <<EOF
brew install nebula                       # 1.12 or newer (MIT); no sudo
sudo install -d -o root -g wheel -m 0755 /usr/local/libexec/lightbound /etc/nebula
sudo install -o root -g wheel -m 0755 "\$(brew --prefix nebula)/bin/nebula" "\$(brew --prefix nebula)/bin/nebula-cert" /usr/local/libexec/lightbound/
sudo /usr/local/libexec/lightbound/nebula -version
sudo sh -c 'umask 077 && /usr/local/libexec/lightbound/nebula-cert keygen -out-key /etc/nebula/host.key -out-pub /etc/nebula/host.pub'
sudo chmod 0644 /etc/nebula/host.pub
cat /etc/nebula/host.pub                  # public: this is what sign.sh needs
EOF
else
  cat <<EOF
bash "$REPO_NEBULA/fetch.sh" linux-$ARCH ~/nebula-dl    # pinned release, checksum checked; no sudo
sudo install -o root -g root -m 0755 ~/nebula-dl/nebula ~/nebula-dl/nebula-cert /usr/local/bin/
sudo useradd --system --no-create-home --shell /usr/sbin/nologin nebula
sudo install -d -o root -g root -m 0755 /etc/nebula
sudo sh -c 'umask 077 && /usr/local/bin/nebula-cert keygen -out-key /etc/nebula/host.key -out-pub /etc/nebula/host.pub'
sudo chown nebula:nebula /etc/nebula/host.key && sudo chmod 0644 /etc/nebula/host.pub
cat /etc/nebula/host.pub                  # public: this is what sign.sh needs
EOF
fi
if [ "$os" = darwin ]; then
  name="mac"; ip="$NEBULA_NET_PREFIX.50"; grp="dev"; cfg="node-mac.yml"
else
  name="talos"; ip="$NEBULA_NET_PREFIX.10"; grp="gate"; cfg="node-talos.yml"
fi
cat <<EOF

# --- B. On the CA Mac: sign the public key (copy host.pub there first; it is not secret) -----------------
bash scripts/ops/nebula/sign.sh $name $ip $grp --pub <path to $name's host.pub>
# then copy back ~/.config/gauss/nebula/issued/$name.crt and ~/.config/gauss/nebula/ca.crt (both public)

# --- C. Here: certificate, config, service ---------------------------------------------------------------
EOF
if [ "$os" = darwin ]; then
  cat <<EOF
sudo install -o root -g wheel -m 0644 ca.crt /etc/nebula/ca.crt
sudo install -o root -g wheel -m 0644 $name.crt /etc/nebula/host.crt
t=\$(mktemp) && sed 's/<lighthouse-public-ip>/$LH/' "$REPO_NEBULA/config/$cfg" > "\$t" && sudo install -o root -g wheel -m 0644 "\$t" /etc/nebula/config.yml; rm -f "\$t"
sudo /usr/local/libexec/lightbound/nebula -test -config /etc/nebula/config.yml
sudo install -o root -g wheel -m 0644 "$REPO_NEBULA/service/uk.lightbound.nebula.plist" /Library/LaunchDaemons/
sudo launchctl bootstrap system /Library/LaunchDaemons/uk.lightbound.nebula.plist
ping -c 3 $NEBULA_LIGHTHOUSE_IP && argo net status
# Roll back: sudo launchctl bootout system/uk.lightbound.nebula (Tailscale is untouched)
EOF
else
  cat <<EOF
sudo install -o root -g root -m 0644 ca.crt /etc/nebula/ca.crt
sudo install -o root -g root -m 0644 $name.crt /etc/nebula/host.crt
t=\$(mktemp) && sed 's/<lighthouse-public-ip>/$LH/' "$REPO_NEBULA/config/$cfg" > "\$t" && sudo install -o root -g root -m 0644 "\$t" /etc/nebula/config.yml; rm -f "\$t"
sudo -u nebula /usr/local/bin/nebula -test -config /etc/nebula/config.yml
sudo install -o root -g root -m 0644 "$REPO_NEBULA/service/nebula.service" /etc/systemd/system/nebula.service
sudo systemctl daemon-reload
sudo systemctl enable --now nebula
ping -c 3 $NEBULA_LIGHTHOUSE_IP && argo net status
# Roll back: sudo systemctl disable --now nebula (Tailscale is untouched)
EOF
fi
