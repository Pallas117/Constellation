#!/bin/bash
# Build ArgoWiFi.app (GAU-234) and install it at ~/Applications/ArgoWiFi.app, ad-hoc signed with a stable
# identifier so macOS remembers the Location Services answer across rebuilds.
#   bash tools/argo/wifihelper/build.sh [dest-dir]   (default ~/Applications)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
dest=${1:-$HOME/Applications}
tmp=$(mktemp -d)
app="$tmp/ArgoWiFi.app"
mkdir -p "$app/Contents/MacOS"
cp "$here/Info.plist" "$app/Contents/Info.plist"
swiftc -O -o "$app/Contents/MacOS/ArgoWiFi" "$here/ArgoWiFi.swift" -framework CoreWLAN -framework CoreLocation
codesign -f -s - -i uk.lightbound.argo-wifi "$app"
mkdir -p "$dest"
rm -rf "$dest/ArgoWiFi.app"
mv "$app" "$dest/ArgoWiFi.app"
rm -rf "$tmp"
echo "installed $dest/ArgoWiFi.app"
