package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"regexp"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ---- energy autopilot (24 Nov 2026, Josh: "this should happen automatically, build a process,
// perhaps use machine learning or sets of algorithms") ----
//
// The eclipse budget (eclipse.go) keeps battery % >= reserve + job cost + hours until an outlet x
// base drain. Two of those numbers were typed by hand: the hours (`claude-heavy --unplugged 12h`)
// and the drain (6 %/h). Both are now learned from this Mac's own evidence, as a spacecraft's power
// subsystem learns its eclipse length and load from telemetry instead of a ground command:
//
//   - Outlet forecast: every AC/battery change Argo sees (guard samples) plus macOS's own record
//     (`pmset -g log` "Using AC"/"Using Batt", about 8 days, read at most once a day) gives battery
//     spans. Given how long the Mac has been on battery now (e), each past span longer than e gives
//     one point: what was left of it after e. The forecast is the P80 of those points (nearest
//     rank), taken over the spans whose hour of day at e is within +-2 h of now when there are at
//     least 4 of them, else over all of them (3+), capped at 12 h. Fewer than 3 spans: no forecast,
//     and the budget is what it was. On battery longer than all but 2 past spans: the 12 h cap
//     (conservative: the most in reserve). A manual `claude-heavy --unplugged` plan always wins.
//   - Every forecast is logged once per battery span (energy.jsonl, "predict") with its outcome
//     when AC returns ("outcome"), so `argo energy` shows MAE (of the P50) and coverage (share of
//     spans that ended within the P80): the forecast is credited only with that evidence.
//   - Base drain: the duration-weighted median %/h over closed battery stretches with no guarded
//     job running (jobs.jsonl) and no sleep gap, each at least 30 min, kept 14 days. It replaces
//     the 6 %/h default once there are 3 h of such stretches, rounded up and clamped to 2-20 %/h.
//
// Rule-based and statistical on purpose: a learned model (e.g. quantile regression over hour,
// weekday, network and battery %) needs outcomes to train and to be checked against. Only once
// energy.jsonl holds mlMinOutcomes scored spans, and only if it beats this P80 on held-out coverage
// and MAE, is that worth building.
const (
	outletQuantile   = 0.8
	outletCapH       = 12.0
	outletMinSpans   = 3                   // closed battery spans before any forecast
	outletCondSpans  = 4                   // spans in the hour-of-day window before it is used
	outletHourWindow = 2                   // +- hours of day
	outletFlap       = 5 * time.Minute     // AC or battery shorter than this is a loose cable, not an outlet
	outletHistory    = 30 * 24 * time.Hour // edges kept
	outletMaxEdges   = 500
	pmsetImportEvery = 24 * time.Hour // `pmset -g log` costs ~6 s of CPU (12 MB on judith, 24 Nov)

	drainMinStretch  = 30 * time.Minute
	drainMinHours    = 3.0
	drainMinPctH     = 2
	drainMaxPctH     = 20
	drainHistory     = 14 * 24 * time.Hour
	drainMaxStretchs = 100

	energyLogKeep = 500 // energy.jsonl lines
	mlMinOutcomes = 100 // scored spans before a learned model is worth trying (see above)
)

// PowerEdge is the power source from a moment on (a transition, or the first time Argo saw it).
type PowerEdge struct {
	At  time.Time `json:"at"`
	AC  bool      `json:"ac"`
	Src string    `json:"src,omitempty"` // "argo" (guard sample) or "pmset"
}

// DrainStretch is one closed stretch on battery with no guarded job and no sleep gap.
type DrainStretch struct {
	Start time.Time `json:"start"`
	End   time.Time `json:"end"`
	Pct0  int       `json:"p0"`
	Pct1  int       `json:"p1"`
}

// OutletPrediction is the forecast made for the current battery span, kept until AC returns.
type OutletPrediction struct {
	ID   int64     `json:"id"` // the span's start, Unix seconds
	At   time.Time `json:"at"`
	P50H float64   `json:"p50"`
	P80H float64   `json:"p80"`
}

// EnergyState is energy.json (0600): the evidence the autopilot learns from.
type EnergyState struct {
	Edges     []PowerEdge       `json:"edges,omitempty"`
	Stretches []DrainStretch    `json:"stretches,omitempty"`
	Open      *OutletPrediction `json:"open,omitempty"`
	LastAC    bool              `json:"lastAC"`
	LastAt    time.Time         `json:"lastAt,omitempty"`
	PmsetAt   time.Time         `json:"pmsetAt,omitempty"` // last import attempt
	Rev       int               `json:"rev,omitempty"`     // highest energyRev that saved it
}

// EnergyLog is one line of energy.jsonl.
type EnergyLog struct {
	Kind    string    `json:"kind"` // predict | outcome
	ID      int64     `json:"id"`
	At      time.Time `json:"at"`
	P50H    float64   `json:"p50,omitempty"`
	P80H    float64   `json:"p80,omitempty"`
	Spans   int       `json:"spans,omitempty"`
	Basis   string    `json:"basis,omitempty"` // hour | all | beyond
	ActualH float64   `json:"actual,omitempty"`
}

// ---- outlet forecast ----

type battSpan struct{ start, end time.Time }

// collapseEdges sorts edges, keeps only changes (the earliest sighting of each state wins), drops
// those older than outletHistory before now and keeps at most outletMaxEdges.
func collapseEdges(edges []PowerEdge, now time.Time) []PowerEdge {
	e := append([]PowerEdge(nil), edges...)
	sort.SliceStable(e, func(i, j int) bool { return e[i].At.Before(e[j].At) })
	var out []PowerEdge
	for _, x := range e {
		if now.Sub(x.At) > outletHistory {
			continue
		}
		if len(out) > 0 && out[len(out)-1].AC == x.AC {
			continue
		}
		out = append(out, x)
	}
	if len(out) > outletMaxEdges {
		out = out[len(out)-outletMaxEdges:]
	}
	return out
}

// batterySpans reads collapsed edges as closed battery spans plus, when the newest edge is on
// battery, the start of the open one. AC shorter than outletFlap joins the spans either side, and
// closed spans shorter than outletFlap are dropped.
func batterySpans(edges []PowerEdge) (closed []battSpan, open time.Time) {
	var raw []battSpan
	for i, e := range edges {
		if e.AC {
			continue
		}
		if i+1 < len(edges) {
			raw = append(raw, battSpan{e.At, edges[i+1].At})
		} else {
			open = e.At
		}
	}
	for _, s := range raw {
		if n := len(closed); n > 0 && s.start.Sub(closed[n-1].end) < outletFlap {
			closed[n-1].end = s.end
			continue
		}
		closed = append(closed, s)
	}
	if n := len(closed); n > 0 && !open.IsZero() && open.Sub(closed[n-1].end) < outletFlap {
		open, closed = closed[n-1].start, closed[:n-1]
	}
	out := closed[:0]
	for _, s := range closed {
		if s.end.Sub(s.start) >= outletFlap {
			out = append(out, s)
		}
	}
	return out, open
}

// OutletForecast is how long until the next AC, from history.
type OutletForecast struct {
	OK       bool    `json:"ok"`
	P50H     float64 `json:"p50,omitempty"`
	P80H     float64 `json:"p80,omitempty"`
	Spans    int     `json:"spans,omitempty"`   // points the quantile was taken over (one per span)
	History  int     `json:"history"`           // closed battery spans known
	Basis    string  `json:"basis,omitempty"`   // hour | all | beyond
	ElapsedH float64 `json:"elapsed,omitempty"` // on battery this long already
}

func hourNear(a, b, w int) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return min(d, 24-d) <= w
}

