package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestParseWiFiDeviceAndPower(t *testing.T) {
	ports := "Hardware Port: Ethernet\nDevice: en1\nEthernet Address: x\n\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: y\n"
	if d := parseWiFiDevice(ports); d != "en0" {
		t.Fatalf("device %q", d)
	}
	if parseWiFiDevice("Hardware Port: Ethernet\nDevice: en1\n") != "" {
		t.Fatal("no Wi-Fi port must give no device")
	}
	if p := parseWiFiPower("Wi-Fi Power (en0): Off"); p != "Off" {
		t.Fatalf("power %q", p)
	}
}

func offlineSnap(t *testing.T, power string) Snapshot {
	s := fixture(t, "offline.json")
	s.WiFiDevice, s.WiFiPower = "en0", power
	return s
}

// TestOfflineWaitsThenCyclesWiFi: a short gap (a network switch) is left alone; after
// 90 s with no route Argo power-cycles Wi-Fi so macOS auto-join reconnects.
func TestOfflineWaitsThenCyclesWiFi(t *testing.T) {
	off := offlineSnap(t, "On")
	l, fx := newLoop(t, off, off, off, off, off)
	l.Tick(context.Background()) // opens the incident
	if len(fx.ran) != 0 {
		t.Fatalf("reset Wi-Fi during what may be a network switch: %v", fx.ran)
	}
	fx.now = fx.now.Add(2 * time.Minute)
	l.Tick(context.Background())
	if strings.Join(fx.ran, ";") != "networksetup -setairportpower en0 off;networksetup -setairportpower en0 on" {
		t.Fatalf("after 2 min offline: %v", fx.ran)
	}
}

// TestOfflineTurnsWiFiOn: with the radio off, it is turned on (no cycle needed).
func TestOfflineTurnsWiFiOn(t *testing.T) {
	off := offlineSnap(t, "Off")
	l, fx := newLoop(t, off, off, off, off)
	l.Tick(context.Background())
	fx.now = fx.now.Add(2 * time.Minute)
	l.Tick(context.Background())
	if strings.Join(fx.ran, ";") != "networksetup -setairportpower en0 on" {
		t.Fatalf("radio off: %v", fx.ran)
	}
}

// TestOfflineRejoinVerifiedAndRemembered: when the cycle brings the network back, the
// incident resolves and the fix is credited to that network.
func TestOfflineRejoinVerifiedAndRemembered(t *testing.T) {
	off := offlineSnap(t, "On")
	ok := fixture(t, "my_sim_ok.json")
	l, fx := newLoop(t, off, off, off, ok)
	l.Tick(context.Background())
	fx.now = fx.now.Add(2 * time.Minute)
	st := l.Tick(context.Background())
	if st.Class != OK {
		t.Fatalf("not resolved after the rejoin: %s %s", st.Class, st.Reason)
	}
}

// TestRunAutoRunsOnlyTheWiFiCommands: no other command runs by itself.
func TestRunAutoRunsOnlyTheWiFiCommands(t *testing.T) {
	l, fx := newLoop(t)
	for _, c := range []string{"rm -rf /", "networksetup -setairportnetwork en0 x", "tailscale down", "networksetup -setairportpower"} {
		_ = l.runAuto(Action{ID: "x", Command: c, Auto: true})
	}
	if len(fx.ran) != 0 {
		t.Fatalf("ran commands outside the Wi-Fi power steps: %v", fx.ran)
	}
}
