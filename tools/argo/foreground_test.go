package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestParseCallAssertions(t *testing.T) {
	quiet := `Listed by owning process:
   pid 682(sharingd): [0x1] 00:00:57 PreventUserIdleSystemSleep named: "Handoff"
   pid 411(WindowServer): [0x2] 00:00:00 UserIsActive named: "com.apple.iohideventsystem.queue.tickle"
   pid 900(Google Chrome): [0x3] 00:10:00 PreventUserIdleSystemSleep named: "Playing audio"`
	if got := parseCallAssertions(quiet); got != "" {
		t.Fatalf("no call, got %q", got)
	}
	meet := quiet + "\n   pid 900(Google Chrome): [0x4] 00:12:00 PreventUserIdleDisplaySleep named: \"WebRTC has active PeerConnections\""
	if got := parseCallAssertions(meet); got != "Google Chrome" {
		t.Fatalf("Meet in Chrome: %q", got)
	}
	if got := parseCallAssertions(`   pid 900(Google Chrome): [0x6] 00:01:00 PreventUserIdleSystemSleep named: "WebRTC has active PeerConnections"`); got != "Google Chrome" {
		t.Fatalf("WebRTC as a system-sleep assertion: %q", got)
	}
	if got := parseCallAssertions(`   pid 77(zoom.us): [0x7] 00:30:00 PreventUserIdleSystemSleep named: "Zoom background"`); got != "" {
		t.Fatalf("Zoom open but not in a call: %q", got)
	}
	zoom := "   pid 77(zoom.us): [0x5] 00:03:00 PreventUserIdleDisplaySleep named: \"Zoom meeting\""
	if got := parseCallAssertions(zoom); got != "zoom.us" {
		t.Fatalf("Zoom app: %q", got)
	}
}

func TestParseHIDIdle(t *testing.T) {
	if d, ok := parseHIDIdle(`      "HIDIdleTime" = 1212674416`); !ok || d.Round(time.Millisecond) != 1213*time.Millisecond {
		t.Fatalf("idle %v %v", d, ok)
	}
	if _, ok := parseHIDIdle("nothing"); ok {
		t.Fatal("parsed nothing")
	}
}

// TestCallAdmitsLightWorkOnly: during a call, small jobs still run and big ones wait.
func TestCallAdmitsLightWorkOnly(t *testing.T) {
	s := calm()
	s.Call = "Google Chrome"
	a := assess(nil, s)
	if a.Level != LevelWatch || !hasCode(a, "owner-busy") {
		t.Fatalf("call: %s %s", a.Level, codes(a))
	}
	if ok, why := admit(a, 0.4); !ok {
		t.Fatalf("light job refused in a call: %s", why)
	}
	if ok, why := admit(a, 1.8); ok || !strings.Contains(why, "a call is live") {
		t.Fatalf("heavy job in a call: %v %s", ok, why)
	}
}

// TestKeyboardKeepsHalfAGigabyte: at the keyboard a job must leave interactiveGB more free;
// away, the same job runs.
func TestKeyboardKeepsHalfAGigabyte(t *testing.T) {
	s := Sample{At: t0, Pressure: "normal", RAMGB: 8, InRAMGB: 4.5, DiskGB: 200, Load1: 1, CPUs: 8, SpeedPct: 100}
	need := 1.8 // headroom is 8 - 4.5 - 1.5 = 2.0
	if ok, why := admit(assess(nil, s), need); !ok {
		t.Fatalf("away: %s", why)
	}
	s.Active = true
	if ok, why := admit(assess(nil, s), need); ok || !strings.Contains(why, "after keeping 2.0 GB") {
		t.Fatalf("at the keyboard: %v %s", ok, why)
	}
}

// TestCallHoldsWiFiResetUntilFiveMinutes: offline during a call, the reset waits for
// callRejoinAfter instead of 90 s.
func TestCallHoldsWiFiResetUntilFiveMinutes(t *testing.T) {
	off := offlineSnap(t, "On")
	off.InCall = true
	l, fx := newLoop(t, off, off, off, off, off, off)
	l.Tick(context.Background())
	fx.now = fx.now.Add(2 * time.Minute)
	l.Tick(context.Background())
	if len(fx.ran) != 0 {
		t.Fatalf("reset Wi-Fi 2 min into an outage during a call: %v", fx.ran)
	}
	fx.now = fx.now.Add(10 * time.Minute)
	l.Tick(context.Background())
	if strings.Join(fx.ran, ";") != "networksetup -setairportpower en0 off;networksetup -setairportpower en0 on" {
		t.Fatalf("after 12 min: %v", fx.ran)
	}
}
