#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

if [[ "${DEV_TAILSCALE_SKIP_DOCTOR:-false}" != "true" ]]; then
  bash scripts/tailscale/doctor.sh --quiet || {
    echo "[dev:tailscale] preflight failed. Run 'npm run dev:tailscale:doctor' for details." >&2
    exit 1
  }
fi

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

port_in_use() {
  local port="$1"
  lsof -nP -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
}

if [[ -z "${TS_IP:-}" ]]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    TS_IP="$(detect_tailscale_ip_fallback || true)"
  else
    TS_IP="$(tailscale ip -4 2>/dev/null | awk '/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/{print; exit}')"
  fi

  if [[ -z "${TS_IP}" ]]; then
    TS_IP="$(detect_tailscale_ip_fallback || true)"
  fi
else
  TS_IP="${TS_IP}"
fi

if [[ ! "${TS_IP}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "[dev:tailscale] TS_IP is not a valid IPv4 address: ${TS_IP}" >&2
  exit 1
fi

if [[ -z "${TS_IP}" ]]; then
  echo "[dev:tailscale] no Tailscale IPv4 address found. Connect with 'tailscale up' first or pass TS_IP manually." >&2
  exit 1
fi

if [[ "${PROXY_HOST:-}" == "0.0.0.0" ]]; then
  echo "[dev:tailscale] refusing insecure PROXY_HOST=0.0.0.0." >&2
  exit 1
fi

AUTH_REQUIRED_VALUE="$(printf '%s' "${AUTH_REQUIRED:-true}" | tr '[:upper:]' '[:lower:]')"
if [[ "${AUTH_REQUIRED_VALUE}" == "false" ]]; then
  echo "[dev:tailscale] refusing to run with AUTH_REQUIRED=false on mobile/public networks." >&2
  exit 1
fi

CYBERTIGER_ENABLED_VALUE="$(printf '%s' "${CYBERTIGER_ENABLED:-true}" | tr '[:upper:]' '[:lower:]')"
if [[ "${CYBERTIGER_ENABLED_VALUE}" == "false" ]]; then
  echo "[dev:tailscale] refusing to run with CYBERTIGER_ENABLED=false on mobile/public networks." >&2
  exit 1
fi

FRONTEND_PORT="${FRONTEND_PORT:-8080}"
PROXY_PORT="${PROXY_PORT:-3001}"
FRONTEND_HOST="${FRONTEND_HOST:-${TS_IP}}"
PROXY_HOST="${PROXY_HOST:-${TS_IP}}"

if port_in_use "${PROXY_PORT}"; then
  echo "[dev:tailscale] port ${PROXY_PORT} is already in use." >&2
  echo "[dev:tailscale] run: npm run dev:tailscale:doctor:fix" >&2
  exit 1
fi

if port_in_use "${FRONTEND_PORT}"; then
  echo "[dev:tailscale] port ${FRONTEND_PORT} is already in use." >&2
  echo "[dev:tailscale] run: npm run dev:tailscale:doctor:fix" >&2
  exit 1
fi

if [[ "${PROXY_HOST}" == "0.0.0.0" ]]; then
  echo "[dev:tailscale] refusing insecure PROXY_HOST=0.0.0.0." >&2
  exit 1
fi

FRONTEND_ORIGIN="http://${FRONTEND_HOST}:${FRONTEND_PORT}"
ORIGIN_LINES="$(printf '%s\n%s\n%s\n' \
  "http://localhost:${FRONTEND_PORT}" \
  "http://127.0.0.1:${FRONTEND_PORT}" \
  "${FRONTEND_ORIGIN}")"

RAW_ORIGINS_CSV="${ALLOWED_ORIGINS:-}"
if [[ -n "${RAW_ORIGINS_CSV}" ]]; then
  OLD_IFS="${IFS}"
  IFS=','
  for raw in ${RAW_ORIGINS_CSV}; do
    trimmed="${raw#"${raw%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
    if [[ -n "${trimmed}" ]]; then
      ORIGIN_LINES="${ORIGIN_LINES}"$'\n'"${trimmed}"
    fi
  done
  IFS="${OLD_IFS}"
fi

ALLOWED_ORIGINS="$(
  printf '%s\n' "${ORIGIN_LINES}" | sed '/^$/d' | awk '!seen[$0]++' | paste -sd, -
)"
VITE_HELIO_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"

export PROXY_HOST
export PROXY_PORT
export ALLOWED_ORIGINS
export VITE_HELIO_PROXY_URL

echo "[dev:tailscale] Tailscale IP: ${TS_IP}"
echo "[dev:tailscale] Frontend: http://${FRONTEND_HOST}:${FRONTEND_PORT}"
echo "[dev:tailscale] Backend:  http://${PROXY_HOST}:${PROXY_PORT}"
echo "[dev:tailscale] ALLOWED_ORIGINS=${ALLOWED_ORIGINS}"

if [[ "${DRY_RUN}" == "true" ]]; then
  echo "[dev:tailscale] dry run complete."
  exit 0
fi

exec npx concurrently -k \
  "npm run dev -- --host ${FRONTEND_HOST} --port ${FRONTEND_PORT}" \
  "npm run dev:proxy"
