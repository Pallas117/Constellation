package main

import (
	"strings"
	"testing"
)

// Cases from 2026-11-05 at Step Inn: PORT_BLOCKs on Wi-Fi in Malaysia were
// told to swap a Hong Kong eSIM, and most came while the whole uplink stalled.
func TestPortBlockAdviceFitsTheNetwork(t *testing.T) {
	stalled := Snapshot{Online: true, Loc: "MY", Gateway: "192.168.1.1",
		API: Result{Err: ErrTimeout}, Captive: Result{Err: ErrTimeout}}
	onlyClaude := Snapshot{Online: true, Loc: "MY", Gateway: "192.168.1.1",
		API: Result{Err: ErrTimeout}, Captive: Result{OK: true, Status: 200}}
	hotspot := Snapshot{Online: true, Loc: "MY", Gateway: "172.20.10.1",
		API: Result{Err: ErrTimeout}, Captive: Result{Err: ErrTimeout}}

	c, why := Classify(stalled)
	if c != PortBlock || !strings.Contains(why, "uplink stalled") {
		t.Fatalf("stalled uplink: %s %q", c, why)
	}
	if _, why := Classify(onlyClaude); strings.Contains(why, "stalled") {
		t.Fatalf("Apple's check passed, so only Claude is dropped: %q", why)
	}
	for name, s := range map[string]Snapshot{"stalled": stalled, "only-claude": onlyClaude, "hotspot": hotspot} {
		say := firstSay(Plan(PortBlock, s, ""))
		if strings.Contains(say, "Hong Kong") || strings.Contains(say, "SIM") {
			t.Errorf("%s: PORT_BLOCK advice talks about SIMs: %q", name, say)
		}
	}
	if say := firstSay(Plan(PortBlock, hotspot, "")); !strings.Contains(say, "Airplane mode") {
		t.Errorf("hotspot advice: %q", say)
	}
	if say := firstSay(Plan(PortBlock, stalled, "")); !strings.Contains(say, "nothing gets through") {
		t.Errorf("stalled advice: %q", say)
	}
	if say := firstSay(Plan(Region, Snapshot{Loc: "HK"}, "")); !strings.Contains(say, "Hong Kong") {
		t.Errorf("REGION keeps the eSIM advice: %q", say)
	}
	// The remembered fix ID is unchanged, so networks keep what they learned.
	if p := Plan(PortBlock, stalled, "switch-network"); p[0].ID != "switch-network" {
		t.Fatalf("remembered fix lost: %+v", p)
	}
}
