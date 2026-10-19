#!/bin/bash
# Connect this Mac's Argo agent to a Gauss backend so its status appears on the
# Mesh & Network page automatically (every Argo check, no manual steps).
#
#   tools/argo/connect-gauss.sh [device-name] [gauss-url]
#
# Defaults: device = this Mac's LocalHostName, url = http://127.0.0.1:3001.
# Run from the Gauss repo checkout that the backend serves. The device token
# is piped from `npm run mesh:enroll` straight into `argo enroll`; it is never
# printed, stored in shell history, or passed on a command line.
set -euo pipefail

name="${1:-$(scutil --get LocalHostName | tr '[:upper:]' '[:lower:]')}"
url="${2:-http://127.0.0.1:3001}"
argo="${ARGO:-$HOME/.local/bin/argo}"
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

[ -x "$argo" ] || { echo "argo not found at $argo (see tools/argo/README.md)" >&2; exit 1; }
curl -fsS -m 5 "$url/health" >/dev/null || { echo "Gauss backend not reachable at $url — start it with: npm run dev:proxy" >&2; exit 1; }

cd "$repo"
echo "Enrolling '$name' with $url ..."
npm run -s mesh:enroll -- "$name" | "$argo" enroll "$url" "$name" 2>/dev/null

echo "Running one Argo check now so the device reports immediately ..."
"$argo" fix >/dev/null  # full check now; the LaunchAgent may skip one on unchanged Wi-Fi
for _ in $(seq 1 20); do
  sleep 2
  last=$(node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).find((x) => x.name === process.argv[2]);
    if (d && d.last) console.log(d.last.class + " " + (d.last.loc || "?"));
  ' "${MESH_STORE_PATH:-$repo/data/mesh/devices.json}" "$name" 2>/dev/null || true)
  if [ -n "$last" ]; then
    echo "Connected: Gauss received '$name' → $last. It will update on every Argo check."
    exit 0
  fi
done
echo "Enrolled, but no report arrived yet. Check: argo status; tail ~/.local/state/argo/launchd.log" >&2
exit 1
