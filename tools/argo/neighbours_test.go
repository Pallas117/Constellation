package main

import (
	"context"
	"strings"
	"testing"
)

const arpOut = `? (172.20.10.1) at 2:4f:d0:c5:e6:9e on en0 ifscope [ethernet]
? (172.20.10.4) at aa:bb:cc:dd:ee:04 on en0 ifscope permanent [ethernet]
? (172.20.10.15) at 6c:1:2:3:4:5 on en0 ifscope [ethernet]
? (172.20.10.255) at ff:ff:ff:ff:ff:ff on en0 ifscope [ethernet]
? (224.0.0.251) at 1:0:5e:0:0:fb on en0 ifscope permanent [ethernet]
? (172.20.10.9) at (incomplete) on en0 ifscope [ethernet]
? (192.168.2.1) at aa:bb:cc:dd:ee:99 on bridge0 ifscope permanent [bridge]`

func TestParseARPTable(t *testing.T) {
	got := parseARPTable(arpOut, "en0")
	if len(got) != 2 || got[0] != (Neighbour{"172.20.10.1", "02:4f:d0:c5:e6:9e"}) || got[1] != (Neighbour{"172.20.10.15", "6c:01:02:03:04:05"}) {
		t.Fatalf("neighbours: %+v", got)
	}
}

func TestParseInbound(t *testing.T) {
	out := `tcp4       0      0  172.20.10.4.22         172.20.10.15.51515     ESTABLISHED
tcp4       0      0  172.20.10.4.22         172.20.10.15.51516     ESTABLISHED
tcp4       0      0  100.73.232.74.22       100.101.1.2.50000      ESTABLISHED
tcp4       0      0  127.0.0.1.7000         127.0.0.1.50001        ESTABLISHED
tcp4       0   1608  172.20.10.4.55624      159.60.135.0.443       ESTABLISHED
tcp4       0      0  172.20.10.4.7000       172.20.10.20.49152     ESTABLISHED
tcp4       0      0  *.22                   *.*                    LISTEN`
	got := parseInbound(out)
	if len(got) != 2 || got[0] != (Inbound{"Remote Login (SSH)", "172.20.10.15"}) || got[1] != (Inbound{"AirPlay Receiver", "172.20.10.20"}) {
		t.Fatalf("inbound (tailnet, loopback, outbound and listeners must be ignored; one per peer): %+v", got)
	}
}

func watchSnap(t *testing.T, gwMAC string, nb ...Neighbour) Snapshot {
	s := fixture(t, "my_sim_ok.json")
	s.Gateway, s.GatewayMAC, s.PublicIP, s.WiFiSec = "192.168.1.1", gwMAC, "203.0.113.9", "WPA2_PSK"
	s.Neighbours = append([]Neighbour{{"192.168.1.1", gwMAC}}, nb...)
	return s
}

func TestSpoofed(t *testing.T) {
	ok := watchSnap(t, "24:2f:d0:c5:e6:9e", Neighbour{"192.168.1.20", "aa:aa:aa:aa:aa:20"})
	if why := spoofed(ok, "192.168.1.1", "24:2f:d0:c5:e6:9e", "203.0.113.9"); why != "" {
		t.Fatalf("clean table flagged: %s", why)
	}
	dup := watchSnap(t, "aa:aa:aa:aa:aa:66", Neighbour{"192.168.1.66", "aa:aa:aa:aa:aa:66"})
	if why := spoofed(dup, "", "", ""); !strings.Contains(why, "192.168.1.66 answers with the router's MAC") {
		t.Fatalf("duplicate gateway MAC not flagged: %q", why)
	}
	moved := watchSnap(t, "aa:aa:aa:aa:aa:66")
	if why := spoofed(moved, "192.168.1.1", "24:2f:d0:c5:e6:9e", "203.0.113.9"); !strings.Contains(why, "changed MAC address") {
		t.Fatalf("gateway MAC change not flagged: %q", why)
	}
	other := moved
	other.PublicIP = "198.51.100.7" // a different network that happens to use 192.168.1.1
	if why := spoofed(other, "192.168.1.1", "24:2f:d0:c5:e6:9e", "203.0.113.9"); why != "" {
		t.Fatalf("a new network flagged as spoofing: %s", why)
	}
}

// TestSpoofingTurnsTheShieldOnEvenOnWPA2: a spoofing sign makes the network untrusted.
func TestSpoofingTurnsTheShieldOnEvenOnWPA2(t *testing.T) {
	spoof := watchSnap(t, "aa:aa:aa:aa:aa:66", Neighbour{"192.168.1.66", "aa:aa:aa:aa:aa:66"})
	spoof.Warp = warpOff
	verified := spoof
	verified.Warp = warpOn
	l, fx := newLoop(t, spoof, verified)
	l.ShieldWARP = true
	st := l.Tick(context.Background())
	notes := strings.Join(fx.notes, ";")
	if !strings.Contains(notes, "ARP spoofing") || !st.ShieldOn || strings.Join(fx.ran, ";") != "warp-cli --accept-tos connect" {
		t.Fatalf("notes=%s shield=%v ran=%v", notes, st.ShieldOn, fx.ran)
	}
}

// TestInboundToldOncePerDevice: a LAN device on SSH is texted once, not every tick.
func TestInboundToldOncePerDevice(t *testing.T) {
	s := watchSnap(t, "24:2f:d0:c5:e6:9e", Neighbour{"192.168.1.20", "aa:aa:aa:aa:aa:20"})
	s.Inbound = []Inbound{{"Remote Login (SSH)", "192.168.1.20"}}
	l, fx := newLoop(t, s, s, s)
	for i := 0; i < 3; i++ {
		l.Tick(context.Background())
	}
	n := 0
	for _, note := range fx.notes {
		if strings.Contains(note, "connected to Remote Login") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("inbound texted %d times: %v", n, fx.notes)
	}
}
