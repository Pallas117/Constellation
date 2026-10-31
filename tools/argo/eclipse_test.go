package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// eclipseRunner is a fake runner whose power source the test switches.
func eclipseRunner(t *testing.T, ac *atomic.Bool, maxPause time.Duration) guardRunner {
	r := fakeRunner(t, assess(nil, calm()))
	r.maxPause = maxPause
	r.assess = func() (Sample, Assessment) {
		s := calm()
		s.Batt = &Battery{Present: true, Pct: 80, OnAC: ac.Load()}
		return s, assess(nil, s)
	}
	return r
}

func lines(t *testing.T, path string) int {
	b, _ := os.ReadFile(path)
	return strings.Count(string(b), "\n")
}

// TestEclipsePausesOnBatteryAndResumes: a job started on AC stops using CPU while
// on battery and finishes normally once power returns.
func TestEclipsePausesOnBatteryAndResumes(t *testing.T) {
	var ac atomic.Bool
	ac.Store(true)
	r := eclipseRunner(t, &ac, time.Minute)
	out := filepath.Join(t.TempDir(), "ticks")
	// Writes a line every 10 ms, 60 lines in all (about 0.6 s of work while running).
	script := `i=0; while [ $i -lt 60 ]; do echo $i >> "$0"; i=$((i+1)); sleep 0.01; done`
	done := make(chan int, 1)
	go func() {
		code, _ := r.run(0, 0, 0, []string{"sh", "-c", script, out})
		done <- code
	}()
	time.Sleep(100 * time.Millisecond)
	ac.Store(false) // unplugged
	time.Sleep(150 * time.Millisecond)
	paused := lines(t, out)
	time.Sleep(300 * time.Millisecond)
	if got := lines(t, out); got != paused {
		t.Fatalf("job kept working on battery: %d -> %d lines", paused, got)
	}
	if paused >= 60 {
		t.Fatalf("job finished before the power dropped (%d lines); the test proves nothing", paused)
	}
	ac.Store(true) // power back
	select {
	case code := <-done:
		if code != 0 || lines(t, out) != 60 {
			t.Fatalf("after resuming: exit %d, %d lines, want 0 and 60", code, lines(t, out))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("job never finished after power returned")
	}
	log, _ := os.ReadFile(r.store.path("guard.log"))
	if s := string(log); !strings.Contains(s, "paused: on battery") || !strings.Contains(s, "resumed: on AC") {
		t.Errorf("guard log should record the pause and resume:\n%s", s)
	}
}

// TestEclipseStopsAfterMaxPause: a job left on battery past maxPause is stopped
// with the retry code, awake so it can exit.
func TestEclipseStopsAfterMaxPause(t *testing.T) {
	var ac atomic.Bool
	ac.Store(true)
	r := eclipseRunner(t, &ac, 100*time.Millisecond)
	go func() { time.Sleep(60 * time.Millisecond); ac.Store(false) }()
	start := time.Now()
	code, err := r.run(0, 0, 0, []string{"sh", "-c", "sleep 30"})
	if err != nil || code != exitTempFail {
		t.Fatalf("exit %d %v, want %d", code, err, exitTempFail)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("took %s: the paused job didn't get the stop", time.Since(start))
	}
}

// TestEclipseLeavesBatteryStartsAlone: a job admitted on battery (a small job)
// is not paused.
func TestEclipseLeavesBatteryStartsAlone(t *testing.T) {
	var ac atomic.Bool // false: on battery from the start
	r := eclipseRunner(t, &ac, time.Minute)
	out := filepath.Join(t.TempDir(), "ticks")
	code, err := r.run(0, 0, 0, []string{"sh", "-c", `i=0; while [ $i -lt 20 ]; do echo $i >> "$0"; i=$((i+1)); sleep 0.01; done`, out})
	if err != nil || code != 0 || lines(t, out) != 20 {
		t.Fatalf("exit %d %v, %d lines: a battery-admitted job must just run", code, err, lines(t, out))
	}
}
