//go:build linux

package main

import (
	"bufio"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
)

// Linux host probing for the container build (GalacticOS and other Linux
// hosts). Route and ARP come from /proc, so the image needs no tools; there is
// no Messages app, so alerts are log lines on stdout and phone texts are off.
// Proxies come from the environment only (no system proxy settings on Linux).

const phoneSupported = false

const (
	hostNoun      = "host"
	sharingAdvice = "Stop the services you don't need, or allow them only on the tailnet interface in the host firewall"
)

func hostProbe(_ context.Context, s *Snapshot) {
	iface, gw, ok := linuxDefaultRoute(readFile("/proc/net/route"))
	s.Gateway, s.Online = gw, ok
	if !ok {
		return
	}
	s.GatewayMAC = linuxARP(readFile("/proc/net/arp"), gw)
	s.Exposed = exposedServices(ifaceIPv4(iface), dialQuick)
}

func wifiSignalInfo(context.Context) string { return "" } // Linux never sets WiFiSec, so this is not called

func staleProcs(context.Context) []StaleProc { return nil } // Claude Code daemons are a desktop concern

func localGateway(context.Context) (string, string) {
	_, gw, ok := linuxDefaultRoute(readFile("/proc/net/route"))
	if !ok {
		return "", ""
	}
	return gw, linuxARP(readFile("/proc/net/arp"), gw)
}

func desktopNotify(title, msg string) {
	fmt.Printf("%s argo alert: %s: %s\n", time.Now().UTC().Format(time.RFC3339), title, msg)
}

func openURL(string) error { return errors.New("opening URLs is not supported on Linux") }

func messagesSend(string, string, string) error {
	return errors.New("phone alerts need macOS Messages")
}

func readFile(p string) string {
	b, _ := os.ReadFile(p)
	return string(b)
}

// linuxDefaultRoute parses /proc/net/route: the default route has destination
// 00000000; the gateway is a little-endian hex IPv4 address.
func linuxDefaultRoute(table string) (iface, gateway string, ok bool) {
	sc := bufio.NewScanner(strings.NewReader(table))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) < 3 || f[1] != "00000000" {
			continue
		}
		b, err := hex.DecodeString(f[2])
		if err != nil || len(b) != 4 {
			continue
		}
		return f[0], net.IPv4(b[3], b[2], b[1], b[0]).String(), true
	}
	return "", "", false
}

// linuxARP finds the gateway's MAC in /proc/net/arp.
func linuxARP(table, ip string) string {
	sc := bufio.NewScanner(strings.NewReader(table))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) >= 4 && f[0] == ip && f[3] != "00:00:00:00:00:00" {
			return strings.ToLower(f[3])
		}
	}
	return ""
}

func ifaceIPv4(name string) string {
	ifc, err := net.InterfaceByName(name)
	if err != nil {
		return ""
	}
	addrs, _ := ifc.Addrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil {
			return n.IP.String()
		}
	}
	return ""
}
