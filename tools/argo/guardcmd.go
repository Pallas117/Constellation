package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// exitTempFail (EX_TEMPFAIL) tells callers such as claude-heavy that the
// guard refused or stopped the job and it is worth retrying later.
const exitTempFail = 75

// GuardState is what the tick leaves for `argo status`, the Gauss report and
// the next tick's autoscaler.
type GuardState struct {
	Scale  Scale       `json:"scale"`
	Report GuardReport `json:"report"`
	Batt   *Battery    `json:"battery,omitempty"`
}

// GuardReport is the part Gauss sees: the decision, coarse numbers and
// finding codes. No process names, no history.
type GuardReport struct {
	At         time.Time `json:"at"`
	Level      string    `json:"level"`
	Admission  string    `json:"admission"`
	Slots      int       `json:"slots"`
	HeadroomGB float64   `json:"headroomGB"`
	Reasons    []string  `json:"reasons"` // finding codes, worst first
	WarnMin    int       `json:"warnMin"`
	SwapRiseGB float64   `json:"swapRiseGB"`
	MinToFloor int       `json:"minToFloor"` // -1 unknown or on AC
}

func guardReport(a Assessment, sc Scale, at time.Time) GuardReport {
	fs := append([]Finding(nil), a.Findings...)
	sort.SliceStable(fs, func(i, j int) bool { return fs[i].Level > fs[j].Level })
	codes := []string{}
	for _, f := range fs {
		if len(codes) < 6 {
			codes = append(codes, f.Code)
		}
	}
	return GuardReport{At: at, Level: a.Level.String(), Admission: sc.Admission, Slots: sc.Slots, HeadroomGB: a.HeadroomGB,
		Reasons: codes, WarnMin: a.WarnMin, SwapRiseGB: a.SwapRiseGB, MinToFloor: a.MinToFloor}
}

func (s Store) loadGuard() GuardState {
	var g GuardState
	if b, err := os.ReadFile(s.path("guard-state.json")); err == nil {
		_ = json.Unmarshal(b, &g)
	}
	return g
}

func (s Store) saveGuard(g GuardState) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(g)
	tmp := s.path("guard-state.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path("guard-state.json"))
}

func (c Config) slotGB() float64 {
	if c.GuardSlotGB > 0 {
		return c.GuardSlotGB
	}
	return defaultSlotGB
}

// guardStep folds one sample into the history and the autoscaler. Pure apart
// from the store, so the replay test drives it with recorded samples.
func guardStep(s Store, cfg Config, cur Sample) (Assessment, GuardState) {
	hist := s.guardHistory()
	a := assess(hist, cur)
	prev := s.loadGuard()
	sc := autoscale(prev.Scale, a, targetSlots(cur, a, cfg.slotGB()), cur.At)
	g := GuardState{Scale: sc, Report: guardReport(a, sc, cur.At), Batt: cur.Batt}
	_ = s.appendGuard(cur, hist)
	_ = s.saveGuard(g)
	return a, g
}

// guardTick runs on every Argo tick: a cheap sample (no system_profiler, no
// ps), then the GAU-165 early warnings, rate-limited per key.
func guardTick(ctx context.Context, s Store, cfg Config, phone *Phone, now time.Time) {
	cur := sampleHost(ctx, false)
	a, _ := guardStep(s, cfg, cur)
	if phone == nil {
		return
	}
	for _, al := range guardAlerts(a, cur, func() []Group { return memoryUsers(ctx) }) {
		if shouldNotify(s, al.key, al.every, now) {
			phone.Send(al.title, al.msg, now)
		}
	}
}

type guardAlert struct {
	key        string
	every      time.Duration
	title, msg string
}

