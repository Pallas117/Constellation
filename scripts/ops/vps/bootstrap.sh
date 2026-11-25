#!/usr/bin/env bash
# First-boot setup for the always-on Gauss hub + Argo relay peer (Ubuntu LTS, arm64 or amd64).
# Josh runs it once, as root, on the VM. Nothing here runs from an agent or from CI.
#
#   sudo bash bootstrap.sh [--mesh tailscale|nebula|both] [--dry-run] [--ref GIT_REF] [--repo URL] [--help]
#
# What it does, in order (each step is safe to re-run):
#   1. packages: git, build tools, ufw, unattended-upgrades
#   2. the mesh (--mesh, default tailscale):
#      tailscale: Tailscale from its apt repo; joins the tailnet with an auth key you paste at the prompt
#      (or in TS_AUTHKEY). The key goes to a 0600 file in a temp dir, is passed to tailscale
#      as file:PATH (never on a command line), and is deleted on exit. It is never logged.
#      nebula: the Nebula lighthouse + relay (../nebula/README.md). Pinned release, checksum checked; the
#      key pair is made here and only the public key is printed, for sign.sh on the CA Mac. Nebula starts
#      once /etc/nebula/host.crt and ca.crt are in place (run this script again after copying them).
#      both: Tailscale and Nebula side by side (the migration).
#   3. Node (the major in .nvmrc) from nodejs.org, checked against its SHASUMS256.txt
#   4. Go (the toolchain in tools/argo/go.mod) from go.dev, checked against go.dev's sha256
#   5. service user `gauss` (no login, no sudo); the repo in /opt/gauss/src; npm ci; Argo built from
#      source into /usr/local/bin/argo
#   6. /etc/gauss/hub.env (generated secrets, root 0600), systemd units, hub started on 127.0.0.1
#   7. `tailscale serve` puts the hub on the tailnet over HTTPS (the only way in). With --mesh nebula the
#      hub stays on 127.0.0.1: reach it with an SSH tunnel over Nebula (../nebula/README.md)
#   8. Argo enrolls as device "vps" on this hub. The relay service is NOT started: run
#      confirm-peer.sh after you have compared fingerprints
#   9. firewall: deny all incoming except on tailscale0 and, with Nebula, UDP 4242 and the nebula1
#      overlay (whose own firewall admits only SSH from group dev). Last, after the mesh works
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
NEB="$HERE/../nebula"
MESH=tailscale
NEBULA_HUB_IP=10.117.0.1 # the lighthouse's overlay address (../nebula/common.sh)
CLEAN=()
cleanup() { [ ${#CLEAN[@]} -eq 0 ] || rm -rf "${CLEAN[@]}"; unset TS_AUTHKEY; }
trap cleanup EXIT

usage() { sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
say() { printf '==> %s\n' "$*"; }
die() { printf 'bootstrap: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; REF="$2"; shift ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a value"; REPO_URL="$2"; shift ;;
    --mesh) [ $# -ge 2 ] || die "--mesh needs tailscale, nebula or both"; MESH="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done
case "$REPO_URL" in https://*) ;; *) die "--repo must be an https:// URL" ;; esac
[[ "$REF" =~ ^[A-Za-z0-9._/-]+$ ]] || die "--ref has odd characters"
case "$MESH" in tailscale|nebula|both) ;; *) die "--mesh must be tailscale, nebula or both" ;; esac
use_ts() { [ "$MESH" != nebula ]; }
use_neb() { [ "$MESH" != tailscale ]; }

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

# --- 2. the mesh: Tailscale and/or Nebula ------------------------------------------------
say "2/9 mesh: $MESH"
if use_ts; then
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
fi
if use_neb; then
  # Nebula lighthouse + relay (scripts/ops/nebula). No secret is typed or stored by this script: the private
  # key is made here by nebula-cert (0600, owned by the nebula user) and never printed.
  if [ "$DRY" = 1 ] || [ ! -x /usr/local/bin/nebula ]; then
    NT=/run/gauss-nebula.dl
    if [ "$DRY" = 0 ]; then NT=$(mktemp -d /run/gauss-nebula.XXXXXX); CLEAN+=("$NT"); fi
    run bash "$NEB/fetch.sh" "linux-$GO_ARCH" "$NT"
    run install -o root -g root -m 0755 "$NT/nebula" "$NT/nebula-cert" /usr/local/bin/
  fi
  if [ "$DRY" = 1 ] || ! id nebula >/dev/null 2>&1; then
    run useradd --system --no-create-home --shell /usr/sbin/nologin nebula
  fi
  run install -d -o root -g root -m 0755 /etc/nebula
  if [ "$DRY" = 1 ] || [ ! -f /etc/nebula/host.key ]; then
    run sh -c 'umask 077 && /usr/local/bin/nebula-cert keygen -out-key /etc/nebula/host.key -out-pub /etc/nebula/host.pub'
    run chown nebula:nebula /etc/nebula/host.key
    run chmod 0644 /etc/nebula/host.pub
  fi
  run install -o root -g root -m 0644 "$NEB/config/lighthouse.yml" /etc/nebula/config.yml
  run install -o root -g root -m 0644 "$NEB/service/nebula.service" /etc/systemd/system/nebula.service
  run systemctl daemon-reload
  if [ "$DRY" = 1 ] || { [ -f /etc/nebula/host.crt ] && [ -f /etc/nebula/ca.crt ]; }; then
    run runuser -u nebula -- /usr/local/bin/nebula -test -config /etc/nebula/config.yml
    run systemctl enable --now nebula.service
  else
    say "Nebula is installed but has no certificate yet. On the CA Mac, sign this public key:"
    sed 's/^/    /' /etc/nebula/host.pub
    say "  bash scripts/ops/nebula/sign.sh hub $NEBULA_HUB_IP hub --pub <this key saved as hub.pub>"
    say "then copy hub.crt to /etc/nebula/host.crt and ca.crt to /etc/nebula/ca.crt (both public, 0644) and run this script again."
  fi
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
  if use_ts; then
    FQDN=$(tailscale status --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=(JSON.parse(s).Self||{}).DNSName||"";console.log(n.replace(/\.$/,""))})')
    [[ "$FQDN" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$ ]] || die "could not read this node's tailnet name (is the tailnet up?)"
    HUB_URL="https://$FQDN"
  else
    # Nebula only: the hub stays on loopback; people reach it through an SSH tunnel over Nebula.
    FQDN="127.0.0.1:3001"; HUB_URL="http://127.0.0.1:3001"
  fi
  ( umask 077
    {
      echo "NODE_ENV=production"
      echo "PROXY_HOST=127.0.0.1"
      echo "PROXY_PORT=3001"
      echo "AUTH_REQUIRED=true"
      echo "BETTER_AUTH_URL=$HUB_URL"
      echo "ALLOWED_ORIGINS=$HUB_URL"
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
say "7/9 hub exposure ($MESH)"
if ! use_ts; then
  say "hub stays on 127.0.0.1:3001 (no public or overlay listener). Reach it over Nebula with an SSH tunnel:"
  say "  ssh -L 3001:127.0.0.1:3001 <user>@$NEBULA_HUB_IP   (../nebula/README.md)"
elif [ "$DRY" = 1 ]; then
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
# The way in that must work before the public SSH port closes: the tailnet (tailscale, both) or Nebula (nebula).
say "9/9 firewall: closed except the mesh ($MESH)"
fw_rules() {
  run ufw default deny incoming
  run ufw default allow outgoing
  if use_ts; then run ufw allow in on tailscale0; fi
  if use_neb; then
    run ufw allow "$NEBULA_PORT/udp" comment 'nebula lighthouse'
    # Overlay traffic is filtered again by Nebula's own firewall (config/lighthouse.yml: only SSH from group dev).
    run ufw allow in on nebula1
  fi
  run ufw --force enable
}
NEBULA_PORT=4242
if [ "$DRY" = 1 ]; then
  fw_rules
elif use_ts && ! tailscale ip -4 >/dev/null 2>&1; then
  echo "bootstrap: tailnet is not up, so the firewall was NOT enabled (it would lock you out)." >&2
  exit 1
elif ! use_ts && ! systemctl is-active --quiet nebula.service; then
  echo "bootstrap: Nebula is not running (no certificate yet?), so the firewall was NOT enabled (it would lock you out)." >&2
  echo "bootstrap: install /etc/nebula/host.crt and ca.crt, run this script again, and check SSH over Nebula from the Mac before you log out." >&2
  exit 1
else
  fw_rules
  say "listening sockets (expect 127.0.0.1, mesh addresses and UDP $NEBULA_PORT with Nebula; port 22 only over the mesh):"
  ss -tlnH | awk '{print "   " $4}'
  if use_neb; then ss -ulnH | awk '{print "   udp " $4}'; fi
fi

if use_ts; then
  say "done. Next: README step 5 (laptop enrols), then confirm-peer.sh. From now on SSH via the tailnet name only."
else
  say "done. Before you close this session, open a second one over Nebula (ssh <user>@$NEBULA_HUB_IP from the Mac)."
  say "Then remove the provider's TCP 22 rule: only UDP $NEBULA_PORT stays open there (../nebula/README.md)."
fi
