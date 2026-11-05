package main

import (
	"strings"
	"testing"
	"time"
)

// ---- `argo scale` (scale.go) ----

func TestScalePlanClassifiesMeasuredJobs(t *testing.T) {
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	at := now.Add(-time.Hour)
	var runs []JobRun
	for i := 0; i < 4; i++ {
		// gates: fits, but waits 10 min for every 5 min run -> burst
		runs = append(runs, JobRun{At: at, Name: "gates", PeakGB: 1.4, Secs: 300, Outcome: "exit 0", WaitSecs: 600})
		// go-test: fits, never waits -> local
		runs = append(runs, JobRun{At: at, Name: "go-test", PeakGB: 0.2, Secs: 30, Outcome: "exit 0", AvgW: 9})
	}
	runs = append(runs,
		JobRun{At: at, Name: "train", PeakGB: 12, Secs: 3600, Outcome: "stopped"},                      // -> remote
		JobRun{At: now.Add(-10 * 24 * time.Hour), Name: "old", PeakGB: 1, Secs: 60, Outcome: "exit 0"}, // outside the window
	)
	hist := []Sample{{At: now, Pressure: "normal", RAMGB: 8, InRAMGB: 3, DiskGB: 50, CPUs: 8}}
	p := scalePlan(runs, hist, 7, now)

	where := map[string]JobDemand{}
	for _, j := range p.Jobs {
		where[j.Name] = j
	}
	if _, ok := where["old"]; ok {
		t.Error("run outside the window counted")
	}
	if where["gates"].Where != "burst" || where["go-test"].Where != "local" || where["train"].Where != "remote" {
		t.Fatalf("classes: %+v", where)
	}
	if g := where["gates"]; g.LostH != 0.67 || g.RunH != 0.33 || g.P90GB != 1.4 {
		t.Fatalf("gates numbers: %+v", g)
	}
	if where["train"].Fails != 1 || where["go-test"].AvgW != 9 {
		t.Fatalf("fails/watts: %+v %+v", where["train"], where["go-test"])
	}
	// Runner: train's 12 GB × 1.25 = 15, + 1.5 reserve.
	if p.UsableGB != 6.5 || p.RunnerGB != 16.5 || p.RunnerCPUs != 8 || !p.WaitKnown {
		t.Fatalf("plan: usable %.1f runner %.1f GB %d cores waitKnown %v", p.UsableGB, p.RunnerGB, p.RunnerCPUs, p.WaitKnown)
	}
	txt := scaleText(p)
	for _, want := range []string{"offload candidates:", "MISSING: GPU", "train", "remote:"} {
		if !strings.Contains(txt, want) {
			t.Errorf("text lacks %q:\n%s", want, txt)
		}
	}
	if strings.Contains(txt, "MISSING: wait") {
		t.Error("wait times were measured; should not be listed missing")
	}
}

func TestScalePlanEmptyAndUnmeasured(t *testing.T) {
	now := time.Now()
	p := scalePlan(nil, nil, 7, now)
	if p.ClosedPct != -1 || len(p.Jobs) != 0 || p.RunnerGB != 0 {
		t.Fatalf("empty plan: %+v", p)
	}
	if !strings.Contains(scaleText(p), "no guarded jobs") || !strings.Contains(strings.Join(p.Missing, "|"), "wait and pause") {
		t.Fatalf("empty text/missing: %s %v", scaleText(p), p.Missing)
	}
	if !strings.Contains(p.Advice[0], "not known yet") {
		t.Fatalf("advice: %v", p.Advice)
	}
}

func TestClosedShareReplaysAssessment(t *testing.T) {
	t0 := time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC)
	var hist []Sample
	for i := 0; i < 4; i++ {
		s := Sample{At: t0.Add(time.Duration(i) * time.Minute), Pressure: "normal", RAMGB: 8, InRAMGB: 3, DiskGB: 50, CPUs: 8}
		if i%2 == 1 {
			s.Pressure = "critical"
		}
		hist = append(hist, s)
	}
	if got := closedShare(hist); got != 50 {
		t.Fatalf("closed share %d, want 50", got)
	}
}

func TestScaleTextSumsTheTail(t *testing.T) {
	now := time.Now()
	var runs []JobRun
	for i := 0; i < scaleRows+5; i++ {
		runs = append(runs, JobRun{At: now, Name: "job" + string(rune('a'+i)), PeakGB: 0.1, Secs: 60, Outcome: "exit 0"})
	}
	txt := scaleText(scalePlan(runs, nil, 7, now))
	if !strings.Contains(txt, "5 smaller jobs") || strings.Contains(txt, "jobt ") {
		t.Fatalf("tail not summed:\n%s", txt)
	}
	if !strings.Contains(txt, "not known yet") {
		t.Fatalf("advice should not claim nothing waits without wait data:\n%s", txt)
	}
}

func TestQueuedAt(t *testing.T) {
	now := time.Unix(1_800_000_000, 0)
	if got := queuedAt("1799999400", now); !got.Equal(now.Add(-10 * time.Minute)) {
		t.Fatalf("queuedAt = %v", got)
	}
	for _, bad := range []string{"", "x", "1800000100", "1700000000"} { // empty, junk, future, > a week
		if got := queuedAt(bad, now); !got.Equal(now) {
			t.Errorf("queuedAt(%q) = %v, want now", bad, got)
		}
	}
}