// guardAlerts covers what gauss-services.sh does not text about: sustained
// warn, swap climbing at warn, and low battery together with memory warn
// (GAU-165). Critical pressure, swap over 4 GB and the battery floor already
// text from the guard script, so they are not repeated here.
func guardAlerts(a Assessment, cur Sample, users func() []Group) []guardAlert {
	var out []guardAlert
	has := map[string]bool{}
	for _, f := range a.Findings {
		has[f.Code] = true
	}
	biggest := ""
	if has["mem-warn-sustained"] || has["swap-rising"] {
		if t := topGroups(users(), 3); t != "" {
			biggest = " Biggest: " + t + "."
		}
	}
	if has["mem-warn-sustained"] {
		out = append(out, guardAlert{"guard-memory", time.Hour, "Argo: memory under pressure",
			fmt.Sprintf("Memory was at warn for %d of the last 60 min; swap %.1f GB.%s New work is paused until it settles. Close the biggest one.", a.WarnMin, cur.SwapGB, biggest)})
	}
	if has["swap-rising"] {
		out = append(out, guardAlert{"guard-swap", time.Hour, "Argo: swap climbing",
			fmt.Sprintf("Swap grew %.1f GB in an hour (now %.1f GB) with memory at warn. That is how the last crash started.%s Close the biggest one.", a.SwapRiseGB, cur.SwapGB, biggest)})
	}
	if has["battery-low-pressure"] {
		out = append(out, guardAlert{"guard-battery-memory", 30 * time.Minute, "Argo: battery and memory",
			fmt.Sprintf("Battery %d%% with memory at warn. Plug in or close the browser.", cur.Batt.Pct)})
	}
	return out
}

// ---- argo guard ----

const guardUsage = `usage:
  argo guard                      deep report: memory, battery, disk, CPU, last 24 h, who uses memory, what to do
  argo guard --json               the same reading as JSON (for scripts)
  argo guard admit [-mem GB] [-wait 10m]
                                  exit 0 if a job needing GB may start now, 75 if not (with the reason)
  argo guard run [-mem GB] [-max GB] [-wait 10m] -- cmd [args...]
                                  run cmd only when admitted; stop it if the host reaches "block"
                                  or the job grows past -max GB; exit 75 when refused or stopped`

// guardCmd returns the process exit code.
func guardCmd(args []string, s Store, cfg Config, out io.Writer) (int, error) {
	sub := ""
	if len(args) > 0 {
		sub = args[0]
	}
	switch sub {
	case "", "--json":
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cur := sampleHost(ctx, true)
		hist := s.guardHistory()
		a := assess(hist, cur)
		g := s.loadGuard()
		// What the autoscaler would decide now, without moving its state: only ticks do that.
		g.Scale = autoscale(g.Scale, a, targetSlots(cur, a, cfg.slotGB()), cur.At)
		if sub == "--json" {
			b, _ := json.MarshalIndent(map[string]any{"sample": cur, "assessment": a, "scale": g.Scale}, "", "  ")
			fmt.Fprintln(out, string(b))
			return 0, nil
		}
		fmt.Fprint(out, guardText(cur, a, g.Scale, hist, memoryUsers(ctx)))
		return 0, nil
	case "admit":
		fs := flag.NewFlagSet("guard admit", flag.ContinueOnError)
		mem := fs.Float64("mem", 0, "GB of RAM the job needs")
		wait := fs.Duration("wait", 0, "keep checking this long before refusing")
		if err := fs.Parse(args[1:]); err != nil {
			return 2, err
		}
		r := newGuardRunner(s, out)
		if ok, why := r.waitAdmit(*mem, *wait); !ok {
			fmt.Fprintln(out, "argo guard: not now:", why)
			return exitTempFail, nil
		}
		fmt.Fprintln(out, "argo guard: admitted")
		return 0, nil
	case "run":
		fs := flag.NewFlagSet("guard run", flag.ContinueOnError)
		mem := fs.Float64("mem", 0, "GB of RAM the job needs to start")
		maxGB := fs.Float64("max", 0, "stop the job if its processes hold more than this many GB (0 = no cap)")
		wait := fs.Duration("wait", 0, "keep checking this long before refusing")
		if err := fs.Parse(args[1:]); err != nil {
			return 2, err
		}
		if fs.NArg() == 0 {
			return 2, errors.New(guardUsage)
		}
		return newGuardRunner(s, out).run(*mem, *maxGB, *wait, fs.Args())
	}
	return 2, errors.New(guardUsage)
}

