package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---- eclipse energy budget (17 Nov, Josh: "a better system for the power use when we don't have power outlets") ----
//
// On battery Argo used to say "light work only" for any job over lightJobGB, so claude-heavy
// overrode it with its own budget and ran battery-admitted jobs under a fresh name. The budget now
// lives here, with the same numbers as ~/.local/bin/claude-heavy. As a spacecraft budgets depth of
// discharge for an eclipse, a job over lightJobGB starts on battery only while battery% >= reserve +
// the job's measured cost + hours until an outlet x base drain. The reserve (30%) is the worn
// battery's (~52% health) sag cliff: 4 Nov, 28 -> 10% in 8 min, then hibernation. The cost is the
// median battery-% drop of the job's last 5 runs on battery (jobs.jsonl batt0/batt1), 8% until 3 such
// runs exist; battery %, not watts, because avg_w/base_w are smoothed noise for jobs this short (gates
// showed 5.2 W running vs 5.8 W base while the battery fell 6% in 11 min, 17 Nov). The unplugged plan
// (`claude-heavy --unplugged 4h`) is the Unix second an outlet is expected, in
// ~/.local/state/gauss-unplugged; each hour left (rounded up) keeps 6% more in reserve. Since 24 Nov
// both are automatic (energy.go): with no manual plan, on battery, the hours come from the outlet
// forecast, and the 6%/h is replaced by the measured base drain once there is evidence.
//
// Jobs up to lightJobGB still start on battery as before. The 10% floor block, battery-low,
// battery-draining and the brownout pause are unchanged: they act before the budget.
const (
	eclipseReservePct  = 30 // HEAVY_BATTERY_RESERVE in claude-heavy
	eclipseDefaultCost = 8  // HEAVY_DEFAULT_COST: % per run until eclipseCostMin runs are measured
	eclipseBaseDrainH  = 6  // HEAVY_BASE_DRAIN: % per hour the Mac drains on its own while unplugged
	eclipseCostRuns    = 5  // newest runs on battery the median is taken over
	eclipseCostMin     = 3  // runs on battery before the measurement replaces the default
)

// Eclipse is one job's battery budget right now.
type Eclipse struct {
	Pct   int    // battery now
	Need  int    // battery % the job needs to start
	Cost  int    // % one run costs (measured median or the default)
	Runs  int    // runs the cost was measured over; 0 = the default
	PlanH int    // hours left on the unplugged plan
	Name  string // the job's kind
	// The plan's source and base drain (energy.go): "manual" (claude-heavy --unplugged) or
	// "predicted" (the outlet forecast); DrainH is measured once there is evidence, else 6.
	PlanSrc       string
	DrainH        int
	DrainMeasured bool
}

func (e Eclipse) fits() bool { return e.Pct >= e.Need }

// why is how the need adds up, in claude-heavy's words.
func (e Eclipse) why() string {
	name := e.Name
	if name == "" {
		name = "job"
	}
	src := "default until 3 runs"
	if e.Runs > 0 {
		src = fmt.Sprintf("median of %d measured", e.Runs)
	}
	s := fmt.Sprintf("%d%% reserve + %s ~%d%%/run (%s)", eclipseReservePct, name, e.Cost, src)
	if e.PlanH > 0 {
		drain := fmt.Sprintf("%d%%/h", e.DrainH)
		if e.DrainMeasured {
			drain += " measured"
		}
		if e.PlanSrc == "predicted" {
			s += fmt.Sprintf(" + %d h to an outlet (predicted) x %s", e.PlanH, drain)
		} else {
			s += fmt.Sprintf(" + %d h unplugged x %s", e.PlanH, drain)
		}
	}
	return s
}

// eclipseFor is the budget for job name on this reading with claude-heavy's plan alone and the
// default drain, or nil when the host is on AC or has no battery (nothing to budget).
func eclipseFor(cur Sample, runs []JobRun, name string, planUntil time.Time) *Eclipse {
	return eclipseWith(cur, runs, name, manualPlan(planUntil))
}

// eclipseWith is the budget on an energy plan (energy.go): manual or predicted hours to an outlet,
// times the measured or default base drain.
func eclipseWith(cur Sample, runs []JobRun, name string, p EnergyPlan) *Eclipse {
	if onAC(cur) {
		return nil
	}
	now := cur.At
	if now.IsZero() {
		now = time.Now()
	}
	cost, n := batteryCost(runs, name)
	h := planHours(p.Until, now)
	drain := p.DrainH
	if drain <= 0 {
		drain = eclipseBaseDrainH
	}
	return &Eclipse{Pct: cur.Batt.Pct, Need: eclipseReservePct + cost + h*drain, Cost: cost, Runs: n, PlanH: h, Name: name,
		PlanSrc: p.Src, DrainH: drain, DrainMeasured: p.Drain.Measured}
}

// onBatterySuffix is the name claude-heavy gave battery-admitted runs while it overrode Argo
// ("gates-on-battery-12345"); such runs still teach the job's own cost.
var onBatterySuffix = regexp.MustCompile(`-on-battery-[0-9]+$`)

func batteryKind(name string) string { return onBatterySuffix.ReplaceAllString(name, "") }

