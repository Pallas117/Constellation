#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${ROOT}" ]]; then
  echo "Error: run from inside a git repository." >&2
  exit 1
fi

cd "${ROOT}"

DEFAULT_BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo main)"
CURRENT_BRANCH="$(git branch --show-current)"

echo "Release preflight"
echo "================="
echo "Repository: ${ROOT}"
echo "Branch:     ${CURRENT_BRANCH}"
echo "Default:    ${DEFAULT_BRANCH}"
echo ""

if [[ "${CURRENT_BRANCH}" != "${DEFAULT_BRANCH}" ]]; then
  echo "WARN: current branch is not default branch (${DEFAULT_BRANCH})."
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "WARN: working tree is not clean."
  echo "      Commit/stash changes before final release tagging."
fi

echo ""
echo "[1/3] Running adherence audit..."
npm run audit:adherence

echo ""
echo "[2/3] Running security compliance check..."
npm run check:security-compliance

echo ""
echo "[3/3] Verifying backend runtime health endpoint..."
HEALTH_PORT=3002
HEALTH_HOST=127.0.0.1
HEALTH_URL="http://${HEALTH_HOST}:${HEALTH_PORT}/health"
BACKEND_PID=0

export PROXY_PORT="${HEALTH_PORT}"
export PROXY_HOST="${HEALTH_HOST}"
export RBAC_SKIP_HEALTH_CHECK="true"

node --import tsx backend/server.ts &
BACKEND_PID=$!

cleanup() {
  if [[ ${BACKEND_PID} -ne 0 ]]; then
    kill ${BACKEND_PID} >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

seconds=0
until curl --silent --fail "${HEALTH_URL}" >/dev/null 2>&1; do
  if [[ ${seconds} -ge 15 ]]; then
    echo "❌ Backend health endpoint did not respond in time."
    cleanup
    exit 1
  fi
  sleep 1
  seconds=$((seconds + 1))
done

echo "✅ Backend runtime health endpoint responded at ${HEALTH_URL}"
cleanup

echo ""
echo "Release preflight completed."
echo "Next: npm run release:tag -- vX.Y.Z"
