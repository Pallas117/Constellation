//go:build darwin

package main

import (
	"context"
	"strings"
)

// hostLanIP is this Mac's address on the default route's interface, for the
// sharing check. Absolute tool paths: launchd's PATH is minimal.
func hostLanIP(ctx context.Context) string {
	route, _ := runReadOnly(ctx, "/sbin/route", "-n", "get", "default")
	iface := parseRouteIface(route)
	if iface == "" {
		return ""
	}
	ip, _ := runReadOnly(ctx, "/usr/sbin/ipconfig", "getifaddr", iface)
	return strings.TrimSpace(ip)
}