// batteryCost is the median battery-% drop of the job's newest eclipseCostRuns runs that ran on
// battery from start to end without a pause (a paused job's drop is the rest of the Mac's), as
// claude-heavy's job_cost: the upper median, at least 1. With fewer than eclipseCostMin it is the
// default and n is 0.
func batteryCost(runs []JobRun, name string) (pct, n int) {
	var c []int
	for i := len(runs) - 1; i >= 0 && len(c) < eclipseCostRuns; i-- {
		r := runs[i]
		if batteryKind(r.Name) == name && r.OnBatt && r.PauseSecs == 0 && r.BattStart > 0 && r.BattStart >= r.BattEnd {
			c = append(c, r.BattStart-r.BattEnd)
		}
	}
	if len(c) < eclipseCostMin {
		return eclipseDefaultCost, 0
	}
	sort.Ints(c)
	if pct = c[len(c)/2]; pct < 1 {
		pct = 1
	}
	return pct, len(c)
}

// planHours is the whole hours (rounded up) until the planned outlet; 0 with no plan or one that has passed.
func planHours(until, now time.Time) int {
	if until.IsZero() || !until.After(now) {
		return 0
	}
	return int((until.Sub(now) + time.Hour - time.Second) / time.Hour)
}

// unpluggedPath is where claude-heavy keeps the unplugged plan. ARGO_UNPLUGGED_FILE overrides it.
func unpluggedPath() string {
	if p := os.Getenv("ARGO_UNPLUGGED_FILE"); p != "" {
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".local", "state", "gauss-unplugged")
}

// readPlan is the deadline in the plan file (a Unix second); zero when there is none or it can't be read.
func readPlan(path string) time.Time {
	if path == "" {
		return time.Time{}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return time.Time{}
	}
	sec, err := strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
	if err != nil || sec <= 0 {
		return time.Time{}
	}
	return time.Unix(sec, 0)
}

// admitIn is admit with the job's eclipse budget. On battery, a job over lightJobGB starts when the
// budget holds (on-battery then no longer caps its RAM) and is refused with the sum when it doesn't.
// Everything at risk or block, and every other watch finding, still decides as in admit.
func admitIn(a Assessment, memGB float64, e *Eclipse) (bool, string) {
	if e == nil || a.Level >= LevelRisk || memGB <= lightJobGB || !hasCode(a, "on-battery") {
		return admit(a, memGB)
	}
	if !e.fits() {
		return false, fmt.Sprintf("on battery at %d%%: this job needs %d%% (%s)", e.Pct, e.Need, e.why())
	}
	ok, why := admit(without(a, "on-battery"), memGB)
	if ok {
		why = fmt.Sprintf("ok on battery at %d%%: within the eclipse budget of %d%% (%s)", e.Pct, e.Need, e.why())
	}
	return ok, why
}

// without drops one finding and recomputes the level from the rest.
func without(a Assessment, code string) Assessment {
	out := a
	out.Findings, out.Level = nil, LevelOK
	for _, f := range a.Findings {
		if f.Code == code {
			continue
		}
		out.Findings = append(out.Findings, f)
		if f.Level > out.Level {
			out.Level = f.Level
		}
	}
	return out
}

// eclipseText is the budget section of `argo guard` on battery or with a plan: what each measured job
// needs to start on battery now.
func eclipseText(cur Sample, runs []JobRun, planUntil time.Time) string {
	return eclipseTextPlan(cur, runs, manualPlan(planUntil))
}

// eclipseTextPlan is eclipseText on an energy plan (manual or predicted, energy.go).
func eclipseTextPlan(cur Sample, runs []JobRun, p EnergyPlan) string {
	now := cur.At
	if now.IsZero() {
		now = time.Now()
	}
	h := planHours(p.Until, now)
	drain := p.DrainH
	if drain <= 0 {
		drain = eclipseBaseDrainH
	}
	var b strings.Builder
	if h > 0 {
		what := "unplugged plan"
		if p.Src == "predicted" {
			what = fmt.Sprintf("outlet forecast (P80 of %d battery spans, `argo energy`)", p.Forecast.Spans)
		}
		fmt.Fprintf(&b, "\n%s: %d h left: heavy jobs on battery keep %d%% + %d h x %d%%/h = %d%% in reserve\n",
			what, h, eclipseReservePct, h, drain, eclipseReservePct+h*drain)
	}
	if onAC(cur) {
		return b.String()
	}
	fmt.Fprintf(&b, "\neclipse budget (on battery at %d%%; jobs over %.0f GB start at the battery %% shown)\n", cur.Batt.Pct, lightJobGB)
	seen := map[string]bool{}
	shown := 0
	for i := len(runs) - 1; i >= 0 && shown < 8; i-- {
		k := batteryKind(runs[i].Name)
		if seen[k] {
			continue
		}
		seen[k] = true
		e := eclipseWith(cur, runs, k, p)
		verdict := "starts"
		if !e.fits() {
			verdict = "waits"
		}
		fmt.Fprintf(&b, "  %-24s %3d%%  %s (%s)\n", k, e.Need, verdict, e.why())
		shown++
	}
	if shown == 0 {
		e := eclipseWith(cur, nil, "", p)
		fmt.Fprintf(&b, "  any job                  %3d%%  (%s)\n", e.Need, e.why())
	}
	return b.String()
}
