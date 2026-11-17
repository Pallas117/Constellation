package main

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestScoreNetHomeWiFi(t *testing.T) {
	s := Snapshot{Online: true, WiFiSec: "WPA2_PSK", API: Result{OK: true, ConnectMs: 45}, Signal: &WiFiSignal{RSSI: -55, Noise: -95}}
	n := ScoreNet(s)
	if n.Privacy != 100 || len(n.PrivacyWhy) != 0 || n.Speed != "excellent" || n.RTTMs != 45 || n.Signal != "excellent" {
		t.Fatalf("%+v", n)
	}
	if got := n.Line(); got != "Privacy 100/100 · Speed excellent (45 ms) · Signal excellent (SNR 40 dB)" {
		t.Fatalf("line: %q", got)
	}
}

func TestScoreNetCafeExplainsEveryPoint(t *testing.T) {
	s := Snapshot{Online: true, WiFiSec: "NONE", WPAD: true, Captive: Result{Err: ErrPortal},
		Exposed: []string{"Remote Login (SSH)", "File Sharing (SMB)", "AirPlay Receiver", "Screen Sharing"},
		API:     Result{OK: true, ConnectMs: 210}, Signal: &WiFiSignal{RSSI: -78, Noise: -90}}
	n := ScoreNet(s)
	// 100 - 40 open - 30 (three sharing services, capped) - 15 WPAD - 10 portal = 5
	if n.Privacy != 5 || len(n.PrivacyWhy) != 6 || n.Speed != "fair" || n.Signal != "poor" {
		t.Fatalf("%+v", n)
	}
	if !strings.Contains(n.Line(), "open Wi-Fi -40, Remote Login (SSH) reachable on this network -10") {
		t.Fatalf("line: %q", n.Line())
	}
}

func TestScoreNetExitNodeSoftensWiFiOnly(t *testing.T) {
	s := Snapshot{Online: true, WiFiSec: "WPA_PSK", Exposed: []string{"File Sharing (SMB)"}, Tailscale: Tailscale{ExitNode: "sg-1"}}
	if n := ScoreNet(s); n.Privacy != 80 || n.PrivacyWhy[0] != "weak Wi-Fi encryption (tunnelled via exit node) -10" {
		t.Fatalf("%+v", n)
	}
}

func TestScoreNetTLSInterceptionFloorsAtZero(t *testing.T) {
	s := Snapshot{Online: true, WiFiSec: "OPEN", WPAD: true, Captive: Result{Err: ErrPortal},
		API: Result{Err: ErrTLSUntrusted}, Exposed: []string{"a", "b", "c"}}
	if n := ScoreNet(s); n.Privacy != 0 || n.Speed != notMeasured || n.RTTMs != -1 {
		t.Fatalf("%+v", n)
	}
}

func TestScoreNetNeverGuesses(t *testing.T) {
	if n := ScoreNet(Snapshot{}); n.Privacy != -1 || n.Line() != "Privacy not measured · Speed not measured · Signal not measured" {
		t.Fatalf("offline: %+v %q", n, n.Line())
	}
	wired := ScoreNet(Snapshot{Online: true, API: Result{OK: true, ConnectMs: 400}})
	if wired.Signal != "n/a" || wired.Speed != "poor" || strings.Contains(wired.Line(), "SNR") {
		t.Fatalf("wired: %+v", wired)
	}
	noReading := ScoreNet(Snapshot{Online: true, WiFiSec: "WPA3_SAE"})
	if noReading.Signal != notMeasured {
		t.Fatalf("Wi-Fi without a reading: %+v", noReading)
	}
	if r := netReport(noReading); r["rssi"] != nil {
		t.Fatalf("report sent a signal that was not measured: %v", r)
	}
}

const profilerOut = `Wi-Fi:
      Interfaces:
        en0:
          Current Network Information:
            HomeNet:
              PHY Mode: 802.11ax
              Signal / Noise: -67 dBm / -94 dBm
          Other Local Wi-Fi Networks:
            Neighbour:
              Signal / Noise: -40 dBm / -94 dBm
`

func TestParseSignalReadsOnlyTheCurrentNetwork(t *testing.T) {
	if s := parseSignal(profilerOut); s == nil || s.RSSI != -67 || s.Noise != -94 {
		t.Fatalf("%+v", s)
	}
	onlyNeighbours := strings.Replace(profilerOut, "              Signal / Noise: -67 dBm / -94 dBm\n", "", 1)
	if s := parseSignal(onlyNeighbours); s != nil {
		t.Fatalf("read a neighbour's signal: %+v", s)
	}
	if parseSignal("") != nil || parseSignal("Current Network Information:\n Signal / Noise: -300 dBm / -94 dBm") != nil {
		t.Fatal("accepted empty or out-of-range output")
	}
}

func TestCachedSignal(t *testing.T) {
	path := filepath.Join(t.TempDir(), "signal.json")
	reads := 0
	read := func() *WiFiSignal { reads++; return &WiFiSignal{RSSI: -60 - reads, Noise: -95} }
	now := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	cachedSignal(path, "gw1", now, read)
	if s := cachedSignal(path, "gw1", now.Add(4*time.Minute), read); reads != 1 || s.RSSI != -61 {
		t.Fatalf("not cached: reads=%d %+v", reads, s)
	}
	if cachedSignal(path, "gw2", now.Add(time.Minute), read); reads != 2 {
		t.Fatal("a new network must be read at once")
	}
	if cachedSignal(path, "gw2", now.Add(7*time.Minute), read); reads != 3 {
		t.Fatal("a stale reading must be re-read")
	}
}