// ---- guarded run ----

type guardRunner struct {
	store   Store
	out     io.Writer
	assess  func() (Sample, Assessment) // a fresh reading against the history
	jobGB   func(pgid int) float64      // RAM held by the job's process group
	every   time.Duration               // how often a running job is checked
	retry   time.Duration               // how often admission is retried while waiting
	grace   time.Duration               // SIGTERM to SIGKILL
	strikes int                         // consecutive bad checks before stopping
}

func newGuardRunner(s Store, out io.Writer) guardRunner {
	return guardRunner{
		store: s, out: out, every: 10 * time.Second, retry: 15 * time.Second, grace: 15 * time.Second, strikes: 2,
		assess: func() (Sample, Assessment) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			cur := sampleHost(ctx, false)
			return cur, assess(s.guardHistory(), cur)
		},
		jobGB: func(pgid int) float64 {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			return groupRSSGB(run(ctx, "ps", "-A", "-o", "pgid=,rss="), pgid)
		},
	}
}

// groupRSSGB sums `ps -A -o pgid=,rss=` (KB) for one process group.
func groupRSSGB(out string, pgid int) float64 {
	var kb float64
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		if g, err := strconv.Atoi(f[0]); err == nil && g == pgid {
			v, _ := strconv.ParseFloat(f[1], 64)
			kb += v
		}
	}
	return round1(kb / (1 << 20))
}

func (r guardRunner) waitAdmit(memGB float64, wait time.Duration) (bool, string) {
	deadline := time.Now().Add(wait)
	for {
		_, a := r.assess()
		ok, why := admit(a, memGB)
		if ok || !time.Now().Add(r.retry).Before(deadline.Add(time.Millisecond)) {
			return ok, why
		}
		time.Sleep(r.retry)
	}
}

func (r guardRunner) log(name, outcome string) {
	_ = os.MkdirAll(r.store.Dir, 0o700) // `argo guard run` can come before the first tick
	f, err := os.OpenFile(r.store.path("guard.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	// Only the command's base name: arguments can carry tokens.
	fmt.Fprintf(f, "%s %s %s\n", time.Now().UTC().Format(time.RFC3339), filepath.Base(name), Mask(outcome))
}

func (r guardRunner) run(memGB, maxGB float64, wait time.Duration, argv []string) (int, error) {
	if ok, why := r.waitAdmit(memGB, wait); !ok {
		fmt.Fprintln(r.out, "argo guard: not starting", filepath.Base(argv[0])+":", why)
		r.log(argv[0], "refused: "+why)
		return exitTempFail, nil
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	// Its own process group, so a stop reaches every child (npm, node, esbuild).
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		return 127, err
	}
	pgid := cmd.Process.Pid
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(sigs)

	tick := time.NewTicker(r.every)
	defer tick.Stop()
	strikes, why := 0, ""
	for {
		select {
		case err := <-done:
			code := exitCode(err)
			r.log(argv[0], fmt.Sprintf("exit %d", code))
			return code, nil
		case s := <-sigs: // Ctrl-C or a stop for us: pass it to the whole job
			_ = syscall.Kill(-pgid, s.(syscall.Signal))
		case <-tick.C:
			bad := ""
			if _, a := r.assess(); a.Level >= LevelBlock {
				bad = "host at block: " + worst(a)
			} else if maxGB > 0 {
				if used := r.jobGB(pgid); used > maxGB {
					bad = fmt.Sprintf("the job holds %.1f GB, over its %.1f GB cap", used, maxGB)
				}
			}
			if bad == "" {
				strikes = 0
				continue
			}
			if strikes++; strikes < r.strikes {
				continue
			}
			why = bad
			fmt.Fprintln(r.out, "argo guard: stopping", filepath.Base(argv[0])+":", why)
			_ = syscall.Kill(-pgid, syscall.SIGTERM)
			select {
			case <-done:
			case <-time.After(r.grace):
				_ = syscall.Kill(-pgid, syscall.SIGKILL)
				<-done
			}
			r.log(argv[0], "stopped: "+why)
			return exitTempFail, nil
		}
	}
}

func exitCode(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return 128 + int(ws.Signal())
		}
		return ee.ExitCode()
	}
	return 1
}

