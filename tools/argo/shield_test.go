package main

import (
	"context"
	"strings"
	"testing"
)

func shieldSnap(t *testing.T, sec string, w Warp) Snapshot {
	s := fixture(t, "my_sim_ok.json")
	s.GatewayMAC, s.PublicIP, s.WiFiSec, s.Warp = "aa:bb:cc:dd:ee:01", "203.0.113.9", sec, w
	return s
}

var (
	warpOff   = Warp{Installed: true, Mode: "Warp"}
	warpOn    = Warp{Installed: true, Mode: "Warp", Connected: true}
	warpProxy = Warp{Installed: true, Mode: "WarpProxy"}
)

func TestParseWarp(t *testing.T) {
	w := parseWarp("Status update: Connected\nNetwork: healthy", "(user set)\tMode: WarpProxy on port 40000\n")
	if !w.Connected || w.Mode != "WarpProxy" || w.Tunnel() {
		t.Fatalf("proxy mode: %+v tunnel=%v", w, w.Tunnel())
	}
	if w := parseWarp("Status update: Disconnected", "Mode: Warp\n"); w.Connected || !w.Tunnel() {
		t.Fatalf("tunnel mode: %+v", w)
	}
	if (Warp{}).Tunnel() || (Warp{Installed: true, Mode: "DnsOverHttps"}).Tunnel() || !(Warp{Installed: true, Mode: "TunnelOnly"}).Tunnel() {
		t.Fatal("not installed / DNS-only is not a tunnel")
	}
}

// TestShieldOnOpenWiFiOffWhenProtected: open Wi-Fi turns WARP on (verified), a
// protected network turns it off again because Argo turned it on.
func TestShieldOnOpenWiFiOffWhenProtected(t *testing.T) {
	open, verified := shieldSnap(t, "NONE", warpOff), shieldSnap(t, "NONE", warpOn)
	home := shieldSnap(t, "WPA2_PSK", warpOn)
	l, fx := newLoop(t, open, verified, home)
	st := l.Tick(context.Background())
	if !st.ShieldOn || strings.Join(fx.ran, ";") != "warp-cli --accept-tos connect" {
		t.Fatalf("open Wi-Fi: shield=%v ran=%v", st.ShieldOn, fx.ran)
	}
	if !strings.Contains(strings.Join(fx.notes, ";"), "tunnel on") {
		t.Fatalf("no 'tunnel on' text: %v", fx.notes)
	}
	st = l.Tick(context.Background())
	if st.ShieldOn || fx.ran[len(fx.ran)-1] != "warp-cli --accept-tos disconnect" {
		t.Fatalf("protected network: shield=%v ran=%v", st.ShieldOn, fx.ran)
	}
}

// TestShieldUndoesWhenItBreaksTheConnection: if WARP takes Tailscale or the
// internet down, Argo switches it off and won't retry on that network.
func TestShieldUndoesWhenItBreaksTheConnection(t *testing.T) {
	open := shieldSnap(t, "NONE", warpOff)
	open.Tailscale.Running = true
	broken := shieldSnap(t, "NONE", warpOn)
	broken.Tailscale.Running = false
	l, fx := newLoop(t, open, broken, open, open)
	st := l.Tick(context.Background())
	if st.ShieldOn || strings.Join(fx.ran, ";") != "warp-cli --accept-tos connect;warp-cli --accept-tos disconnect" {
		t.Fatalf("broken tunnel kept: shield=%v ran=%v", st.ShieldOn, fx.ran)
	}
	if !st.Networks[st.Fingerprint].NoShield || !strings.Contains(strings.Join(fx.notes, ";"), "undone") {
		t.Fatalf("not remembered/told: %+v %v", st.Networks[st.Fingerprint], fx.notes)
	}
	n := len(fx.ran)
	l.Tick(context.Background())
	if len(fx.ran) != n {
		t.Fatalf("retried on a network where it broke things: %v", fx.ran[n:])
	}
}