// quantile is the nearest-rank quantile of v (not changed), 0 when empty.
func quantile(v []float64, q float64) float64 {
	if len(v) == 0 {
		return 0
	}
	s := append([]float64(nil), v...)
	sort.Float64s(s)
	i := int(math.Ceil(q*float64(len(s)))) - 1
	return s[max(0, min(i, len(s)-1))]
}

// forecastOutlet is the outlet forecast at now (see the header). On AC it answers "if unplugged now".
func forecastOutlet(edges []PowerEdge, now time.Time, loc *time.Location) OutletForecast {
	spans, open := batterySpans(collapseEdges(edges, now))
	f := OutletForecast{History: len(spans)}
	if len(spans) < outletMinSpans {
		return f
	}
	var e time.Duration
	if !open.IsZero() && now.After(open) {
		e = now.Sub(open)
	}
	f.ElapsedH = e.Hours()
	hour := now.In(loc).Hour()
	var all, cond []float64
	for _, s := range spans {
		l := s.end.Sub(s.start)
		if l <= e {
			continue
		}
		rem := (l - e).Hours()
		all = append(all, rem)
		if hourNear(s.start.Add(e).In(loc).Hour(), hour, outletHourWindow) {
			cond = append(cond, rem)
		}
	}
	pts := all
	switch {
	case len(cond) >= outletCondSpans:
		pts, f.Basis = cond, "hour"
	case len(all) >= outletMinSpans:
		f.Basis = "all"
	default: // on battery longer than nearly every span seen: keep the most in reserve
		f.OK, f.Basis, f.P50H, f.P80H, f.Spans = true, "beyond", outletCapH, outletCapH, len(all)
		return f
	}
	f.OK, f.Spans = true, len(pts)
	f.P50H = math.Min(quantile(pts, 0.5), outletCapH)
	f.P80H = math.Min(quantile(pts, outletQuantile), outletCapH)
	return f
}

