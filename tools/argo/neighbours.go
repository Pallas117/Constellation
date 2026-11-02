package main

import (
	"context"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Network watch (2026-11-01, Josh: "another layer to check what is connected ... monitoring for
// malicious activity", instead of turning sharing off). Passive only: it reads the ARP table and
// this Mac's own TCP connections; it never scans or probes other devices.
//   - ARP spoofing: another device answering with the router's MAC, or the router's MAC changing
//     while its address and the public IP stay the same. Argo then treats the network as untrusted,
//     so the Wi-Fi shield turns WARP on even on WPA2, and texts.
//   - Inbound: a device on the local network connected to one of this Mac's sharing services
//     (SSH, SMB, AFP, Screen Sharing, Remote Management, AirPlay). The tailnet does not count.
//   - Inventory: how many devices share this network, kept per network for `argo fix --list`.

// Neighbour is one entry of the ARP table on the default interface.
type Neighbour struct {
	IP  string `json:"ip"`
	MAC string `json:"mac"`
}

// Inbound is a device on the local network connected to a sharing service on this Mac.
type Inbound struct {
	Service string `json:"service"`
	Peer    string `json:"peer"`
}

var reARPLine = regexp.MustCompile(`^\S+ \(([0-9.]+)\) at ([0-9a-f:]+) on (\S+)`)

// parseARPTable reads `arp -an`, keeping complete unicast entries on iface.
func parseARPTable(out, iface string) []Neighbour {
	var n []Neighbour
	for _, line := range strings.Split(out, "\n") {
		m := reARPLine.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil || (iface != "" && m[3] != iface) || strings.Contains(line, "permanent") {
			continue // "permanent" is this Mac's own address
		}
		mac := normMAC(m[2])
		if mac == "ff:ff:ff:ff:ff:ff" || strings.HasPrefix(mac, "01:00:5e") || strings.HasPrefix(mac, "33:33") {
			continue // broadcast and multicast
		}
		n = append(n, Neighbour{IP: m[1], MAC: mac})
	}
	return n
}

// normMAC pads each octet ("0:1b:c" -> "00:1b:0c") so MACs compare as strings.
func normMAC(m string) string {
	p := strings.Split(strings.ToLower(m), ":")
	for i, o := range p {
		if len(o) == 1 {
			p[i] = "0" + o
		}
	}
	return strings.Join(p, ":")
}

// splitHostPort splits netstat's "a.b.c.d.port" form.
func splitNetstatAddr(a string) (string, int) {
	i := strings.LastIndex(a, ".")
	if i < 0 {
		return "", 0
	}
	p, err := strconv.Atoi(a[i+1:])
	if err != nil {
		return "", 0
	}
	return a[:i], p
}

var tailnet = mustCIDR("100.64.0.0/10")

func mustCIDR(s string) *net.IPNet { _, n, _ := net.ParseCIDR(s); return n }

// parseInbound reads `netstat -an -p tcp` for established IPv4 connections into a sharing
// port on this Mac from a private-network peer (not loopback, not the tailnet).
func parseInbound(out string) []Inbound {
	names := map[int]string{}
	for _, s := range sharingPorts {
		names[s.Port] = s.Name
	}
	var in []Inbound
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 6 || f[0] != "tcp4" || f[5] != "ESTABLISHED" {
			continue
		}
		_, lport := splitNetstatAddr(f[3])
		peer, _ := splitNetstatAddr(f[4])
		name, ok := names[lport]
		ip := net.ParseIP(peer)
		if !ok || ip == nil || ip.IsLoopback() || tailnet.Contains(ip) || !ip.IsPrivate() {
			continue
		}
		if k := name + peer; !seen[k] {
			seen[k] = true
			in = append(in, Inbound{Service: name, Peer: peer})
		}
	}
	return in
}

// probeNeighbours fills the network-watch fields for the default route's interface.
func probeNeighbours(ctx context.Context, s *Snapshot, iface string) {
	s.Neighbours = parseARPTable(run(ctx, "arp", "-an"), iface)
	if len(s.Neighbours) == 0 && s.Gateway != "" {
		askLocalNetwork(s.Gateway)
	}
	s.Inbound = parseInbound(run(ctx, "netstat", "-an", "-p", "tcp"))
}

// spoofed reports why the ARP table looks like someone is impersonating the router, or "".
func spoofed(snap Snapshot, prevGateway, prevGatewayMAC, prevPublicIP string) string {
	gw, mac := snap.Gateway, normMAC(snap.GatewayMAC)
	if gw == "" || snap.GatewayMAC == "" {
		return ""
	}
	for _, n := range snap.Neighbours {
		if n.IP != gw && n.MAC == mac {
			return fmt.Sprintf("%s answers with the router's MAC address (%s)", n.IP, mac)
		}
	}
	if prevGatewayMAC != "" && gw == prevGateway && snap.PublicIP != "" && snap.PublicIP == prevPublicIP && normMAC(prevGatewayMAC) != mac {
		return fmt.Sprintf("the router %s changed MAC address (%s -> %s) on the same network", gw, normMAC(prevGatewayMAC), mac)
	}
	return ""
}

const suspectFor = time.Hour // a spoofing sign keeps the network untrusted this long

// watchNeighbours runs every tick, before the shield, so a spoofing sign can turn the shield on.
func (l Loop) watchNeighbours(st *State, snap Snapshot, fp string, prevPublicIP string) {
	n := st.Networks[fp]
	now := l.Fx.Now()
	n.Devices = len(snap.Neighbours)
	if why := spoofed(snap, st.Gateway, st.GatewayMAC, prevPublicIP); why != "" {
		if now.Sub(n.SuspectAt) > suspectFor { // one text per episode
			l.Fx.Notify("Argo: possible ARP spoofing", "On this network "+why+". Someone may be intercepting traffic. Argo is treating it as untrusted (WARP on if available). Leave this Wi-Fi for anything sensitive.")
		}
		n.SuspectAt = now
		l.say("watch: possible ARP spoofing: %s", why)
	}
	for _, in := range snap.Inbound {
		k := in.Service + " " + in.Peer
		if n.SeenInbound == nil {
			n.SeenInbound = map[string]time.Time{}
		}
		if _, ok := n.SeenInbound[k]; !ok && len(n.SeenInbound) < 64 {
			mac := ""
			for _, nb := range snap.Neighbours {
				if nb.IP == in.Peer {
					mac = " (" + nb.MAC + ")"
				}
			}
			l.Fx.Notify("Argo: device connected to "+in.Service, "A device on this network, "+in.Peer+mac+", is connected to "+in.Service+" on this Mac. If that isn't you, turn "+in.Service+" off in System Settings > General > Sharing.")
		}
		n.SeenInbound[k] = now
	}
	if fp != "" {
		st.Networks[fp] = n
	}
}

// suspect is true while a recent spoofing sign keeps this network untrusted.
func (n Net) suspect(now time.Time) bool {
	return !n.SuspectAt.IsZero() && now.Sub(n.SuspectAt) < suspectFor
}

// askLocalNetwork sends one DNS query for "." to the router. macOS's Local Network privacy hides
// the ARP table from a binary until the user allows it, and only asks when the binary contacts a
// local device itself (2026-11-02: arp printed nothing under launchd). This is that contact; after
// "Allow", the ARP table and the router's MAC are visible.
func askLocalNetwork(gateway string) {
	c, err := net.DialTimeout("udp", net.JoinHostPort(gateway, "53"), time.Second)
	if err != nil {
		return
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(time.Second))
	// id 0x4152, recursion desired, one question: root, type NS, class IN
	_, _ = c.Write([]byte{0x41, 0x52, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 1})
	buf := make([]byte, 512)
	_, _ = c.Read(buf)
}