// TestShieldRespectsManualOff: WARP switched off by hand on the open network
// stays off there.
func TestShieldRespectsManualOff(t *testing.T) {
	open, on := shieldSnap(t, "NONE", warpOff), shieldSnap(t, "NONE", warpOn)
	l, fx := newLoop(t, open, on, open, open)
	l.Tick(context.Background()) // on
	st := l.Tick(context.Background())
	if st.ShieldOn || !st.Networks[st.Fingerprint].NoShield {
		t.Fatalf("manual off not respected: %+v", st)
	}
	n := len(fx.ran)
	l.Tick(context.Background())
	if len(fx.ran) != n {
		t.Fatalf("turned WARP back on: %v", fx.ran[n:])
	}
}

// TestShieldSwitchesProxyModeAndPutsItBack: Josh's WARP sits in proxy mode. On
// open Wi-Fi Argo switches it to tunnel mode and connects; on a protected network
// it disconnects and puts proxy mode back.
func TestShieldSwitchesProxyModeAndPutsItBack(t *testing.T) {
	open, verified := shieldSnap(t, "NONE", warpProxy), shieldSnap(t, "NONE", warpOn)
	home := shieldSnap(t, "WPA2_PSK", warpOn)
	l, fx := newLoop(t, open, verified, home)
	st := l.Tick(context.Background())
	if !st.ShieldOn || st.ShieldPrevMode != "proxy" || strings.Join(fx.ran, ";") != "warp-cli --accept-tos mode warp;warp-cli --accept-tos connect" {
		t.Fatalf("open Wi-Fi: %+v ran=%v", st, fx.ran)
	}
	st = l.Tick(context.Background())
	if st.ShieldOn || st.ShieldPrevMode != "" || strings.Join(fx.ran[2:], ";") != "warp-cli --accept-tos disconnect;warp-cli --accept-tos mode proxy" {
		t.Fatalf("protected network: %+v ran=%v", st, fx.ran)
	}
}

// TestShieldAlreadyConnectedInProxyStaysConnected: WARP connected as a proxy is
// switched to tunnel mode and, afterwards, back to proxy, still connected.
func TestShieldAlreadyConnectedInProxyStaysConnected(t *testing.T) {
	proxyOn := Warp{Installed: true, Mode: "WarpProxy", Connected: true}
	open, verified := shieldSnap(t, "NONE", proxyOn), shieldSnap(t, "NONE", warpOn)
	home := shieldSnap(t, "WPA2_PSK", warpOn)
	l, fx := newLoop(t, open, verified, home)
	l.Tick(context.Background())
	l.Tick(context.Background())
	if strings.Join(fx.ran, ";") != "warp-cli --accept-tos mode warp;warp-cli --accept-tos mode proxy" {
		t.Fatalf("should only switch modes, never connect or disconnect: %v", fx.ran)
	}
}

// TestShieldLeavesAnUnknownModeAlone: a mode Argo can't put back is never changed;
// say so once per network.
func TestShieldLeavesAnUnknownModeAlone(t *testing.T) {
	p := shieldSnap(t, "NONE", Warp{Installed: true, Mode: "SomethingNew"})
	l, fx := newLoop(t, p, p)
	l.Tick(context.Background())
	l.Tick(context.Background())
	advice := 0
	for _, n := range fx.notes {
		if strings.Contains(n, "no tunnel") {
			advice++
		}
	}
	if advice != 1 || len(fx.ran) != 0 {
		t.Fatalf("advice %d times, ran %v", advice, fx.ran)
	}
}

// TestShieldLeavesProtectedNetworksAlone: WPA2 Wi-Fi with WARP off: nothing runs.
func TestShieldLeavesProtectedNetworksAlone(t *testing.T) {
	l, fx := newLoop(t, shieldSnap(t, "WPA2_PSK", warpOff))
	if st := l.Tick(context.Background()); st.ShieldOn || len(fx.ran) != 0 {
		t.Fatalf("acted on a protected network: %v", fx.ran)
	}
}
