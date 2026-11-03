package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func battSample(onAC bool, adapterW, systemW float64) Sample {
	return Sample{Batt: &Battery{Present: true, Pct: 80, OnAC: onAC, AdapterW: adapterW, SystemW: systemW}}
}

func TestPowerBudgetModes(t *testing.T) {
	for _, c := range []struct {
		name string
		s    Sample
		want PowerBudget
	}{
		{"20 W charger, light load", battSample(true, 20, 6.5), PowerBudget{PowerPositive, 16, 6.5, 9.5}},
		{"8 W charger can't carry it", battSample(true, 8, 9.2), PowerBudget{PowerNegative, 6.4, 9.2, -2.8}},
		{"on battery", battSample(false, 0, 7), PowerBudget{PowerEclipse, 0, 7, -7}},
		{"no draw reading", battSample(true, 20, 0), PowerBudget{}},
		{"desktop, no battery", Sample{}, PowerBudget{}},
	} {
		if got := powerBudget(c.s); got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestPowerWorkersCapsByMargin(t *testing.T) {
	pos := PowerBudget{Mode: PowerPositive, SourceW: 16, LoadW: 6.5, MarginW: 9.5}
	if n := powerWorkers(7, pos, 3); n != 3 {
		t.Errorf("9.5 W margin at 3 W a worker: %d, want 3", n)
	}
	if n := powerWorkers(2, pos, 3); n != 2 {
		t.Errorf("RAM allows fewer than power: %d, want 2", n)
	}
	if n := powerWorkers(7, PowerBudget{Mode: PowerPositive, MarginW: 1}, 3); n != 1 {
		t.Errorf("thin margin: %d, want 1", n)
	}
	if n := powerWorkers(7, PowerBudget{Mode: PowerNegative, MarginW: -2}, 3); n != 1 {
		t.Errorf("negative: %d, want 1", n)
	}
	if n := powerWorkers(7, PowerBudget{}, 3); n != 7 {
		t.Errorf("unknown power must not cap: %d, want 7", n)
	}
	if n := powerWorkers(7, pos, 0); n != 3 {
		t.Errorf("no per-worker figure falls back to %.0f W: %d, want 3", defaultWorkerW, n)
	}
}

func TestWorkerWattsLearnsTheMedian(t *testing.T) {
	run := func(name, outcome string, workers int, base, avg float64) JobRun {
		return JobRun{Name: name, Outcome: outcome, Workers: workers, BaseW: base, AvgW: avg, PeakGB: 1}
	}
	runs := []JobRun{
		run("npm-test", "exit 0", 3, 6, 12),  // 2 W a worker
		run("npm-test", "exit 0", 2, 6, 11),  // 2.5
		run("npm-test", "exit 1", 3, 6, 30),  // failed: ignored
		run("other", "exit 0", 1, 6, 20),     // another job: ignored
		run("npm-test", "exit 0", 3, 6, 24),  // 6 (a video call next to it)
		run("npm-test", "exit 0", 3, 6, 6.2), // below the noise floor: ignored
		run("npm-test", "exit 0", 0, 0, 0),   // not measured: ignored
	}
	if w, note := workerWatts(runs[:2], "npm-test"); w != defaultWorkerW || note != "" {
		t.Errorf("two runs is not enough: %.1f %q", w, note)
	}
	w, note := workerWatts(runs, "npm-test")
	if w != 2.5 || !strings.Contains(note, "2.5 W per worker, measured over its last 3 runs") {
		t.Errorf("median of 2, 2.5, 6: %.1f %q", w, note)
	}
}

func TestPowerTextReadsAsABudget(t *testing.T) {
	got := powerText(PowerBudget{PowerPositive, 16, 6.5, 9.5}, 3)
	if !strings.Contains(got, "9.5 W margin = 3 worker(s)") {
		t.Errorf("positive: %s", got)
	}
	if got := powerText(PowerBudget{PowerNegative, 6.4, 9.2, -2.8}, 3); !strings.Contains(got, "the battery covers 2.8 W") {
		t.Errorf("negative: %s", got)
	}
}

// TestReportCarriesThePowerBudget: Gauss gets the mode and margin inside the battery block.
func TestReportCarriesThePowerBudget(t *testing.T) {
	r := map[string]any{}
	g := GuardState{Batt: &Battery{Present: true, Pct: 70, OnAC: true, AdapterW: 8, SystemW: 9.2}}
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	g.Report.At = now
	addGuard(r, g, now)
	bat, _ := r["battery"].(map[string]any)
	if p, ok := bat["power"].(PowerBudget); !ok || p.Mode != PowerNegative || p.MarginW != -2.8 {
		t.Fatalf("battery block: %+v", r["battery"])
	}
}

// TestGuardRunScalesByPower: on a 20 W charger drawing 10 W (6 W margin at the default 3 W a
// worker) the job gets 2 workers where RAM alone would give 9, and the run records its draw.
func TestGuardRunScalesByPower(t *testing.T) {
	for _, k := range []string{"ARGO_WORKERS", "ARGO_HEADROOM_GB"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	s := calm()
	s.Batt = &Battery{Present: true, Pct: 90, OnAC: true, AdapterW: 20, SystemW: 10}
	a := assess(nil, s)
	r := fakeRunner(t, a)
	r.assess = func() (Sample, Assessment) { return s, a }
	r.store = Store{Dir: t.TempDir()}
	r.name, r.workerGB = "check", 0.5
	r.jobGB = func(int) float64 { return 0.3 }
	out := filepath.Join(t.TempDir(), "workers")
	if code, err := r.run(1, 0, 0, []string{"sh", "-c", `sleep 0.1; echo "$ARGO_WORKERS" > "$0"`, out}); err != nil || code != 0 {
		t.Fatalf("exit %d %v", code, err)
	}
	if b, _ := os.ReadFile(out); strings.TrimSpace(string(b)) != "2" {
		t.Errorf("job saw ARGO_WORKERS=%q, want 2", b)
	}
	got := r.store.jobRuns()
	if len(got) != 1 || got[0].Workers != 2 || got[0].BaseW != 10 || got[0].AvgW != 10 {
		t.Errorf("jobs.jsonl: %+v", got)
	}
}