// ---- the deep report ----

var guardAdvice = map[string]string{
	"mem-critical":         "Close the biggest app below now. Guarded jobs are being stopped.",
	"mem-warn-sustained":   "Close the biggest app below. Mesh work stays paused until memory has been calm for 10 min.",
	"swap-rising":          "Swap is climbing at warn, the pattern before the last crash: close the biggest app below.",
	"swap-high":            "Swap is high: close apps or restart the browser to give it back.",
	"battery-floor":        "Plug in now: at the floor the Mac sleeps and work stops.",
	"battery-low":          "Plug in.",
	"battery-draining":     "Plug in: the battery reaches the floor within the hour.",
	"battery-low-pressure": "Plug in or close the browser.",
	"on-battery":           "Plug in to take more than light work.",
	"charger-behind":       "Use a stronger charger: this one can't keep up with the machine's draw.",
	"charger-weak":         "Use a stronger charger: the machine draws more than this one supplies.",
	"disk-critical":        "Free disk space now: swap needs room on the boot volume.",
	"disk-low":             "Free disk space (rebuildable caches first).",
	"cpu-throttled":        "Let it cool: hard surface, airflow, charger plugged in.",
	"cpu-saturated":        "Wait for running builds or tests to finish before starting more.",
}

func pct(n, d int) int {
	if d == 0 {
		return 0
	}
	return 100 * n / d
}

func percentile(v []float64, p float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	return s[int(float64(len(s)-1)*p+0.5)]
}

