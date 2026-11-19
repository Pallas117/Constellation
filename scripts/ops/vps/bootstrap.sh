#!/usr/bin/env bash
# First-boot setup for the always-on Gauss hub + Argo relay peer (Ubuntu LTS, arm64 or amd64).
# Josh runs it once, as root, on the VM. Nothing here runs from an agent or from CI.
#
#   sudo bash bootstrap.sh [--dry-run] [--ref GIT_REF] [--repo URL] [--help]
#
# What it does, in order (each step is safe to re-run):
#   1. packages: git, build tools, ufw, unattended-upgrades
#   2. Tailscale from its apt repo; joins the tailnet with an auth key you paste at the prompt
#      (or in TS_AUTHKEY). The key goes to a 0600 file in a temp dir, is passed to tailscale
#      as file:PATH (never on a command line), and is deleted on exit. It is never logged.
#   3. Node (the major in .nvmrc) from nodejs.org, checked against its SHASUMS256.txt
#   4. Go (the toolchain in tools/argo/go.mod) from go.dev, checked against go.dev's sha256
#   5. service user `gauss` (no login, no sudo); the repo in /opt/gauss/src; npm ci; Argo built from
#      source into /usr/local/bin/argo
#   6. /etc/gauss/hub.env (generated secrets, root 0600), systemd units, hub started on 127.0.0.1
#   7. `tailscale serve` puts the hub on the tailnet over HTTPS (the only way in)
#   8. Argo enrolls as device "vps" on this hub. The relay service is NOT started: run
#      confirm-peer.sh after you have compared fingerprints
#   9. firewall: deny all incoming except on tailscale0 (last, after the tailnet works)
#
# --dry-run prints every step and changes nothing (no root needed, no network, no prompt).
set -euo pipefail

REPO_URL="https://github.com/Pallas117/Constellation.git"
REF="main"
DRY=0
SRC=/opt/gauss/src
DATA=/var/lib/gauss
ETC=/etc/gauss
SVC_USER=gauss
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLEAN=()
cleanup() { [ ${#CLEAN[@]} -eq 0 ] || rm -rf "${CLEAN[@]}"; unset TS_AUTHKEY; }
trap cleanup EXIT

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
say() { printf '==> %s\n' "$*"; }
die() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a value"; REPO_URL="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done
case "$REPO_URL" in https://*) ;; *) die "--repo must be an https:// URL" ;; esac
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "--ref has odd characters"

# run: the one place a command executes. Dry run only prints it.
run() {
  if [ "$DRY" = 1 ]; then printf '   + %s\n' "$*"; else "$@"; fi
}
# as_svc: run a command as the service user in the checkout, with a clean environment.
as_svc() {
  run runuser -u "$SVC_USER" -- env -i HOME="$DATA" PATH=/usr/local/bin:/usr/bin:/bin "$@"
}

if [ "$DRY" = 0 ]; then
  [ "$(id -u)" = 0 ] || die "run as root: sudo bash $0"
  # shellcheck disable=SC1091
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] || die "Ubuntu expected (found ${ID:-unknown})"
  command -v apt-get >/dev/null || die "apt-get not found"
else
  say "DRY RUN: nothing below is executed."
fi

ARCH=$(dpkg --print-architecture 2>/dev/null || echo arm64)
case "$ARCH" in arm64) NODE_ARCH=arm64; GO_ARCH=arm64 ;; amd64) NODE_ARCH=x64; GO_ARCH=amd64 ;; *) die "unsupported CPU: $ARCH" ;; esac
CODENAME=$( (. /etc/os-release 2>/dev/null && echo "${VERSION_CODENAME:-noble}") || echo noble)

# --- 1. packages -------------------------------------------------------------------
say "1/9 packages"
run env DEBIAN_FRONTEND=noninteractive apt-get update -y
run env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg git build-essential python3 ufw unattended-upgrades openssl
run bash -c 'printf "%s\n" "APT::Periodic::Update-Package-Lists \"1\";" "APT::Periodic::Unattended-Upgrade \"1\";" > /etc/apt/apt.conf.d/20auto-upgrades'

