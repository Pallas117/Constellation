#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "${ROOT}" ]]; then
  echo "Error: run from inside a git repository." >&2
  exit 1
fi
cd "${ROOT}"

if [[ $# -lt 1 ]]; then
  echo "Usage: bash scripts/release/create-tag.sh vX.Y.Z"
  exit 1
fi

TAG="$1"
if [[ ! "${TAG}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]; then
  echo "Error: tag must be semantic version style (example: v1.2.3 or v1.2.3-rc.1)." >&2
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"
DEFAULT_BRANCH="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || echo main)"

if [[ "${CURRENT_BRANCH}" != "${DEFAULT_BRANCH}" ]]; then
  echo "Error: create release tags from ${DEFAULT_BRANCH}. Current: ${CURRENT_BRANCH}" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash before tagging." >&2
  exit 1
fi

if git rev-parse "${TAG}" >/dev/null 2>&1; then
  echo "Error: tag already exists locally: ${TAG}" >&2
  exit 1
fi

if git ls-remote --tags origin "refs/tags/${TAG}" | grep -q "${TAG}"; then
  echo "Error: tag already exists on origin: ${TAG}" >&2
  exit 1
fi

# Release records (GAU-69): every tag has its CHANGELOG entry, and its SBOM passes the licence check.
if ! awk -v h="## [${TAG#v}]" 'index($0, h) == 1 {f = 1} END {exit !f}' CHANGELOG.md 2>/dev/null; then
  echo "Error: CHANGELOG.md has no '## [${TAG#v}]' entry. Add one (move the Unreleased entries under it) before tagging." >&2
  exit 1
fi

# Configuration management (GAU-123): only verified commits are tagged. The verify summary goes into
# the annotated tag, and `npm run deploy` refuses tags without it.
echo "Running the verification gate (npm run verify)..."
VERIFY_LOG="$(mktemp)"
if ! npm run verify >"${VERIFY_LOG}" 2>&1; then
  tail -20 "${VERIFY_LOG}"
  echo "Error: npm run verify failed; not tagging ${TAG}." >&2
  exit 1
fi
HEAD_SHORT="$(git rev-parse --short HEAD)"
SUMMARY="$(grep -E '^▶ (VCRM|FMEA):|VERIFY PASSED at' "${VERIFY_LOG}")"
if ! grep -q "VERIFY PASSED at ${HEAD_SHORT}" <<<"${SUMMARY}"; then
  echo "Error: verify evidence is not for HEAD ${HEAD_SHORT}; not tagging." >&2
  exit 1
fi

echo "Writing the SBOM and checking third-party licences (npm run release:sbom)..."
if ! npm run -s release:sbom; then
  echo "Error: the licence check failed; not tagging ${TAG}." >&2
  exit 1
fi

MESSAGE="Release ${TAG}

Verification (npm run verify):
${SUMMARY}"

git tag -a "${TAG}" -m "${MESSAGE}"
git push origin "${TAG}"

echo "Created and pushed tag: ${TAG}"
echo "Attach the release records: gh release create ${TAG} --verify-tag --notes-from-tag build/sbom/*"
