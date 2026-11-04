package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestParsePreferred(t *testing.T) {
	saved := parsePreferred("Preferred networks on en0:\n\tJosh's iPhone\n\tHome Fibre 5G\n\tCafe Free WiFi\n")
	if len(saved) != 3 || !saved["Josh's iPhone"] || !saved["Home Fibre 5G"] {
		t.Fatalf("saved: %v", saved)
	}
}

func TestRankCandidates(t *testing.T) {
	nets := []NearNet{
		{SSID: "Home Fibre 5G", RSSI: -62, Band: "5", Security: "WPA2/WPA3"},
		{SSID: "Home Fibre 5G", RSSI: -70, Band: "2.4", Security: "WPA2/WPA3"}, // a second, weaker AP
		{SSID: "Josh's iPhone", RSSI: -55, Band: "2.4", Security: "WPA2"},
		{SSID: "Neighbour", RSSI: -40, Band: "5", Security: "WPA2"},        // not saved
		{SSID: "Cafe Free WiFi", RSSI: -60, Band: "2.4", Security: "NONE"}, // saved but open, not allowlisted
		{SSID: "Mall Public", RSSI: -65, Band: "2.4", Security: "NONE"},    // open, allowlisted
		{SSID: "Far Saved", RSSI: -85, Band: "2.4", Security: "WPA2"},      // too weak
		{SSID: "", RSSI: -30, Band: "5", Security: "WPA2"},                 // hidden
	}
	saved := map[string]bool{"Home Fibre 5G": true, "Josh's iPhone": true, "Cafe Free WiFi": true, "Far Saved": true}
	public := map[string]bool{"Mall Public": true}
	got := rankCandidates(nets, saved, public)
	var names []string
	for _, c := range got {
		names = append(names, c.SSID)
	}
	if strings.Join(names, ",") != "Josh's iPhone,Home Fibre 5G,Mall Public" {
		t.Fatalf("ranking: %v", names)
	}
	if got[1].RSSI != -62 {
		t.Fatalf("kept the weaker access point of one network: %+v", got[1])
	}
	if !got[2].Public || got[2].Saved {
		t.Fatalf("allowlisted open network flags: %+v", got[2])
	}
}

func joinSnap(t *testing.T) Snapshot {
	s := offlineSnap(t, "On")
	s.JoinCandidates = []Candidate{{NearNet: NearNet{SSID: "Josh's iPhone", RSSI: -55}, Saved: true, Score: -55}}
	return s
}

// TestOfflineJoinsBestSavedThenAlternatesWithRestart: attempt 1 joins the best saved network,
// attempt 2 restarts Wi-Fi, attempt 3 joins again; never both in one attempt.
func TestOfflineJoinsBestSavedThenAlternatesWithRestart(t *testing.T) {
	s := joinSnap(t)
	l, fx := newLoop(t, s, s, s, s, s, s, s, s, s, s)
	l.Tick(context.Background())
	fx.now = fx.now.Add(2 * time.Minute)
	l.Tick(context.Background())
	if strings.Join(fx.ran, ";") != "networksetup -setairportnetwork en0 Josh's iPhone" {
		t.Fatalf("attempt 1: %q", fx.ran)
	}
	fx.now = fx.now.Add(10 * time.Minute)
	l.Tick(context.Background())
	if got := strings.Join(fx.ran[1:], ";"); got != "networksetup -setairportpower en0 off;networksetup -setairportpower en0 on" {
		t.Fatalf("attempt 2 should restart Wi-Fi only: %q", got)
	}
}

// TestJoinPassesTheNameAsOneArgument: a name with spaces or shell characters is one argv item.
func TestJoinPassesTheNameAsOneArgument(t *testing.T) {
	var got []string
	l, fx := newLoop(t)
	_ = l.runAuto(Action{ID: "wifi-join", Command: "networksetup -setairportnetwork en0", Arg: "Cafe; rm -rf ~ $(x)", Auto: true})
	got = fx.ran
	if len(got) != 1 || got[0] != "networksetup -setairportnetwork en0 Cafe; rm -rf ~ $(x)" {
		t.Fatalf("join call: %q", got)
	}
	_ = l.runAuto(Action{ID: "wifi-join", Command: "networksetup -setairportnetwork en0", Arg: "", Auto: true})
	_ = l.runAuto(Action{ID: "wifi-join", Command: "sh -c x", Arg: "y", Auto: true})
	if len(fx.ran) != 1 {
		t.Fatalf("ran an empty-name or non-networksetup join: %q", fx.ran)
	}
}

// TestNamesNeverStored: network names are not in the action log or the snapshot JSON.
func TestNamesNeverStored(t *testing.T) {
	s := joinSnap(t)
	b, _ := json.Marshal(s)
	a, _ := json.Marshal(offlinePlan(s))
	if strings.Contains(string(b), "Josh's iPhone") || strings.Contains(string(a), "Josh's iPhone") {
		t.Fatalf("a network name was serialised:\n%s\n%s", b, a)
	}
}