# --- 2. Tailscale ------------------------------------------------------------------
say "2/9 Tailscale"
if [ "$DRY" = 1 ] || ! command -v tailscale >/dev/null; then
  run install -d -m 0755 /usr/share/keyrings
  run curl -fsSL -o /usr/share/keyrings/tailscale-archive-keyring.gpg "https://pkgs.tailscale.com/stable/ubuntu/${CODENAME}.noarmor.gpg"
  run curl -fsSL -o /etc/apt/sources.list.d/tailscale.list "https://pkgs.tailscale.com/stable/ubuntu/${CODENAME}.tailscale-keyring.list"
  run env DEBIAN_FRONTEND=noninteractive apt-get update -y
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y tailscale
fi
run systemctl enable --now tailscaled
if [ "$DRY" = 1 ]; then
  say "would join the tailnet: auth key from TS_AUTHKEY or a silent prompt, passed as --auth-key=file:<0600 temp file>"
  run tailscale up --hostname=gauss-hub --accept-dns=false --auth-key=file:/run/gauss-bootstrap/ts-authkey
elif tailscale ip -4 >/dev/null 2>&1; then
  say "already on the tailnet ($(tailscale ip -4 | sed -n 1p))"
else
  KEYDIR=$(mktemp -d /run/gauss-bootstrap.XXXXXX); CLEAN+=("$KEYDIR")
  chmod 0700 "$KEYDIR"
  if [ -z "${TS_AUTHKEY:-}" ]; then
    [ -t 0 ] || die "no TTY: set TS_AUTHKEY or run from a terminal"
    read -rsp "Paste the Tailscale auth key (hidden), then Enter: " TS_AUTHKEY; echo
  fi
  [ -n "$TS_AUTHKEY" ] || die "no auth key given"
  ( umask 077; printf '%s' "$TS_AUTHKEY" > "$KEYDIR/ts-authkey" )
  unset TS_AUTHKEY
  tailscale up --hostname=gauss-hub --accept-dns=false "--auth-key=file:$KEYDIR/ts-authkey"
  rm -rf "$KEYDIR"
fi

# --- 3. Node -----------------------------------------------------------------------
say "3/9 Node"
NODE_MAJOR=26
if [ -f "$HERE/../../../.nvmrc" ]; then NODE_MAJOR=$(tr -dc '0-9.' < "$HERE/../../../.nvmrc" | cut -d. -f1); fi
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || die "bad Node major: $NODE_MAJOR"
if [ "$DRY" = 1 ]; then
  say "would fetch https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/ (linux-${NODE_ARCH}), verify SHA-256 from SHASUMS256.txt, install to /opt/node, link /usr/local/bin/node|npm|npx"
