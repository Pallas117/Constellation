#!/usr/bin/env bash
set -euo pipefail

KILL_PORTS=false
QUIET=false
for arg in "$@"; do
  case "$arg" in
    --kill-ports) KILL_PORTS=true ;;
    --quiet) QUIET=true ;;
    *) ;;
  esac
done

FRONTEND_PORT="${FRONTEND_PORT:-8080}"
PROXY_PORT="${PROXY_PORT:-3001}"
HAS_ERRORS=false
HAS_WARNINGS=false
RESOLVED_TS_IP=""

detect_tailscale_ip_fallback() {
  if ! command -v ifconfig >/dev/null 2>&1; then
    return 1
  fi
  ifconfig 2>/dev/null | awk '
    /^[a-zA-Z0-9]+: / {
      iface=$1
      sub(":", "", iface)
    }
    iface ~ /^utun[0-9]+$/ && $1 == "inet" && $2 ~ /^100\./ {
      print $2
      exit
    }'
}

print() {
  if [[ "${QUIET}" == "false" ]]; then
    printf '%s\n' "$1"
  fi
}

ok() { print "[OK] $1"; }
warn() { HAS_WARNINGS=true; print "[WARN] $1"; }
err() { HAS_ERRORS=true; print "[ERR] $1"; }

print "[doctor] Tailscale mobile/public Wi-Fi preflight"

if ! command -v node >/dev/null 2>&1; then
  err "node not found in PATH."
else
  ok "node available: $(node -v)"
fi

if ! command -v npm >/dev/null 2>&1; then
  err "npm not found in PATH."
else
  ok "npm available: $(npm -v)"
fi

if [[ "${AUTH_REQUIRED:-true}" =~ ^[Ff][Aa][Ll][Ss][Ee]$ ]]; then
  err "AUTH_REQUIRED=false is not safe for public networks."
else
  ok "AUTH_REQUIRED is enabled."
fi

if [[ "${CYBERTIGER_ENABLED:-true}" =~ ^[Ff][Aa][Ll][Ss][Ee]$ ]]; then
  err "CYBERTIGER_ENABLED=false is not safe for public networks."
else
  ok "CYBERTIGER_ENABLED is enabled."
fi

if [[ "${PROXY_HOST:-}" == "0.0.0.0" ]]; then
  err "PROXY_HOST=0.0.0.0 exposes backend on all interfaces."
fi

if [[ -n "${TS_IP:-}" ]]; then
  if [[ "${TS_IP}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    RESOLVED_TS_IP="${TS_IP}"
    ok "using TS_IP from environment: ${RESOLVED_TS_IP}"
  else
    err "TS_IP is set but invalid: ${TS_IP}"
  fi
else
  if ! command -v tailscale >/dev/null 2>&1; then
    RESOLVED_TS_IP="$(detect_tailscale_ip_fallback || true)"
    if [[ -n "${RESOLVED_TS_IP}" ]]; then
      warn "tailscale CLI missing; using utun fallback IP ${RESOLVED_TS_IP}"
    else
      err "tailscale CLI not found. Install Tailscale or set TS_IP manually."
    fi
  else
    TS_RAW="$(tailscale ip -4 2>&1 || true)"
    RESOLVED_TS_IP="$(printf '%s\n' "${TS_RAW}" | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/{print; exit}')"
    if [[ -z "${RESOLVED_TS_IP}" ]]; then
      RESOLVED_TS_IP="$(detect_tailscale_ip_fallback || true)"
      if [[ -n "${RESOLVED_TS_IP}" ]]; then
        warn "tailscale CLI unhealthy; using utun fallback IP ${RESOLVED_TS_IP}"
      else
        err "tailscale ip -4 failed. Output: ${TS_RAW}"
        print "      Fix: open Tailscale app, sign in, then run: tailscale up"
        print "      Temporary bypass: TS_IP=<your-tailnet-ipv4> npm run dev:tailscale"
      fi
    else
      ok "tailscale ipv4: ${RESOLVED_TS_IP}"
    fi
  fi
fi

check_port() {
  local port="$1"
  local listeners
  listeners="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "${listeners}" ]]; then
    ok "port ${port} is free."
    return
  fi

  warn "port ${port} is in use."
  print "${listeners}"
  if [[ "${KILL_PORTS}" == "true" ]]; then
    local pids
    pids="$(printf '%s\n' "${listeners}" | awk 'NR>1 {print $2}' | sort -u)"
    if [[ -n "${pids}" ]]; then
      local kill_error=""
      kill_error="$(kill ${pids} 2>&1 || true)"
      if [[ -n "${kill_error}" ]]; then
        warn "could not signal listener(s) on port ${port}: ${kill_error}"
      fi
      sleep 0.4
      local after
      after="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>/dev/null || true)"
      if [[ -z "${after}" ]]; then
        ok "killed listeners on port ${port}."
      else
        warn "could not kill all listeners on port ${port}; retry manually."
        print "      Manual: lsof -nP -iTCP:${port} -sTCP:LISTEN"
        print "      Manual: kill -9 <pid>"
      fi
    fi
  else
    print "      Run with --kill-ports to stop stale listeners."
  fi
}

check_port "${PROXY_PORT}"
check_port "${FRONTEND_PORT}"

if [[ "${HAS_ERRORS}" == "true" ]]; then
  print "[doctor] FAIL"
  exit 1
fi

if [[ "${HAS_WARNINGS}" == "true" ]]; then
  print "[doctor] PASS with warnings"
else
  print "[doctor] PASS"
fi