// ---- pmset log ----

var pmsetUsingRe = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}) .*\bUsing (AC|Batt|BATT)\b`)

// parsePmsetLog reads `pmset -g log` as collapsed power edges.
func parsePmsetLog(r io.Reader) ([]PowerEdge, error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	var out []PowerEdge
	for sc.Scan() {
		line := sc.Text()
		if !strings.Contains(line, "Using ") {
			continue
		}
		m := pmsetUsingRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		at, err := time.Parse("2006-01-02 15:04:05 -0700", m[1])
		if err != nil {
			continue
		}
		ac := m[2] == "AC"
		if n := len(out); n > 0 && out[n-1].AC == ac {
			continue
		}
		out = append(out, PowerEdge{At: at.UTC(), AC: ac, Src: "pmset"})
	}
	return out, sc.Err()
}

// powerLogFn opens the OS power log (`pmset -g log`); injected so tests never read the real one.
type powerLogFn func(ctx context.Context) (io.ReadCloser, error)

type cmdReader struct {
	io.ReadCloser
	cmd *exec.Cmd
}

func (c cmdReader) Close() error {
	_ = c.ReadCloser.Close()
	return c.cmd.Wait()
}

// pmsetLog streams `pmset -g log` (pinned path, argv only).
func pmsetLog(ctx context.Context) (io.ReadCloser, error) {
	cmd := exec.CommandContext(ctx, "/usr/bin/pmset", "-g", "log")
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmdReader{out, cmd}, nil
}

// energyImport merges the OS power log into the edges, at most once per pmsetImportEvery unless
// forced. A failed read still counts as the day's attempt.
func energyImport(ctx context.Context, s Store, open powerLogFn, now time.Time, force bool) error {
	if st := s.loadEnergy(); !force && !st.PmsetAt.IsZero() && now.Sub(st.PmsetAt) >= 0 && now.Sub(st.PmsetAt) < pmsetImportEvery {
		return nil
	}
	var edges []PowerEdge
	rc, err := open(ctx)
	if err == nil {
		edges, err = parsePmsetLog(rc)
		if cerr := rc.Close(); err == nil {
			err = cerr
		}
	}
	lerr := withLock(s, func() {
		st := s.loadEnergy()
		st.PmsetAt = now
		if err == nil {
			st.Edges = collapseEdges(append(st.Edges, edges...), now)
			var logs []EnergyLog
			st, logs = closeOpen(st)
			_ = s.appendEnergyLog(logs)
		}
		_ = s.saveEnergy(st)
	})
	return errors.Join(err, lerr)
}

// ---- base drain ----

// jobBusy says whether a guarded job ran at any time between a and b.
func jobBusy(runs []JobRun, a, b time.Time) bool {
	for _, r := range runs {
		end := r.At
		start := end.Add(-time.Duration(r.Secs) * time.Second)
		if start.Before(b) && end.After(a) {
			return true
		}
	}
	return false
}

// drainStretches finds closed stretches on battery in the guard history: broken by AC, a sample
// gap over historyGap (asleep), or a guarded job. The stretch still open at the newest sample and
// one starting at the history's first sample (it may be cut) are left out.
func drainStretches(hist []Sample, runs []JobRun) []DrainStretch {
	if len(hist) == 0 {
		return nil
	}
	var recentRuns []JobRun // only jobs that ended inside the history can overlap it
	for _, r := range runs {
		if r.At.After(hist[0].At) {
			recentRuns = append(recentRuns, r)
		}
	}
	runs = recentRuns
	var out []DrainStretch
	startIdx := -1
	flush := func(endIdx int) {
		if startIdx < 0 || startIdx == 0 {
			startIdx = -1
			return
		}
		a, b := hist[startIdx], hist[endIdx]
		if b.At.Sub(a.At) >= drainMinStretch && a.Batt.Pct >= b.Batt.Pct {
			out = append(out, DrainStretch{Start: a.At, End: b.At, Pct0: a.Batt.Pct, Pct1: b.Batt.Pct})
		}
		startIdx = -1
	}
	for i, x := range hist {
		onBatt := x.Batt != nil && x.Batt.Present && !x.Batt.OnAC
		busy := onBatt && jobBusy(runs, x.At.Add(-time.Second), x.At.Add(time.Second))
		gap := i > 0 && x.At.Sub(hist[i-1].At) > historyGap
		if startIdx >= 0 && (!onBatt || busy || gap) {
			flush(i - 1)
		}
		if onBatt && !busy && startIdx < 0 {
			startIdx = i
		}
	}
	return out // a stretch still open at the end is not flushed
}

// mergeStretches upserts by start, drops old ones and caps the list.
func mergeStretches(old, add []DrainStretch, now time.Time) []DrainStretch {
	by := map[int64]DrainStretch{}
	for _, s := range append(append([]DrainStretch(nil), old...), add...) {
		if now.Sub(s.End) <= drainHistory {
			by[s.Start.Unix()] = s
		}
	}
	out := make([]DrainStretch, 0, len(by))
	for _, s := range by {
		out = append(out, s)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start.Before(out[j].Start) })
	if len(out) > drainMaxStretchs {
		out = out[len(out)-drainMaxStretchs:]
	}
	return out
}

// DrainEstimate is the base drain the budget uses.
type DrainEstimate struct {
	PctH     int     `json:"pctH"`
	Measured bool    `json:"measured"`
	RawPctH  float64 `json:"raw,omitempty"`
	Hours    float64 `json:"hours"` // evidence: hours of quiet battery stretches
	N        int     `json:"n"`
}

// measuredDrain is the duration-weighted median %/h over stretches from the last drainHistory with
// no guarded job overlapping them (a job that finished after the stretch was saved still counts).
func measuredDrain(st []DrainStretch, runs []JobRun, now time.Time) DrainEstimate {
	type rw struct{ rate, h float64 }
	var pts []rw
	total := 0.0
	for _, s := range st {
		h := s.End.Sub(s.Start).Hours()
		if h <= 0 || now.Sub(s.End) > drainHistory || jobBusy(runs, s.Start, s.End) {
			continue
		}
		pts = append(pts, rw{float64(s.Pct0-s.Pct1) / h, h})
		total += h
	}
	d := DrainEstimate{PctH: eclipseBaseDrainH, Hours: round1(total), N: len(pts)}
	if total < drainMinHours {
		return d
	}
	sort.Slice(pts, func(i, j int) bool { return pts[i].rate < pts[j].rate })
	acc := 0.0
	for _, p := range pts {
		if acc += p.h; acc >= total/2 {
			d.RawPctH = round1(p.rate)
			break
		}
	}
	d.Measured = true
	d.PctH = min(max(int(math.Ceil(d.RawPctH-1e-9)), drainMinPctH), drainMaxPctH)
	return d
}

// ---- the step (pure) and the tick ----

// closeOpen scores the open prediction when an AC edge after it is known.
func closeOpen(st EnergyState) (EnergyState, []EnergyLog) {
	if st.Open == nil {
		return st, nil
	}
	for _, e := range st.Edges {
		if e.AC && e.At.After(st.Open.At) {
			l := EnergyLog{Kind: "outcome", ID: st.Open.ID, At: e.At, ActualH: round2(e.At.Sub(st.Open.At).Hours())}
			st.Open = nil
			return st, []EnergyLog{l}
		}
	}
	return st, nil
}

// energyStep folds one guard sample in: the power edge, drain stretches, and the forecast of the
// current battery span (made once, scored when AC returns).
func energyStep(st EnergyState, cur Sample, hist []Sample, runs []JobRun, now time.Time, loc *time.Location) (EnergyState, []EnergyLog) {
	b := cur.Batt
	if b == nil || !b.Present {
		return st, nil
	}
	at := cur.At
	if at.IsZero() {
		at = now
	}
	if st.LastAt.IsZero() || st.LastAC != b.OnAC {
		st.Edges = append(st.Edges, PowerEdge{At: at, AC: b.OnAC, Src: "argo"})
	}
	st.Edges = collapseEdges(st.Edges, now)
	st.LastAC, st.LastAt = b.OnAC, at
	st.Stretches = mergeStretches(st.Stretches, drainStretches(append(append([]Sample(nil), hist...), cur), runs), now)

	st, logs := closeOpen(st)
	if b.OnAC {
		return st, logs
	}
	_, open := batterySpans(collapseEdges(st.Edges, now))
	if open.IsZero() {
		open = at
	}
	if st.Open != nil && st.Open.ID != open.Unix() {
		st.Open = nil // a span whose end Argo never saw: no evidence, no score
	}
	if st.Open == nil {
		if f := forecastOutlet(st.Edges, now, loc); f.OK {
			st.Open = &OutletPrediction{ID: open.Unix(), At: now, P50H: round2(f.P50H), P80H: round2(f.P80H)}
			logs = append(logs, EnergyLog{Kind: "predict", ID: st.Open.ID, At: now, P50H: st.Open.P50H, P80H: st.Open.P80H, Spans: f.Spans, Basis: f.Basis})
		}
	}
	return st, logs
}

// energyTick runs in guardStep with the sample and the history before it.
func energyTick(s Store, cur Sample, hist []Sample, now time.Time) {
	st, logs := energyStep(s.loadEnergy(), cur, hist, s.jobRuns(), now, time.Local)
	_ = s.appendEnergyLog(logs)
	_ = s.saveEnergy(st)
}

// ---- the plan the budget uses ----

// EnergyPlan is what the eclipse budget runs on: when an outlet is expected and the base drain.
type EnergyPlan struct {
	Until    time.Time      // expected outlet; zero = none
	Src      string         // manual | predicted | ""
	DrainH   int            // %/h
	Drain    DrainEstimate  // where DrainH came from
	Forecast OutletForecast // shown even when not used
}

// manualPlan is the plan from claude-heavy's file alone, with the default drain (the old budget).
func manualPlan(until time.Time) EnergyPlan {
	p := EnergyPlan{DrainH: eclipseBaseDrainH, Drain: DrainEstimate{PctH: eclipseBaseDrainH}}
	if !until.IsZero() {
		p.Until, p.Src = until, "manual"
	}
	return p
}

// planFor: a manual plan that has not passed always wins; else, on battery, the forecast's P80.
func planFor(manual time.Time, st EnergyState, runs []JobRun, cur Sample, now time.Time, loc *time.Location) EnergyPlan {
	d := measuredDrain(st.Stretches, runs, now)
	p := EnergyPlan{DrainH: d.PctH, Drain: d, Forecast: forecastOutlet(st.Edges, now, loc)}
	switch {
	case manual.After(now):
		p.Until, p.Src = manual, "manual"
	case !onAC(cur) && p.Forecast.OK:
		p.Until, p.Src = now.Add(time.Duration(p.Forecast.P80H*float64(time.Hour))), "predicted"
	}
	return p
}

// energyPlan is planFor on this store's evidence.
func (s Store) energyPlan(manual time.Time, cur Sample) EnergyPlan {
	now := cur.At
	if now.IsZero() {
		now = time.Now()
	}
	return planFor(manual, s.loadEnergy(), s.jobRuns(), cur, now, time.Local)
}

// ---- hotspot phone battery ----
//
// On the iPhone hotspot a low phone battery ends the Mac's link too, so Argo saves power and defers
// data while it is low. The phone's battery has no reliable automatic source on the Mac today:
// macOS shows it in the Wi-Fi menu for Instant Hotspot, but no public tool reads it (UNVERIFIED that
// none exists), and the iOS Shortcut's mesh report goes to the hub, which offers devices no route to
// read it back. So the source is an interface with one implementation: a reading recorded with
// `argo energy phone <pct> [charging]` (e.g. by a Shortcut over SSH, or a future hub pull). Only a
// fresh reading counts; no reading means no hotspot-low, never a guess.
const (
	phoneLowPct = 20               // enter at or below
	phoneOKPct  = 30               // leave at or above (hysteresis)
	phoneFresh  = 30 * time.Minute // older readings are unknown
)

// PhoneBattery is one reading of the hotspot phone's battery.
type PhoneBattery struct {
	Pct      int       `json:"pct"`
	Charging bool      `json:"charging"`
	At       time.Time `json:"at"`
}

type phoneBatterySource interface {
	latest() (PhoneBattery, bool)
}

// phoneBatteryFile is phone-battery.json in Argo's state directory.
type phoneBatteryFile string

func (f phoneBatteryFile) latest() (PhoneBattery, bool) {
	var p PhoneBattery
	b, err := os.ReadFile(string(f))
	if err != nil || json.Unmarshal(b, &p) != nil || p.At.IsZero() || p.Pct < 0 || p.Pct > 100 {
		return PhoneBattery{}, false
	}
	return p, true
}

// recordPhoneBattery is `argo energy phone <pct> [charging|discharging]`. A Shortcuts fraction
// (0.18) reads as a percent, as the hub does.
func recordPhoneBattery(s Store, args []string, now time.Time) error {
	usage := errors.New("usage: argo energy phone <percent 0-100> [charging|discharging]")
	if len(args) < 1 || len(args) > 2 {
		return usage
	}
	v, err := strconv.ParseFloat(args[0], 64)
	if err != nil || math.IsNaN(v) {
		return usage
	}
	if v > 0 && v < 1 || v == 1 && strings.Contains(args[0], ".") {
		v *= 100
	}
	if v < 0 || v > 100 {
		return usage
	}
	p := PhoneBattery{Pct: int(math.Round(v)), At: now.UTC()}
	if len(args) == 2 {
		switch args[1] {
		case "charging":
			p.Charging = true
		case "discharging":
		default:
			return usage
		}
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(p)
	tmp := s.path("phone-battery.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path("phone-battery.json"))
}

// hotspotLow says whether the hotspot phone's battery calls for power-save: on the hotspot, a fresh
// reading, not charging, at or under phoneLowPct (or under phoneOKPct while already low).
func hotspotLow(p PhoneBattery, ok, onHotspot, wasLow bool, now time.Time) bool {
	if !ok || !onHotspot || p.Charging || now.Sub(p.At) > phoneFresh || p.At.After(now.Add(time.Minute)) {
		return false
	}
	if wasLow {
		return p.Pct < phoneOKPct
	}
	return p.Pct <= phoneLowPct
}

// ---- files ----

func (s Store) loadEnergy() EnergyState {
	var st EnergyState
	if b, err := os.ReadFile(s.path("energy.json")); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	if len(st.Edges) > outletMaxEdges {
		st.Edges = st.Edges[len(st.Edges)-outletMaxEdges:]
	}
	if len(st.Stretches) > drainMaxStretchs {
		st.Stretches = st.Stretches[len(st.Stretches)-drainMaxStretchs:]
	}
	return st
}

func (s Store) saveEnergy(st EnergyState) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	st.Rev = max(st.Rev, energyRev)
	b, _ := json.Marshal(st)
	tmp := s.path("energy.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path("energy.json"))
}

func (s Store) energyLogs() []EnergyLog {
	f, err := os.Open(s.path("energy.jsonl"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []EnergyLog
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var l EnergyLog
		if json.Unmarshal(sc.Bytes(), &l) == nil && l.Kind != "" {
			out = append(out, l)
		}
	}
	return out
}

// appendEnergyLog appends lines and keeps the newest energyLogKeep (the file is rewritten only
// once it has doubled).
func (s Store) appendEnergyLog(add []EnergyLog) error {
	if len(add) == 0 {
		return nil
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	if old := s.energyLogs(); len(old)+len(add) >= 2*energyLogKeep {
		all := append(old, add...)
		var buf strings.Builder
		for _, l := range all[len(all)-energyLogKeep:] {
			b, _ := json.Marshal(l)
			buf.Write(b)
			buf.WriteByte('\n')
		}
		tmp := s.path("energy.jsonl.tmp")
		if err := os.WriteFile(tmp, []byte(buf.String()), 0o600); err != nil {
			return err
		}
		return os.Rename(tmp, s.path("energy.jsonl"))
	}
	f, err := os.OpenFile(s.path("energy.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	for _, l := range add {
		b, _ := json.Marshal(l)
		if _, err := f.Write(append(b, '\n')); err != nil {
			return err
		}
	}
	return nil
}

// ---- accuracy and display ----

// OutletAccuracy scores closed forecasts: MAE of the P50 and the share that ended within the P80.
type OutletAccuracy struct {
	N        int
	MAEH     float64
	Coverage float64
}

func outletAccuracy(logs []EnergyLog) OutletAccuracy {
	pred := map[int64]EnergyLog{}
	var a OutletAccuracy
	var errSum float64
	covered := 0
	for _, l := range logs {
		switch l.Kind {
		case "predict":
			pred[l.ID] = l
		case "outcome":
			p, ok := pred[l.ID]
			if !ok {
				continue
			}
			delete(pred, l.ID)
			a.N++
			errSum += math.Abs(l.ActualH - p.P50H)
			if l.ActualH <= p.P80H {
				covered++
			}
		}
	}
	if a.N > 0 {
		a.MAEH = errSum / float64(a.N)
		a.Coverage = float64(covered) / float64(a.N)
	}
	return a
}

// energyPlanLine is `argo energy plan`: "<hours> <drain %/h> <source>", for claude-heavy.
func energyPlanLine(p EnergyPlan, now time.Time) string {
	src := p.Src
	if src == "" {
		src = "none"
	}
	return fmt.Sprintf("%d %d %s", planHours(p.Until, now), p.DrainH, src)
}

func energyStatusText(p EnergyPlan, st EnergyState, logs []EnergyLog, ph PhoneBattery, phOK bool, now time.Time) string {
	var b strings.Builder
	f := p.Forecast
	switch {
	case !f.OK:
		fmt.Fprintf(&b, "outlet forecast: none yet (%d battery spans known, needs %d)\n", f.History, outletMinSpans)
	case f.Basis == "beyond":
		fmt.Fprintf(&b, "outlet forecast: %.0f h cap: on battery %.1f h, longer than all but %d of %d battery spans seen\n", outletCapH, f.ElapsedH, f.Spans, f.History)
	default:
		basis := map[string]string{"hour": fmt.Sprintf("this time of day +-%d h", outletHourWindow), "all": "all hours"}[f.Basis]
		fmt.Fprintf(&b, "outlet forecast: P80 %.1f h, P50 %.1f h (%d of %d battery spans, %s; on battery %.1f h)\n", f.P80H, f.P50H, f.Spans, f.History, basis, f.ElapsedH)
	}
	switch p.Src {
	case "manual":
		fmt.Fprintf(&b, "plan in use: manual (claude-heavy --unplugged): %d h left\n", planHours(p.Until, now))
	case "predicted":
		fmt.Fprintf(&b, "plan in use: predicted: %d h to an outlet\n", planHours(p.Until, now))
	default:
		b.WriteString("plan in use: none (on AC, or no forecast and no manual plan)\n")
	}
	d := p.Drain
	if d.Measured {
		fmt.Fprintf(&b, "base drain: %d %%/h measured (median %.1f over %d quiet battery stretches, %.1f h)\n", d.PctH, d.RawPctH, d.N, d.Hours)
	} else {
		fmt.Fprintf(&b, "base drain: %d %%/h (default until %.0f h of quiet battery stretches; %.1f h so far)\n", d.PctH, drainMinHours, d.Hours)
	}
	a := outletAccuracy(logs)
	if a.N == 0 {
		b.WriteString("forecast accuracy: no scored spans yet\n")
	} else {
		fmt.Fprintf(&b, "forecast accuracy: %d scored: MAE %.1f h (P50), %.0f%% ended within the P80\n", a.N, a.MAEH, a.Coverage*100)
	}
	if a.N < mlMinOutcomes {
		fmt.Fprintf(&b, "  (a learned model is worth trying only after %d scored spans that it beats)\n", mlMinOutcomes)
	}
	switch {
	case !phOK:
		b.WriteString("phone battery: unknown (record it with `argo energy phone <pct>`)\n")
	default:
		state := "discharging"
		if ph.Charging {
			state = "charging"
		}
		age := now.Sub(ph.At).Round(time.Minute)
		fresh := ""
		if age > phoneFresh {
			fresh = ", stale: not used"
		}
		fmt.Fprintf(&b, "phone battery: %d%% %s (%s ago%s)\n", ph.Pct, state, age, fresh)
	}
	if !st.PmsetAt.IsZero() {
		fmt.Fprintf(&b, "power log read: %s\n", st.PmsetAt.Local().Format("2 Jan 15:04"))
	}
	return b.String()
}

// ---- build age (24 Nov: the installed Argo lacked power-save, and nothing said so) ----

// energyRev is the energy code's revision. energy.json keeps the highest that wrote it, so an older
// binary (the installed one, while a newer one has run) can say it is behind.
const energyRev = 1

func readBuildInfo() (*debug.BuildInfo, bool) { return debug.ReadBuildInfo() }

// doctorBuild is the `argo doctor` line on this binary: its VCS revision and time, and whether a
// newer energy code has written its state. Advice only: reinstalling is Josh's, at the Mac.
func doctorBuild(bi *debug.BuildInfo, ok bool, st EnergyState) string {
	rev, at, dirty := "", "", false
	if ok && bi != nil {
		for _, kv := range bi.Settings {
			switch kv.Key {
			case "vcs.revision":
				rev = kv.Value
			case "vcs.time":
				at = kv.Value
			case "vcs.modified":
				dirty = kv.Value == "true"
			}
		}
	}
	var b strings.Builder
	if rev == "" {
		b.WriteString("\nargo build: no VCS revision recorded, so its age can't be told\n")
	} else {
		if len(rev) > 12 {
			rev = rev[:12]
		}
		fmt.Fprintf(&b, "\nargo build: %s (%s)", rev, at)
		if dirty {
			b.WriteString(", built with uncommitted changes")
		}
		b.WriteString("\n")
	}
	if st.Rev > energyRev {
		fmt.Fprintf(&b, "  WARN: this argo is older than the energy code that last wrote its state (rev %d > %d): reinstall it at the Mac (a rebuild resets the Messages and Full Disk Access grants)\n", st.Rev, energyRev)
	}
	return b.String()
}

const energyUsage = `usage:
  argo energy                    outlet forecast, base drain, the plan in use, its accuracy, phone battery
  argo energy plan               one line for scripts: "<hours to an outlet> <drain %/h> <manual|predicted|none>"
  argo energy phone <pct> [charging|discharging]
                                 record the hotspot phone's battery (used for 30 min)
  argo energy import             read macOS's power log now (normally once a day)`

