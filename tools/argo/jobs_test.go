package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---- learned job sizing (GAU-200) ----

func runs(name string, outcome string, peaks ...float64) []JobRun {
	var out []JobRun
	for i, p := range peaks {
		out = append(out, JobRun{At: t0.Add(time.Duration(i) * time.Minute), Name: name, PeakGB: p, Outcome: outcome})
	}
	return out
}

func TestJobName(t *testing.T) {
	for _, c := range []struct{ name, argv0, want string }{
		{"", "/usr/local/bin/npm", "npm"},
		{"gates", "/bin/sh", "gates"},
		{"gau-199 gates: a48f2e8", "", "gau-199-gates--a48f2e8"},
		{"tok=abc$(rm -rf)", "", "tokabcrm--rf"},
		{"", "", "job"},
		{strings.Repeat("x", 90), "", strings.Repeat("x", 40)},
	} {
		var argv []string
		if c.argv0 != "" {
			argv = []string{c.argv0, "--token", "secret"}
		}
		if got := jobName(c.name, argv); got != c.want {
			t.Errorf("jobName(%q, %v) = %q, want %q", c.name, argv, got, c.want)
		}
	}
}

func TestLearnedGB(t *testing.T) {
	if _, n, ok := learnedGB(runs("gates", "exit 0", 1, 1), "gates"); ok || n != 2 {
		t.Errorf("learned from %d runs, want to wait for %d", n, learnMin)
	}
	// p95 of 1.0, 1.2, 2.0 is 2.0; × 1.25 = 2.5.
	if gb, n, ok := learnedGB(runs("gates", "exit 0", 1, 1.2, 2), "gates"); !ok || n != 3 || gb != 2.5 {
		t.Errorf("learned %.2f GB from %d runs (ok %v), want 2.5 from 3", gb, n, ok)
	}
	// Stopped, failed or unmeasured runs and other jobs don't count.
	mixed := append(runs("gates", "stopped", 9, 9, 9), runs("build", "exit 0", 9, 9, 9)...)
	mixed = append(mixed, runs("gates", "exit 130", 2, 2, 2)...)
	mixed = append(mixed, runs("gates", "exit 0", 0, 0, 0)...)
	if _, n, ok := learnedGB(mixed, "gates"); ok {
		t.Errorf("learned from %d runs that were stopped, unmeasured or another job's", n)
	}
	// Only the newest learnWindow runs count, so a job that got lighter relearns.
	old := runs("gates", "exit 0", 6, 6, 6, 6, 6)
	recent := runs("gates", "exit 0", 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4)
	for i := range recent {
		recent[i].At = t0.Add(time.Hour + time.Duration(i)*time.Minute)
	}
	if gb, _, _ := learnedGB(append(old, recent...), "gates"); gb != 0.5 {
		t.Errorf("relearned %.2f GB, want 0.5 (0.4 × 1.25)", gb)
	}
	// Never less than the floor.
	if gb, _, _ := learnedGB(runs("ls", "exit 0", 0.01, 0.01, 0.01), "ls"); gb != learnFloorGB {
		t.Errorf("tiny job learned %.2f GB, want the %.1f GB floor", gb, learnFloorGB)
	}
}

func TestJobNeedBothWays(t *testing.T) {
	small := runs("check", "exit 0", 0.3, 0.3, 0.3)
	if need, note := jobNeed(1, small, "check"); need != 0.4 || !strings.Contains(note, "measured over its last 3 runs (asked 1.0)") {
		t.Errorf("small job: need %.1f %q", need, note)
	}
	big := runs("build", "exit 0", 2.8, 3, 3)
	if need, _ := jobNeed(1, big, "build"); need != 3.8 {
		t.Errorf("big job: need %.1f, want 3.8", need)
	}
	if need, note := jobNeed(1, nil, "new"); need != 1 || note != "" {
		t.Errorf("unmeasured job: need %.1f %q, want the guess", need, note)
	}
}

func TestJobWorkers(t *testing.T) {
	c := calm() // 32 GB, 10 in RAM, 10 cores: 20.5 GB headroom
	if n := jobWorkers(c, assess(nil, c), 0.5); n != 9 {
		t.Errorf("roomy host: %d workers, want 9 (cores − 1)", n)
	}
	tight := c
	tight.RAMGB, tight.InRAMGB = 8, 5.5 // 1.0 GB headroom
	if n := jobWorkers(tight, assess(nil, tight), 0.5); n != 2 {
		t.Errorf("1 GB headroom: %d workers, want 2", n)
	}
	full := c
	full.RAMGB, full.InRAMGB = 8, 7.9
	if n := jobWorkers(full, assess(nil, full), 0.5); n != 1 {
		t.Errorf("no headroom: %d workers, want 1", n)
	}
	w := c
	w.Pressure = "warn"
	if n := jobWorkers(w, assess(nil, w), 0.5); n != 1 {
		t.Errorf("watch: %d workers, want 1", n)
	}
}

