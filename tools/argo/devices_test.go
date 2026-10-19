package main

import (
	"strings"
	"testing"
	"time"
)

// Shaped like `tailscale status --json` on 2026-10-18: the owner's iPhone had
// been offline for 6 days.
const statusJSON = `{
  "Self": {"HostName": "judith", "OS": "macOS", "Online": true, "UserID": 7},
  "Peer": {
    "a": {"HostName": "iphone-13", "OS": "iOS", "Online": false, "LastSeen": "2026-10-12T10:00:00Z", "UserID": 7},
    "b": {"HostName": "pixel", "OS": "android", "Online": false, "LastSeen": "2026-10-18T09:50:00Z", "UserID": 7},
    "c": {"HostName": "merve-iphone", "OS": "iOS", "Online": false, "LastSeen": "2026-10-10T00:00:00Z", "UserID": 9},
    "d": {"HostName": "talos", "OS": "linux", "Online": false, "LastSeen": "2026-10-01T00:00:00Z", "UserID": 7},
    "e": {"HostName": "ipad", "OS": "iOS", "Online": true, "UserID": 7}
  }
}`

var devicesNow = time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)

func TestOfflineDevicesDefaultsToTheOwnersPhones(t *testing.T) {
	got := offlineDevices([]byte(statusJSON), nil, devicesNow)
	// pixel: offline only 10 min; merve-iphone: someone else's; talos: not a phone; ipad: online.
	if len(got) != 1 || got[0].Host != "iphone-13" {
		t.Fatalf("got %+v, want only iphone-13", got)
	}
	if msg := deviceMessage(got[0]); !strings.Contains(msg, "6 days") || !strings.Contains(msg, "Connect On Demand") {
		t.Fatalf("message %q should say how long and how to fix it", msg)
	}
}

func TestOfflineDevicesHonoursConfiguredNames(t *testing.T) {
	got := offlineDevices([]byte(statusJSON), []string{"Talos", "merve-iphone"}, devicesNow)
	if len(got) != 2 || got[0].Host != "merve-iphone" || got[1].Host != "talos" {
		t.Fatalf("got %+v, want merve-iphone and talos", got)
	}
}

func TestNothingIsJudgedWhileThisMacIsOffTheTailnet(t *testing.T) {
	raw := strings.Replace(statusJSON, `"OS": "macOS", "Online": true`, `"OS": "macOS", "Online": false`, 1)
	if got := offlineDevices([]byte(raw), nil, devicesNow); len(got) != 0 {
		t.Fatalf("got %+v, want nothing", got)
	}
	if got := offlineDevices([]byte("not json"), nil, devicesNow); len(got) != 0 {
		t.Fatalf("bad input gave %+v", got)
	}
}

func TestRoughly(t *testing.T) {
	for d, want := range map[time.Duration]string{0: "a long time", 45 * time.Minute: "45 min", 5 * time.Hour: "5 h", 150 * time.Hour: "6 days"} {
		if got := roughly(d); got != want {
			t.Errorf("roughly(%s) = %q, want %q", d, got, want)
		}
	}
}
