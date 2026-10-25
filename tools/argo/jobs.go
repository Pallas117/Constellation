package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ---- learned job sizing (GAU-200) ----
//
// `argo guard run` measures what each job really holds at its peak and keeps it
// in jobs.jsonl (this device only, never sent). Admission then trusts the
// measurement over the caller's guess, both ways: a 0.3 GB check is no longer
// refused for want of 1 GB, and a build that keeps needing 3 GB stops getting
// in on a 1 GB guess. The job is also told how many workers this host can
// afford now (ARGO_WORKERS), so test runners and browsers size themselves.

// JobRun is one finished guarded job.
type JobRun struct {
	At      time.Time `json:"at"`
	Name    string    `json:"name"`
	PeakGB  float64   `json:"peak_gb"` // largest process-group RSS seen at a check
	Secs    int       `json:"secs"`
	Outcome string    `json:"outcome"` // "exit N" or "stopped"
}

const (
	learnMin     = 3    // successful, measured runs before the measurement replaces the guess
	learnWindow  = 10   // only the newest runs count, so a job that changed is relearned
	learnMargin  = 1.25 // RSS leaves out compressed pages and misses spikes between checks
	learnFloorGB = 0.2  // never admit a job on less than this
	jobsKeep     = 400  // lines kept in jobs.jsonl (about 40 KB)

	// defaultWorkerGB is one test file or browser worker. Override with
	// "guard_worker_gb" in config.json; measured on judith 2026-10-24 (see README).
	defaultWorkerGB = 0.5
)

// jobName is the key a job learns under: -name if given, else the command's
// base name. Arguments never count (they can carry tokens), and only a short,
// plain name is kept.
func jobName(name string, argv []string) string {
	if name == "" && len(argv) > 0 {
		name = filepath.Base(argv[0])
	}
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
			b.WriteRune(r)
		case r == ' ' || r == '/' || r == ':':
			b.WriteByte('-')
		}
		if b.Len() >= 40 {
			break
		}
	}
	if b.Len() == 0 {
		return "job"
	}
	return b.String()
}

func (s Store) jobRuns() []JobRun {
	f, err := os.Open(s.path("jobs.jsonl"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []JobRun
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var j JobRun
		if json.Unmarshal(sc.Bytes(), &j) == nil && j.Name != "" {
			out = append(out, j)
		}
	}
	sort.SliceStable(out, func(i, k int) bool { return out[i].At.Before(out[k].At) })
	return out
}

// appendJob adds one run and, once that makes twice jobsKeep, rewrites the file
// with the newest jobsKeep.
func (s Store) appendJob(j JobRun) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(j)
	if runs := s.jobRuns(); len(runs)+1 >= 2*jobsKeep {
		var buf strings.Builder
		for _, r := range append(runs[len(runs)-jobsKeep+1:], j) {
			rb, _ := json.Marshal(r)
			buf.Write(rb)
			buf.WriteByte('\n')
		}
		tmp := s.path("jobs.jsonl.tmp")
		if err := os.WriteFile(tmp, []byte(buf.String()), 0o600); err != nil {
			return err
		}
		return os.Rename(tmp, s.path("jobs.jsonl"))
	}
	f, err := os.OpenFile(s.path("jobs.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

// learnedGB is a job's measured need: the p95 of its newest successful,
// measured runs, plus the margin. ok is false until there are learnMin of them.
// Only exit 0 counts: a stopped, interrupted or failed-early run may never have
// reached its own peak.
func learnedGB(runs []JobRun, name string) (gb float64, n int, ok bool) {
	var peaks []float64
	for i := len(runs) - 1; i >= 0 && len(peaks) < learnWindow; i-- {
		r := runs[i]
		if r.Name == name && r.Outcome == "exit 0" && r.PeakGB > 0 {
			peaks = append(peaks, r.PeakGB)
		}
	}
	if len(peaks) < learnMin {
		return 0, len(peaks), false
	}
	gb = ceil1(percentile(peaks, 0.95) * learnMargin)
	if gb < learnFloorGB {
		gb = learnFloorGB
	}
	return gb, len(peaks), true
}

// ceil1 rounds up to 0.1 GB, so a learned need never rounds below what was seen.
func ceil1(v float64) float64 {
	n := int(v * 10)
	if float64(n) < v*10 {
		n++
	}
	return float64(n) / 10
}

// jobNeed is what admission uses for a job: the measurement once there is
// enough of it, else the caller's guess. note says which, for the output.
func jobNeed(asked float64, runs []JobRun, name string) (need float64, note string) {
	gb, n, ok := learnedGB(runs, name)
	if !ok {
		return asked, ""
	}
	return gb, fmt.Sprintf("%s needs %.1f GB, measured over its last %d runs (asked %.1f)", name, gb, n, asked)
}

// jobWorkers is how many parallel workers (test files, browsers) a job should
// use on this host now: one at watch, else what the headroom holds, leaving a
// core free and never fewer than one.
func jobWorkers(cur Sample, a Assessment, workerGB float64) int {
	if workerGB <= 0 {
		workerGB = defaultWorkerGB
	}
	if a.Level >= LevelWatch {
		return 1
	}
	n := int(a.HeadroomGB / workerGB)
	if cur.CPUs > 1 && n > cur.CPUs-1 {
		n = cur.CPUs - 1
	}
	if n < 1 {
		n = 1
	}
	return n
}

// jobEnv adds the sizing hints to the job's environment. A value the caller
// already set wins: they asked for it.
func jobEnv(env []string, workers int, headroomGB float64) []string {
	has := func(k string) bool {
		for _, e := range env {
			if strings.HasPrefix(e, k+"=") {
				return true
			}
		}
		return false
	}
	out := append([]string(nil), env...)
	if !has("ARGO_WORKERS") {
		out = append(out, fmt.Sprintf("ARGO_WORKERS=%d", workers))
	}
	if !has("ARGO_HEADROOM_GB") {
		out = append(out, fmt.Sprintf("ARGO_HEADROOM_GB=%.1f", headroomGB))
	}
	return out
}

// jobsText is the "jobs" section of `argo guard`: what each job has needed.
func jobsText(runs []JobRun) string {
	seen := map[string]bool{}
	var names []string
	for i := len(runs) - 1; i >= 0; i-- {
		if !seen[runs[i].Name] {
			seen[runs[i].Name] = true
			names = append(names, runs[i].Name)
		}
	}
	if len(names) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\njobs measured (newest first; admission uses the learned need)\n")
	for i, name := range names {
		if i == 8 {
			fmt.Fprintf(&b, "  … and %d more\n", len(names)-i)
			break
		}
		if gb, n, ok := learnedGB(runs, name); ok {
			fmt.Fprintf(&b, "  %-24s learned %.1f GB from %d runs\n", name, gb, n)
		} else {
			fmt.Fprintf(&b, "  %-24s %d measured run(s), learning (needs %d)\n", name, n, learnMin)
		}
	}
	return b.String()
}
