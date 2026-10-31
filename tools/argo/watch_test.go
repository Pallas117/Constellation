package main

import (
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeWatch struct {
	beats   map[string]time.Time // heartbeat path → mtime; absent = missing file
	loaded  map[string]bool
	running map[string]bool
	kickErr error
	kicked  []string
	alerts  []string
}

func (f *fakeWatch) fx() watchFx {
	return watchFx{
		modTime: func(p string) (time.Time, bool) { t, ok := f.beats[p]; return t, ok },
		loaded:  func(l string) bool { return f.loaded[l] },
		running: func(l string) bool { return f.running[l] },
		kick:    func(l string) error { f.kicked = append(f.kicked, l); return f.kickErr },
		notify:  func(key, title, msg string) { f.alerts = append(f.alerts, key+": "+title) },
	}
}

var guard = Peer{Label: "uk.lightbound.gauss-awake", Heartbeat: "/hb/guard", MaxAge: "5m"}
var mesh = Peer{Label: "uk.lightbound.mesh-heal", Heartbeat: "/hb/mesh", MaxAge: "10m"}

func TestWatchLeavesFreshPeersAlone(t *testing.T) {
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	f := &fakeWatch{
		beats:  map[string]time.Time{"/hb/guard": now.Add(-time.Minute), "/hb/mesh": now.Add(-9 * time.Minute)},
		loaded: map[string]bool{guard.Label: true, mesh.Label: true},
	}
	if out := watchPeers([]Peer{guard, mesh}, Store{Dir: t.TempDir()}, f.fx(), now); len(out) != 0 || len(f.kicked) != 0 {
		t.Fatalf("out %v kicked %v", out, f.kicked)
	}
}

func TestWatchRestartsStaleAndMissingButSkipsUnloaded(t *testing.T) {
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	off := Peer{Label: "uk.lightbound.not-installed", Heartbeat: "/hb/none", MaxAge: "1m"}
	f := &fakeWatch{
		beats:  map[string]time.Time{"/hb/guard": now.Add(-20 * time.Minute)}, // mesh heartbeat missing
		loaded: map[string]bool{guard.Label: true, mesh.Label: true},
	}
	out := watchPeers([]Peer{guard, mesh, off}, Store{Dir: t.TempDir()}, f.fx(), now)
	if strings.Join(f.kicked, ",") != guard.Label+","+mesh.Label {
		t.Fatalf("kicked %v", f.kicked)
	}
	if len(out) != 2 || !strings.Contains(out[0], "no heartbeat for 20 min; restarted") || !strings.Contains(out[1], "no heartbeat yet") {
		t.Fatalf("out %v", out)
	}
	if len(f.alerts) != 0 {
		t.Fatalf("a successful restart shouldn't page: %v", f.alerts)
	}
}

func TestWatchStopsKickingACrashLoopAndAlerts(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	start := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	f := &fakeWatch{beats: map[string]time.Time{}, loaded: map[string]bool{guard.Label: true}}
	for i := 0; i < maxKicksPerHour+2; i++ { // heartbeat never appears
		watchPeers([]Peer{guard}, s, f.fx(), start.Add(time.Duration(i)*5*time.Minute))
	}
	if len(f.kicked) != maxKicksPerHour {
		t.Fatalf("kicked %d times, want %d", len(f.kicked), maxKicksPerHour)
	}
	if len(f.alerts) != 2 || !strings.Contains(f.alerts[0], "keeps failing") {
		t.Fatalf("alerts %v", f.alerts)
	}
	// An hour after the first kicks, it gets fresh restarts again.
	watchPeers([]Peer{guard}, s, f.fx(), start.Add(70*time.Minute))
	if len(f.kicked) != maxKicksPerHour+1 {
		t.Fatalf("no restart after the window: %d", len(f.kicked))
	}
}

func TestWatchAlertsWhenRestartFails(t *testing.T) {
	now := time.Now()
	f := &fakeWatch{beats: map[string]time.Time{}, loaded: map[string]bool{mesh.Label: true}, kickErr: errors.New("boom")}
	out := watchPeers([]Peer{mesh}, Store{Dir: t.TempDir()}, f.fx(), now)
	if len(out) != 1 || !strings.Contains(out[0], "restart failed") || len(f.alerts) != 1 {
		t.Fatalf("out %v alerts %v", out, f.alerts)
	}
}

func TestConfigDefaultsToWatchingGuardAndMeshHeal(t *testing.T) {
	ps := Config{}.peers()
	if len(ps) != 2 || ps[0].Label != "uk.lightbound.gauss-awake" || ps[1].Label != "uk.lightbound.mesh-heal" {
		t.Fatalf("%v", ps)
	}
	if got := (Config{Watch: []Peer{}}).peers(); len(got) != 0 {
		t.Fatal("an explicit empty list should turn watching off")
	}
}

func TestWatchLeavesARunningPeerAlone(t *testing.T) {
	// Right after wake every heartbeat is stale; mesh-heal may be mid-heal
	// (Wi-Fi off, sleep, on). Killing it then cut the link.
	now := time.Date(2026, 10, 28, 11, 14, 0, 0, time.UTC)
	f := &fakeWatch{
		beats:   map[string]time.Time{"/hb/guard": now.Add(-time.Hour), "/hb/mesh": now.Add(-time.Hour)},
		loaded:  map[string]bool{guard.Label: true, mesh.Label: true},
		running: map[string]bool{mesh.Label: true},
	}
	watchPeers([]Peer{guard, mesh}, Store{Dir: t.TempDir()}, f.fx(), now)
	if len(f.kicked) != 1 || f.kicked[0] != guard.Label {
		t.Fatalf("kicked %v, want only the stopped guard", f.kicked)
	}
}