elif ! { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" = "$NODE_MAJOR" ]; }; then
  T=$(mktemp -d); CLEAN+=("$T")
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  curl -fsSL -o "$T/SHASUMS256.txt" "$base/SHASUMS256.txt"
  f=$(awk -v a="linux-${NODE_ARCH}.tar.xz" '$2 ~ a"$" {print $2; exit}' "$T/SHASUMS256.txt")
  [ -n "$f" ] || die "no Node $NODE_MAJOR build for $NODE_ARCH"
  curl -fsSL -o "$T/$f" "$base/$f"
  (cd "$T" && grep " $f\$" SHASUMS256.txt | sha256sum -c -) || die "Node checksum mismatch"
  rm -rf /opt/node && mkdir -p /opt/node && tar -xJf "$T/$f" -C /opt/node --strip-components=1
  for b in node npm npx; do ln -sf "/opt/node/bin/$b" "/usr/local/bin/$b"; done
fi

# --- 4. Go (only to build Argo; stays out of PATH for the service) --------------------
say "4/9 Go toolchain for Argo"
GO_VER=1.26.10
if [ -f "$HERE/../../../tools/argo/go.mod" ]; then
  GO_VER=$(awk '$1=="toolchain"{sub(/^go/,"",$2); print $2}' "$HERE/../../../tools/argo/go.mod")
fi
[[ "$GO_VER" =~ ^[0-9]+\.[0-9]+(\.[0-9]+)?$ ]] || die "bad Go version: $GO_VER"
if [ "$DRY" = 1 ]; then
  say "would fetch go${GO_VER}.linux-${GO_ARCH}.tar.gz from https://go.dev/dl/, verify the sha256 listed at https://go.dev/dl/?mode=json&include=all, unpack to /opt/go"
elif [ ! -x /opt/go/bin/go ] || ! /opt/go/bin/go version | grep -c "go${GO_VER} " >/dev/null; then
  T2=$(mktemp -d); CLEAN+=("$T2")
  curl -fsSL -o "$T2/dl.json" "https://go.dev/dl/?mode=json&include=all"
  want=$(node -e '
    const [json, ver, file] = process.argv.slice(1);
    const rel = JSON.parse(require("fs").readFileSync(json, "utf8")).find((r) => r.version === "go" + ver);
    const f = rel && rel.files.find((x) => x.filename === file);
    if (f) console.log(f.sha256);' "$T2/dl.json" "$GO_VER" "go${GO_VER}.linux-${GO_ARCH}.tar.gz") || true
  [[ "$want" =~ ^[0-9a-f]{64}$ ]] || die "go.dev lists no checksum for go${GO_VER} linux-${GO_ARCH}"
  curl -fsSL -o "$T2/go.tgz" "https://go.dev/dl/go${GO_VER}.linux-${GO_ARCH}.tar.gz"
  echo "$want  $T2/go.tgz" | sha256sum -c - || die "Go checksum mismatch"
  rm -rf /opt/go && tar -xzf "$T2/go.tgz" -C /opt
fi

# --- 5. service user, source, build -------------------------------------------------
say "5/9 service user, source, build"
if [ "$DRY" = 1 ] || ! id "$SVC_USER" >/dev/null 2>&1; then
  run useradd --system --home-dir "$DATA" --create-home --shell /usr/sbin/nologin "$SVC_USER"
fi
run install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA" "$DATA/mesh" "$DATA/mesh/bundles"
if [ "$DRY" = 1 ] || [ ! -d "$SRC/.git" ]; then
  run install -d -m 0755 -o "$SVC_USER" -g "$SVC_USER" /opt/gauss
  run runuser -u "$SVC_USER" -- git clone --branch "$REF" "$REPO_URL" "$SRC"
else
  run runuser -u "$SVC_USER" -- git -C "$SRC" fetch --tags origin
  run runuser -u "$SVC_USER" -- git -C "$SRC" checkout "$REF"
fi
as_svc sh -c "cd $SRC && npm ci"
as_svc sh -c "cd $SRC && npm run -s auth:migrate"
run env GOTOOLCHAIN=local GOFLAGS=-trimpath CGO_ENABLED=0 /opt/go/bin/go -C "$SRC/tools/argo" build -o /usr/local/bin/argo .
run chmod 0755 /usr/local/bin/argo

# --- 6. hub environment and units ---------------------------------------------------
say "6/9 hub environment and systemd units"
run install -d -m 0755 "$ETC"
if [ "$DRY" = 1 ]; then
  say "would write $ETC/hub.env (0600 root) with generated DEVICE_AUTH_SECRET and BETTER_AUTH_SECRET; values are never printed"
elif [ ! -f "$ETC/hub.env" ]; then
  FQDN=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=(JSON.parse(s).Self||{}).DNSName||"";console.log(n.replace(/\.$/,""))})')
  [[ "$FQDN" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$ ]] || die "could not read this node's tailnet name (is the tailnet up?)"
  ( umask 077
    {
      echo "NODE_ENV=production"
      echo "PROXY_HOST=127.0.0.1"
      echo "PROXY_PORT=3001"
      echo "AUTH_REQUIRED=true"
      echo "BETTER_AUTH_URL=https://$FQDN"
      echo "ALLOWED_ORIGINS=https://$FQDN"
      echo "MESH_STORE_PATH=$DATA/mesh/devices.json"
      echo "MESH_BUNDLE_PATH=$DATA/mesh/bundles"
      echo "DEVICE_AUTH_SECRET=$(openssl rand -hex 32)"
      echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
    } > "$ETC/hub.env" )
  chmod 0600 "$ETC/hub.env"
  say "wrote $ETC/hub.env for $FQDN"