// energyCmd is `argo energy`. cur is a fresh sample; planFile is claude-heavy's plan.
func energyCmd(ctx context.Context, args []string, s Store, cur Sample, planFile string, open powerLogFn, now time.Time, out io.Writer) error {
	sub := ""
	if len(args) > 0 {
		sub = args[0]
	}
	if cur.At.IsZero() {
		cur.At = now
	}
	plan := func() EnergyPlan {
		return planFor(readPlan(planFile), s.loadEnergy(), s.jobRuns(), cur, now, time.Local)
	}
	switch sub {
	case "":
		ph, ok := phoneBatteryFile(s.path("phone-battery.json")).latest()
		_, err := io.WriteString(out, energyStatusText(plan(), s.loadEnergy(), s.energyLogs(), ph, ok, now))
		return err
	case "plan":
		_, err := fmt.Fprintln(out, energyPlanLine(plan(), now))
		return err
	case "phone":
		if err := recordPhoneBattery(s, args[1:], now); err != nil {
			return err
		}
		ph, _ := phoneBatteryFile(s.path("phone-battery.json")).latest()
		state := "discharging"
		if ph.Charging {
			state = "charging"
		}
		_, err := fmt.Fprintf(out, "phone battery: %d%% %s\n", ph.Pct, state)
		return err
	case "import":
		if open == nil {
			return errors.New("argo energy import: no power log on this system")
		}
		if err := energyImport(ctx, s, open, now, true); err != nil {
			return err
		}
		st := s.loadEnergy()
		spans, _ := batterySpans(collapseEdges(st.Edges, now))
		_, err := fmt.Fprintf(out, "power log read: %d edges, %d battery spans\n", len(st.Edges), len(spans))
		return err
	}
	return errors.New(energyUsage)
}