func TestJobEnv(t *testing.T) {
	env := jobEnv([]string{"PATH=/bin"}, 3, 2.5)
	if !hasEnv(env, "ARGO_WORKERS=3") || !hasEnv(env, "ARGO_HEADROOM_GB=2.5") || !hasEnv(env, "PATH=/bin") {
		t.Errorf("env %v", env)
	}
	if env := jobEnv([]string{"ARGO_WORKERS=1"}, 6, 2.5); hasEnv(env, "ARGO_WORKERS=6") {
		t.Errorf("overrode the caller's ARGO_WORKERS: %v", env)
	}
}

func hasEnv(env []string, kv string) bool {
	for _, v := range env {
		if v == kv {
			return true
		}
	}
	return false
}

func TestAppendJobTrims(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	for i := 0; i < 2*jobsKeep; i++ {
		if err := s.appendJob(JobRun{At: t0.Add(time.Duration(i) * time.Second), Name: "j", PeakGB: 0.1, Outcome: "exit 0"}); err != nil {
			t.Fatal(err)
		}
	}
	got := s.jobRuns()
	if len(got) != jobsKeep || !got[len(got)-1].At.Equal(t0.Add(time.Duration(2*jobsKeep-1)*time.Second)) {
		t.Errorf("kept %d runs ending %s, want %d ending with the newest", len(got), got[len(got)-1].At, jobsKeep)
	}
}

// TestGuardRunLearns: a real guarded run records its peak, the job sees
// ARGO_WORKERS, and after three runs the measurement decides admission.
func TestGuardRunLearns(t *testing.T) {
	// Run under `argo guard run` (claude-heavy), the test itself inherits ARGO_WORKERS and
	// ARGO_HEADROOM_GB, and a caller's value rightly wins over the computed one.
	for _, k := range []string{"ARGO_WORKERS", "ARGO_HEADROOM_GB"} {
		t.Setenv(k, "")
		os.Unsetenv(k)
	}
	ok := assess(nil, calm())
	out := filepath.Join(t.TempDir(), "workers")
	st := Store{Dir: t.TempDir()}
	var r guardRunner
	for i := 0; i < learnMin; i++ {
		r = fakeRunner(t, ok)
		r.store = st
		r.name, r.workerGB = "check", 0.5
		r.jobGB = func(int) float64 { return 0.3 }
		if code, err := r.run(1, 0, 0, []string{"sh", "-c", `sleep 0.1; echo "$ARGO_WORKERS" > "$0"`, out}); err != nil || code != 0 {
			t.Fatalf("run %d: exit %d %v", i, code, err)
		}
	}
	if b, _ := os.ReadFile(out); strings.TrimSpace(string(b)) != "9" {
		t.Errorf("job saw ARGO_WORKERS=%q, want 9", b)
	}
	got := r.store.jobRuns()
	if len(got) != learnMin || got[0].Name != "check" || got[0].PeakGB != 0.3 || got[0].Outcome != "exit 0" {
		t.Fatalf("jobs.jsonl: %+v", got)
	}
	if log, _ := os.ReadFile(r.store.path("guard.log")); !strings.Contains(string(log), "sh exit 0, peak 0.3 GB") {
		t.Errorf("guard.log: %q", log)
	}

	// At watch only jobs up to 1 GB start. Asked 2 GB, but it measured 0.3: admitted.
	w := calm()
	w.Pressure = "warn"
	watch := assess(nil, w)
	r2 := fakeRunner(t, watch)
	r2.store = r.store
	if yes, why, _, _ := r2.waitAdmit("check", 2, 0); !yes {
		t.Errorf("measured-light job refused at watch: %s", why)
	}
	// Without a name the guess still decides.
	if yes, _, _, _ := r2.waitAdmit("", 2, 0); yes {
		t.Error("unnamed 2 GB job admitted at watch")
	}
	if txt := jobsText(r.store.jobRuns()); !strings.Contains(txt, "check") || !strings.Contains(txt, "learned 0.4 GB from 3 runs") {
		t.Errorf("jobs text:\n%s", txt)
	}
}

func TestLongJob(t *testing.T) {
	run := func(secs int, outcome string) JobRun {
		return JobRun{Name: "gates", PeakGB: 1, Secs: secs, Outcome: outcome}
	}
	short := []JobRun{run(120, "exit 0"), run(180, "exit 0"), run(150, "exit 0")}
	if longJob(short, "gates") {
		t.Error("2-3 minute gate runs counted as long")
	}
	long := []JobRun{run(1200, "exit 0"), run(1300, "exit 0"), run(1250, "exit 0"), run(5000, "stopped")}
	if !longJob(long, "gates") {
		t.Error("20 minute runs not counted as long")
	}
	if longJob(long[:2], "gates") {
		t.Error("long after only 2 runs (needs 3)")
	}
}