fi
run install -m 0644 "$HERE/systemd/gauss-hub.service" /etc/systemd/system/gauss-hub.service
run install -m 0644 "$HERE/systemd/argo-relay.service" /etc/systemd/system/argo-relay.service
run systemctl daemon-reload
run systemctl enable --now gauss-hub.service
if [ "$DRY" = 0 ]; then
  for _ in $(seq 1 30); do curl -fsS -m 3 http://127.0.0.1:3001/health >/dev/null 2>&1 && break; sleep 2; done
  curl -fsS -m 3 http://127.0.0.1:3001/health >/dev/null || die "hub did not come up: journalctl -u gauss-hub -n 50"
fi

# --- 7. tailnet exposure ------------------------------------------------------------
say "7/9 tailscale serve (HTTPS, tailnet only)"
if [ "$DRY" = 1 ]; then
  run tailscale serve --bg --https=443 http://127.0.0.1:3001
elif ! tailscale serve --bg --https=443 http://127.0.0.1:3001; then
  echo "bootstrap: tailscale serve failed. HTTPS must be enabled for the tailnet (Tailscale admin console > DNS > HTTPS Certificates). Enable it and run this script again." >&2
  exit 1
fi

# --- 8. Argo enrolls as device "vps" on this hub -------------------------------------
say "8/9 Argo device enrolment"
if [ "$DRY" = 1 ]; then
  say "would enroll device vps on http://127.0.0.1:3001 (token piped from mesh:enroll to argo enroll, never printed); relay service left stopped"
elif [ ! -f "$DATA/.config/argo/config.json" ]; then
  runuser -u "$SVC_USER" -- env -i HOME="$DATA" PATH=/usr/local/bin:/usr/bin:/bin ARGO_NO_DESKTOP=1 \
    MESH_STORE_PATH="$DATA/mesh/devices.json" \
    sh -c "cd $SRC && npm run -s mesh:enroll -- vps | argo enroll http://127.0.0.1:3001 vps" \
    || die "enrolment failed (token not shown); check: journalctl -u gauss-hub -n 50"
fi
say "this device's key fingerprint:"
if [ "$DRY" = 1 ]; then run runuser -u "$SVC_USER" -- argo keys; else runuser -u "$SVC_USER" -- env -i HOME="$DATA" PATH=/usr/local/bin:/usr/bin ARGO_NO_DESKTOP=1 argo keys | sed -n 1p; fi

# --- 9. firewall (last) -------------------------------------------------------------
say "9/9 firewall: closed except tailscale0"
if [ "$DRY" = 1 ]; then
  run ufw default deny incoming
  run ufw default allow outgoing
  run ufw allow in on tailscale0
  run ufw --force enable
elif ! tailscale ip -4 >/dev/null 2>&1; then
  echo "bootstrap: tailnet is not up, so the firewall was NOT enabled (it would lock you out)." >&2
  exit 1
else
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow in on tailscale0
  ufw --force enable
  say "listening sockets (expect only 127.0.0.1 and tailscale addresses; port 22 only via tailscale0):"
  ss -tlnH | awk '{print "   " $4}'
fi

say "done. Next: README step 5 (laptop enrols), then confirm-peer.sh. From now on SSH via the tailnet name only."