// guardText is the deep report. It stays on this device.
func guardText(cur Sample, a Assessment, sc Scale, hist []Sample, users []Group) string {
	var b strings.Builder
	w := func(format string, args ...any) { fmt.Fprintf(&b, format, args...) }
	mark := map[Level]string{LevelOK: "●", LevelWatch: "◐", LevelRisk: "▲", LevelBlock: "■"}[a.Level]
	w("argo guard  %s %s   admission %s · %d mesh slot(s) · %.1f GB free for new work\n\n",
		mark, strings.ToUpper(a.Level.String()), orDash(sc.Admission), sc.Slots, a.HeadroomGB)

	w("memory   pressure %s · %.1f of %.0f GB held by work in RAM", orDash(cur.Pressure), cur.InRAMGB, cur.RAMGB)
	if cur.DemandGB > 0 {
		w(" (%.1f GB uncompressed)", cur.DemandGB)
	}
	w("\n         swap %.1f GB (%+.1f GB in 1 h) · at warn %d of the last 60 min\n", cur.SwapGB, a.SwapRiseGB, a.WarnMin)
	if bt := cur.Batt; bt != nil && bt.Present {
		src := "on battery"
		if bt.OnAC {
			src = "on AC"
			if bt.AdapterW > 0 {
				src = fmt.Sprintf("adapter %.0f W", bt.AdapterW)
			}
		}
		state := "not charging"
		if bt.Charging {
			state = "charging"
		}
		w("battery  %d%% %s, %s", bt.Pct, state, src)
		if bt.SystemW > 0 {
			w(" · machine draws %.1f W", bt.SystemW)
		}
		if bt.LowPower {
			w(" · Low Power Mode")
		}
		w("\n")
		if bt.Cycles > 0 || bt.HealthPct > 0 {
			w("         %d cycles", bt.Cycles)
			if bt.HealthPct > 0 {
				w(" · holds %d%% of its design capacity", bt.HealthPct)
			}
			if bt.Condition != "" {
				w(" (%s)", bt.Condition)
			}
			w("\n")
		}
		if a.DrainPctH != 0 || a.MinToFloor >= 0 {
			w("         drain %.1f%%/h", a.DrainPctH)
			if a.MinToFloor >= 0 {
				w(" · ~%d min to the %d%% floor", a.MinToFloor, batteryFloorPct)
			}
			w("\n")
		}
	} else {
		w("battery  none (mains only)\n")
	}
	w("disk     %.1f GB free on / (swap lives there)\n", cur.DiskGB)
	w("cpu      load %.1f on %d cores", cur.Load1, cur.CPUs)
	switch {
	case cur.SpeedPct == 100:
		w(" · not throttled")
	case cur.SpeedPct > 0:
		w(" · throttled to %d%%", cur.SpeedPct)
	}
	w("\n")

	if len(a.Findings) > 0 {
		w("\nfindings, worst first\n")
		fs := append([]Finding(nil), a.Findings...)
		sort.SliceStable(fs, func(i, j int) bool { return fs[i].Level > fs[j].Level })
		for _, f := range fs {
			w("  %-6s %-8s %s\n", strings.ToUpper(f.Level.String()), f.Resource, f.Text)
		}
	}

	if day := recent(hist, cur.At, historyKeep); len(day) > 1 {
		var warn, crit, onBatt, nBatt int
		var inRAM, demand, swaps []float64
		minBatt := 101
		for _, s := range day {
			switch s.Pressure {
			case "warn":
				warn++
			case "critical":
				crit++
			}
			inRAM = append(inRAM, s.InRAMGB)
			if s.DemandGB > 0 {
				demand = append(demand, s.DemandGB)
			}
			swaps = append(swaps, s.SwapGB)
			if s.Batt != nil && s.Batt.Present {
				nBatt++
				if !s.Batt.OnAC {
					onBatt++
				}
				if s.Batt.Pct < minBatt {
					minBatt = s.Batt.Pct
				}
			}
		}
		w("\nlast %s (%d readings)\n", day[len(day)-1].At.Sub(day[0].At).Round(time.Minute), len(day))
		w("  memory at warn %d%%, critical %d%% of readings · p95 in RAM %.1f GB · max swap %.1f GB\n",
			pct(warn, len(day)), pct(crit, len(day)), percentile(inRAM, 0.95), percentile(swaps, 1))
		if nBatt > 0 {
			w("  on battery %d%% of readings · lowest %d%%\n", pct(onBatt, nBatt), minBatt)
		}
		if len(demand) > 0 {
			need := percentile(demand, 0.95) + reserveGB
			w("  needs ~%.1f GB (p95 uncompressed demand + %.1f GB reserve); this host has %.0f GB\n", need, reserveGB, cur.RAMGB)
		}
	}

	if t := topGroups(users, 5); t != "" {
		w("\nwho uses memory now (resident size, approximate; stays on this device)\n  %s\n", t)
	}

	seen := map[string]bool{}
	var todo []string
	for _, f := range a.Findings {
		if adv, ok := guardAdvice[f.Code]; ok && !seen[adv] {
			seen[adv] = true
			todo = append(todo, adv)
		}
	}
	if len(todo) > 0 {
		w("\nwhat to do\n")
		for _, t := range todo {
			w("  - %s\n", t)
		}
	}
	return b.String()
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

// guardStatus is the short suffix for `argo status`, from the last tick.
func guardStatus(g GuardState, now time.Time) string {
	if g.Report.At.IsZero() || now.Sub(g.Report.At) > 10*time.Minute || g.Report.Level == "ok" {
		return ""
	}
	return " guard:" + g.Report.Level
}

// addGuard adds the last tick's decision and battery to a Gauss report when
// they are fresh. Older Gauss versions drop fields they don't know.
func addGuard(report map[string]any, g GuardState, now time.Time) {
	if g.Report.At.IsZero() || now.Sub(g.Report.At) > 10*time.Minute {
		return
	}
	report["guard"] = g.Report
	if b := g.Batt; b != nil && b.Present { // the same block phones send (backend/mesh/store.ts parseBattery)
		report["battery"] = map[string]any{"level": b.Pct, "charging": b.Charging, "external": b.OnAC, "lowPower": b.LowPower}
	}
}
