#!/bin/bash
# Argo's CI without GitHub Actions: runs check.sh on this machine against a
# committed tree, so the result names a commit. Nothing leaves the machine
# unless --report is given.
#
#   tools/argo/ci-local.sh            run the full check on HEAD
#   tools/argo/ci-local.sh --report   also post the result on the commit at GitHub
#                                     (commit status "argo/local-check"), so the
#                                     pull request shows it without Actions
#   ARGO_SHORT=1 skips the long simulation tests, as the gate's test:ops does.
#
# Needs only Go. --report also needs the gh CLI, signed in, and the commit pushed.
# The Actions workflow (.github/workflows/argo.yml) runs the same check.sh, so the
# two can never disagree about what "passing" means.
set -uo pipefail
cd "$(dirname "$0")"

report=0
case "${1:-}" in
  "") ;;
  --report) report=1 ;;
  *) echo "usage: ci-local.sh [--report]" >&2; exit 2 ;;
esac

sha=$(git rev-parse HEAD) || exit 2
if [ -n "$(git status --porcelain -- .)" ]; then
  echo "tools/argo has uncommitted changes: commit first, so the result names a commit" >&2
  exit 2
fi
if [ "$report" = 1 ] && [ -z "$(git branch -r --contains "$sha" 2>/dev/null)" ]; then
  echo "commit ${sha:0:7} is not pushed: push it, or run without --report" >&2
  exit 2
fi

log=$(mktemp -t argo-ci)
trap 'rm -f "$log"' EXIT
start=$(date +%s)
bash ./check.sh 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
secs=$(( $(date +%s) - start ))

if [ "$rc" = 0 ]; then
  state=success
  summary="passed in ${secs}s: $(grep -o 'coverage [0-9.]*%' "$log" | tail -1)"
else
  state=failure
  summary="failed at: $(grep '^== argo check:' "$log" | tail -1 | sed 's/^== argo check: //')"
fi
echo "argo ci ${sha:0:7}: $summary"

if [ "$report" = 1 ]; then
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || exit 2
  gh api -X POST "repos/$repo/statuses/$sha" \
    -f state="$state" -f context="argo/local-check" \
    -f description="check.sh run locally, ${summary}" >/dev/null \
    && echo "reported to $repo as argo/local-check ($state)"
fi
exit "$rc"
