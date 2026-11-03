#!/bin/bash
# Argo's full check, the one the gate runs (npm run test:ops) and install.sh runs before it
# replaces the binary. Fails on the first problem:
#   1. gofmt: no unformatted file
#   2. go vet for this Mac and for Linux (ground stations, the container)
#   3. builds for darwin/arm64, linux/amd64 and linux/arm64 (Linux without cgo, as the container)
#   4. go test with the race detector; coverage may not drop below coverage-floor
#   5. optional: ARGO_FUZZ=30s fuzzes every Fuzz target that long (seeds always run in step 4)
#   ARGO_SHORT=1 skips the long simulation tests (-short): the gate's test:ops uses it, test:argo and
#   install.sh run everything
#   6. optional: ARGO_E2E=1 runs scripts/argo-relay-e2e.ts (two real Argos against the real Gauss
#      mesh routers on 127.0.0.1; needs the repo's node_modules)
# Usage: tools/argo/check.sh            (from anywhere)
set -euo pipefail
cd "$(dirname "$0")"
tmp=$(mktemp -d -t argo-check)
trap 'rm -rf "$tmp"' EXIT
step() { printf '== argo check: %s\n' "$*"; }

step gofmt
unformatted=$(gofmt -l .)
[ -z "$unformatted" ] || { printf 'unformatted (run gofmt -w):\n%s\n' "$unformatted" >&2; exit 1; }

step vet
go vet ./...
GOOS=linux CGO_ENABLED=0 go vet ./...

step build
for target in darwin/arm64 linux/amd64 linux/arm64; do
  cgo=0; [ "${target%%/*}" = darwin ] && [ "$(uname -s)" = Darwin ] && cgo=1
  GOOS=${target%%/*} GOARCH=${target##*/} CGO_ENABLED=$cgo go build -trimpath -o "$tmp/argo-${target/\//-}" .
done

step "test (race, coverage)"
go test -race -count=1 ${ARGO_SHORT:+-short} -coverprofile="$tmp/cover.out" ./...
total=$(go tool cover -func="$tmp/cover.out" | awk '/^total:/ {sub("%", "", $3); print $3}')
floor=$(tr -d ' \n' <coverage-floor)
awk -v t="$total" -v f="$floor" 'BEGIN { exit !(t + 0 >= f + 0) }' \
  || { echo "coverage ${total}% is under the floor ${floor}% (coverage-floor): add tests for what changed" >&2; exit 1; }
echo "coverage ${total}% (floor ${floor}%)"

if [ -n "${ARGO_FUZZ:-}" ]; then
  for fz in $(grep -ho '^func Fuzz[A-Za-z0-9_]*' ./*_test.go | sed 's/^func //'); do
    step "fuzz $fz for $ARGO_FUZZ"
    go test -run='^$' -fuzz="^${fz}\$" -fuzztime="$ARGO_FUZZ" .
  done
fi

if [ -n "${ARGO_E2E:-}" ]; then
  step "relay end to end"
  (cd ../.. && npx tsx scripts/argo-relay-e2e.ts)
fi
step ok
