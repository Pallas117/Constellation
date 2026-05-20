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
echo "[1/2] Running adherence audit..."
npm run audit:adherence

echo ""
echo "[2/2] Running security compliance check..."
npm run check:security-compliance

echo ""
echo "Release preflight completed."
echo "Next: npm run release:tag -- vX.Y.Z"
