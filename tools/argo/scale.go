package main

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"
)

// ---- `argo scale`: what work this host could not serve, measured ----
//
// Before onboarding outside compute (a cloud runner, an HPC allocation) the
// question is how much work this host turns away and what shape it is. The
// guard already measures every guarded job (jobs.jsonl: peak RAM, run time,
// watts, and since this version the time it waited for admission or sat
// paused). This report sums that per job and sorts each into:
//
//	local   fits here and rarely waits
//	burst   fits here but loses a quarter or more of its time waiting: a
//	        remote runner would return that time
//	remote  needs more RAM than this host can ever give it
//
// It only states what was measured. Work that has never run under the guard
// (GPU training, simulations at scale) is listed as missing, not estimated.
// Nothing leaves the device; --json is for a person or a later Gauss import.

const (
	scaleRows  = 15   // jobs listed by name; the rest are summed on one line
	burstShare = 0.25 // lost time as a share of run + lost time that makes a job a burst candidate
	burstRuns  = 3    // runs needed before a job is classed burst on measurement
)

// JobDemand is one job's measured demand over the window.
type JobDemand struct {
	Name   string  `json:"name"`
	Runs   int     `json:"runs"`
	Fails  int     `json:"fails"`
	RunH   float64 `json:"run_h"`
	LostH  float64 `json:"lost_h"` // waiting for admission + paused in eclipse
	P90GB  float64 `json:"p90_gb"`
	GBh    float64 `json:"gb_h"` // p90 peak × run hours: the RAM-time a runner must supply
	AvgW   float64 `json:"avg_w,omitempty"`
	Where  string  `json:"where"` // local | burst | remote
	Reason string  `json:"reason"`
}

// ScalePlan is the whole report.
type ScalePlan struct {
	Days       int         `json:"days"`
	RAMGB      float64     `json:"ram_gb"`
	CPUs       int         `json:"cpus"`
	UsableGB   float64     `json:"usable_gb"` // RAM after the reserve: the most one job can get here
	Jobs       []JobDemand `json:"jobs"`
	RunH       float64     `json:"run_h"`
	LostH      float64     `json:"lost_h"`
	ClosedPct  int         `json:"closed_pct"` // share of guard samples (last day) with admission closed; -1 unknown
	WaitKnown  bool        `json:"wait_known"` // whether any run in the window recorded its wait
	RunnerGB   float64     `json:"runner_gb,omitempty"`
	RunnerCPUs int         `json:"runner_cpus,omitempty"`
	Advice     []string    `json:"advice"`
	Missing    []string    `json:"missing"`
}

// closedShare replays the assessment over the guard history and returns the
// percentage of samples at risk or worse (admission closed), or -1 with no history.
func closedShare(hist []Sample) int {
	if len(hist) == 0 {
		return -1
	}
	closed := 0
	for i := range hist {
		if assess(hist[:i], hist[i]).Level >= LevelRisk {
			closed++
		}
	}
	return pct(closed, len(hist))
}

func scalePlan(runs []JobRun, hist []Sample, days int, now time.Time) ScalePlan {
	p := ScalePlan{Days: days, ClosedPct: closedShare(hist)}
	if len(hist) > 0 {
		last := hist[len(hist)-1]
		p.RAMGB, p.CPUs = last.RAMGB, last.CPUs
	}
	if p.RAMGB > 0 {
		p.UsableGB = round1(p.RAMGB - reserveGB)
	}
	since := now.Add(-time.Duration(days) * 24 * time.Hour)
	by := map[string][]JobRun{}
	for _, r := range runs {
		if r.At.Before(since) {
			continue
		}
		by[r.Name] = append(by[r.Name], r)
		if r.WaitSecs > 0 || r.PauseSecs > 0 {
			p.WaitKnown = true
		}
	}
	for name, rs := range by {
		d := JobDemand{Name: name, Runs: len(rs)}
		var peaks []float64
		var runS, lostS int
		var sumW float64
		var nW int
		for _, r := range rs {
			peaks = append(peaks, r.PeakGB)
			runS += r.Secs
			lostS += r.WaitSecs + r.PauseSecs
			if r.Outcome != "exit 0" {
				d.Fails++
			}
			if r.AvgW > 0 {
				sumW += r.AvgW
				nW++
			}
		}
		d.P90GB = round1(percentile(peaks, 0.9))
		d.RunH, d.LostH = round2(float64(runS)/3600), round2(float64(lostS)/3600)
		d.GBh = round2(d.P90GB * float64(runS) / 3600)
		if nW > 0 {
			d.AvgW = round1(sumW / float64(nW))
		}
		share := 0.0
		if runS+lostS > 0 {
			share = float64(lostS) / float64(runS+lostS)
		}
		switch {
		case p.UsableGB > 0 && d.P90GB > p.UsableGB:
			d.Where, d.Reason = "remote", fmt.Sprintf("p90 peak %.1f GB is more than the %.1f GB this host can give one job", d.P90GB, p.UsableGB)
		case d.Runs >= burstRuns && share >= burstShare:
			d.Where, d.Reason = "burst", fmt.Sprintf("lost %.0f%% of its time waiting or paused", share*100)
		default:
			d.Where, d.Reason = "local", "fits and rarely waits"
			if share > 0 {
				d.Reason = fmt.Sprintf("fits; lost %.0f%% of its time", share*100)
			}
		}
		p.RunH += d.RunH
		p.LostH += d.LostH
		p.Jobs = append(p.Jobs, d)
	}
	p.RunH, p.LostH = round2(p.RunH), round2(p.LostH)
	sort.Slice(p.Jobs, func(i, j int) bool {
		a, b := p.Jobs[i], p.Jobs[j]
		if a.LostH+a.GBh != b.LostH+b.GBh {
			return a.LostH+a.GBh > b.LostH+b.GBh
		}
		return a.Name < b.Name
	})
	p.Advice, p.Missing = scaleAdvice(&p)
	return p
}

