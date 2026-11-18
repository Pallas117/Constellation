//go:build linux

package main

import "context"

// hostLanIP is this host's address on the default route's interface, read
// from /proc like the rest of the Linux probe.
func hostLanIP(context.Context) string {
	iface, _, ok := linuxDefaultRoute(readFile("/proc/net/route"))
	if !ok {
		return ""
	}
	return ifaceIPv4(iface)
}
