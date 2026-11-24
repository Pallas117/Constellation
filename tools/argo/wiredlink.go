package main

// Prefer a wired phone link (REQ-ARG-048). An iPhone on USB tethers through a
// network service named "iPhone USB": no radio contention with the Wi-Fi the
// phone is also serving, and a steadier path. Argo never changes network
// settings (that is admin: System Settings > Network > Service Order); it
// notices when the wired link is up but traffic uses something else, says so
// in `argo status`, doctor and the alert text, and records which link each
// probe used.

import (
	"context"
	"net"
	"regexp"
	"strings"
)

// HWPort is one line group of `networksetup -listallhardwareports`.
type HWPort struct{ Name, Device string }

var reHWPort = regexp.MustCompile(`(?m)^Hardware Port:\s*(.+?)\s*\nDevice:\s*(\S+)`)

func parseHardwarePorts(out string) []HWPort {
	var ps []HWPort
	for _, m := range reHWPort.FindAllStringSubmatch(out, -1) {
		ps = append(ps, HWPort{Name: m[1], Device: m[2]})
	}
	return ps
}

// portKind maps a service name to the class Argo reports.
func portKind(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.Contains(n, "iphone usb") || strings.Contains(n, "rndis") || strings.Contains(n, "android"):
		return "usb"
	case strings.Contains(n, "wi-fi") || strings.Contains(n, "airport"):
		return "wifi"
	case strings.Contains(n, "ethernet") || strings.Contains(n, "thunderbolt") || strings.Contains(n, "lan"):
		return "ethernet"
	}
	return "other"
}

// LinkVia is which link the probe used, and what to suggest.
type LinkVia struct {
	Via    string // usb | wifi | ethernet | other | "" unknown
	Advice string // empty when the best available link is in use
}

// chooseLink ranks the links: a wired phone link above Wi-Fi (the phone's
// hotspot, or any weak Wi-Fi). routeDev is the default route's interface;
// up says whether an interface has a carrier and an address.
func chooseLink(ports []HWPort, routeDev string, up func(dev string) bool, lowSignal bool) LinkVia {
	v := LinkVia{}
	var usb string
	for _, p := range ports {
		kind := portKind(p.Name)
		if p.Device == routeDev {
			v.Via = kind
		}
		if kind == "usb" && up(p.Device) {
			usb = p.Name
		}
	}
	if usb != "" && v.Via != "" && v.Via != "usb" {
		v.Advice = "\"" + usb + "\" is connected but traffic uses " + v.Via +
			". Drag it above Wi-Fi in System Settings > Network > Service Order (Argo never changes network settings)."
		if lowSignal {
			v.Advice += " The Wi-Fi link is weak, so this should help."
		}
	}
	return v
}

// systemLink reads the host once, read-only, with pinned absolute paths and no
// shell. Linux has no such service list, so it reports nothing.
func systemLink(ctx context.Context, lowSignal bool) LinkVia {
	out := run(ctx, "/usr/sbin/networksetup", "-listallhardwareports")
	if out == "" {
		return LinkVia{}
	}
	dev := parseRouteIface(run(ctx, "/sbin/route", "-n", "get", "default"))
	return chooseLink(parseHardwarePorts(out), dev, ifaceUp, lowSignal)
}

func ifaceUp(dev string) bool {
	ifi, err := net.InterfaceByName(dev)
	if err != nil || ifi.Flags&net.FlagUp == 0 {
		return false
	}
	addrs, _ := ifi.Addrs()
	for _, a := range addrs {
		if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil && !ipn.IP.IsLinkLocalUnicast() {
			return true
		}
	}
	return false
}

// adviceSuffix adds the link suggestion to an alert text when there is one.
func adviceSuffix(st State) string {
	if st.Advice == "" {
		return ""
	}
	return "\n" + st.Advice
}