// scaleAdvice turns the measurements into sizing statements, each with its numbers.
func scaleAdvice(p *ScalePlan) (advice, missing []string) {
	var off []JobDemand
	var lost float64
	for _, j := range p.Jobs {
		if j.Where != "local" {
			off = append(off, j)
			lost += j.LostH
			if g := math.Ceil(j.P90GB*learnMargin) + reserveGB; g > p.RunnerGB {
				p.RunnerGB = g
			}
		}
	}
	switch {
	case len(off) == 0 && !p.WaitKnown:
		advice = append(advice, "every measured job fits this host's RAM; whether any waits too long is not known yet (no wait times recorded)")
	case len(off) == 0:
		advice = append(advice, "no measured job needs outside compute: every job fits this host and rarely waits")
	default:
		names := make([]string, 0, len(off))
		for _, j := range off {
			names = append(names, j.Name)
		}
		p.RunnerCPUs = p.CPUs
		if p.RunnerCPUs < 2 {
			p.RunnerCPUs = 2
		}
		advice = append(advice, fmt.Sprintf("offload candidates: %s; they lost %.1f h in %d days here", strings.Join(names, ", "), lost, p.Days))
		advice = append(advice, fmt.Sprintf("smallest runner that takes them one at a time: %.0f GB RAM, %d cores (p90 peak × %.2f + %.1f GB reserve)",
			p.RunnerGB, p.RunnerCPUs, learnMargin, reserveGB))
	}
	if p.ClosedPct > 0 {
		advice = append(advice, fmt.Sprintf("admission was closed for %d%% of the last day's samples", p.ClosedPct))
	}
	if !p.WaitKnown {
		missing = append(missing, "wait and pause times: recorded from this version on, so 'burst' is under-counted until runs accumulate")
	}
	missing = append(missing,
		"GPU or accelerator work: no guarded job used one, so world-model training cannot be sized from this host; run a benchmark job first",
		"other mesh hosts: this report covers this device only; run `argo scale` on each")
	return advice, missing
}

func round2(v float64) float64 { return math.Round(v*100) / 100 }

func scaleText(p ScalePlan) string {
	var b strings.Builder
	fmt.Fprintf(&b, "argo scale: measured demand over %d days on this host (%.0f GB RAM, %d cores, %.1f GB for one job)\n", p.Days, p.RAMGB, p.CPUs, p.UsableGB)
	fmt.Fprintf(&b, "  run %.1f h, lost %.1f h waiting or paused\n\n", p.RunH, p.LostH)
	if len(p.Jobs) == 0 {
		b.WriteString("  no guarded jobs in the window\n")
	} else {
		fmt.Fprintf(&b, "  %-24s %5s %5s %7s %7s %6s %7s %6s  %s\n", "job", "runs", "fail", "run", "lost", "p90", "GB·h", "W", "where")
		for i, j := range p.Jobs {
			if i == scaleRows {
				var runs int
				var runH, lostH float64
				for _, r := range p.Jobs[i:] {
					runs, runH, lostH = runs+r.Runs, runH+r.RunH, lostH+r.LostH
				}
				fmt.Fprintf(&b, "  %-24s %5d %5s %6.2fh %6.2fh  (--json lists them)\n", fmt.Sprintf("%d smaller jobs", len(p.Jobs)-i), runs, "", runH, lostH)
				break
			}
			w := "-"
			if j.AvgW > 0 {
				w = fmt.Sprintf("%.1f", j.AvgW)
			}
			fmt.Fprintf(&b, "  %-24s %5d %5d %6.2fh %6.2fh %5.1fG %7.2f %6s  %s: %s\n", trunc(j.Name, 24), j.Runs, j.Fails, j.RunH, j.LostH, j.P90GB, j.GBh, w, j.Where, j.Reason)
		}
	}
	b.WriteString("\n")
	for _, a := range p.Advice {
		b.WriteString("  → " + a + "\n")
	}
	for _, m := range p.Missing {
		b.WriteString("  MISSING: " + m + "\n")
	}
	return b.String()
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n-1] + "…"
}
