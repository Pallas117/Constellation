package main

import (
	"context"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Wi-Fi security, checked every probe: on hotel, café and conference Wi-Fi the
// risks are a weakly encrypted network and this Mac answering everyone on it.
// Found on 2026-10-19: Remote Login accepted passwords from the LAN, and File
// Sharing and AirPlay Receiver were open. Argo reports; it never changes
// System Settings itself.

// sharingPorts are macOS sharing services worth knowing about on an untrusted
// network, by the name System Settings > General > Sharing uses.
var sharingPorts = []struct {
	Port int
	Name string
}{
	{22, "Remote Login (SSH)"},
	{445, "File Sharing (SMB)"},
	{548, "File Sharing (AFP)"},
	{3283, "Remote Management"},
	{5900, "Screen Sharing"},
	{7000, "AirPlay Receiver"},
}

var reIface = regexp.MustCompile(`(?m)^\s*interface:\s*(\S+)`)
var reSecurity = regexp.MustCompile(`(?m)^\s*Security\s*:\s*(\S+)`)

// parseRouteIface reads the default route's interface from `route -n get default`.
func parseRouteIface(out string) string {
	if m := reIface.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	return ""
}

// parseWiFiSecurity reads `ipconfig getsummary <iface>`; "" when the interface is not Wi-Fi.
func parseWiFiSecurity(out string) string {
	if m := reSecurity.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	return ""
}

// exposedServices dials each sharing port on this Mac's own LAN address. A
// connection from here means the service listens on that address, so others
// on the network can reach it too, unless the macOS firewall drops them; the
// firewall does not drop signed system services such as sshd or smbd.
func exposedServices(lanIP string, dial func(addr string) bool) []string {
	if lanIP == "" || strings.HasPrefix(lanIP, "127.") {
		return nil
	}
	var out []string
	for _, s := range sharingPorts {
		if dial(net.JoinHostPort(lanIP, strconv.Itoa(s.Port))) {
			out = append(out, s.Name)
		}
	}
	return out
}

func dialQuick(addr string) bool {
	c, err := net.DialTimeout("tcp", addr, 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// probeWiFi fills the Wi-Fi fields of a snapshot from the default route's interface.
func probeWiFi(ctx context.Context, s *Snapshot, route string) {
	iface := parseRouteIface(route)
	if iface == "" {
		return
	}
	s.WiFiSec = parseWiFiSecurity(run(ctx, "ipconfig", "getsummary", iface))
	s.Exposed = exposedServices(strings.TrimSpace(run(ctx, "ipconfig", "getifaddr", iface)), dialQuick)
}
