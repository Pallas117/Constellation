package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"testing"
	"time"
)

var enT0 = time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)

// edgesFor builds power edges from battery spans given as (start hour after enT0, length in hours).
func edgesFor(spans ...[2]float64) []PowerEdge {
	var e []PowerEdge
	for _, s := range spans {
		at := enT0.Add(time.Duration(s[0] * float64(time.Hour)))
		e = append(e, PowerEdge{At: at, AC: false}, PowerEdge{At: at.Add(time.Duration(s[1] * float64(time.Hour))), AC: true})
	}
	return e
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func TestParsePmsetLog(t *testing.T) {
	log := strings.Join([]string{
		"Time stamp                Domain              Message",
		"2026-11-17 20:09:35 +0800 Assertions          \tSummary- [System: PrevIdle] Using AC(Charge: 52)          ",
		"2026-11-17 21:11:27 +0800 Assertions          \tSummary- [System: PrevIdle] Using AC(Charge: 61)          ",
		"2026-11-17 22:41:53 +0800 Assertions          \tSummary- [System: PrevIdle DeclUser kDisp] Using Batt(Charge: 73)          ",
		"2026-11-19 05:42:53 +0800 DarkWake            \tDarkWake from Deep Idle [CDNP] : due to smc Using BATT (Charge:40%) 10 secs   ",
		"2026-11-19 07:00:00 +0800 Sleep               \tEntering Sleep state Using AC (Charge:41%) 30 secs",
		"garbage Using AC",
		"2026-11-19 07:01:00 +0800 Wake                \tno power source here",
	}, "\n")
	got, err := parsePmsetLog(strings.NewReader(log))
	if err != nil {
		t.Fatal(err)
	}
	want := []PowerEdge{
		{At: time.Date(2026, 11, 17, 12, 9, 35, 0, time.UTC), AC: true, Src: "pmset"},
		{At: time.Date(2026, 11, 17, 14, 41, 53, 0, time.UTC), AC: false, Src: "pmset"},
		{At: time.Date(2026, 11, 18, 23, 0, 0, 0, time.UTC), AC: true, Src: "pmset"},
	}
	if len(got) != len(want) {
		t.Fatalf("edges %+v", got)
	}
	for i := range want {
		if !got[i].At.Equal(want[i].At) || got[i].AC != want[i].AC || got[i].Src != "pmset" {
			t.Errorf("edge %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestBatterySpansDebounce(t *testing.T) {
	e := edgesFor([2]float64{1, 2}, [2]float64{3.05, 1}, [2]float64{10, 0.05})
	// a 3 min AC flap between 3 h and 3.05 h is a loose cable: one span 1 h-4.05 h; the 3 min span at 10 h is dropped
	spans, open := batterySpans(e)
	if len(spans) != 1 || !open.IsZero() {
		t.Fatalf("spans %+v open %v", spans, open)
	}
	if got := spans[0].end.Sub(spans[0].start); got != time.Duration(3.05*float64(time.Hour)) {
		t.Errorf("merged span %v", got)
	}
	// An open span (on battery now) right after a short AC flap continues the previous one.
	e = append(edgesFor([2]float64{1, 2}), PowerEdge{At: enT0.Add(3*time.Hour + 2*time.Minute), AC: false})
	spans, open = batterySpans(e)
	if len(spans) != 0 || !open.Equal(enT0.Add(time.Hour)) {
		t.Errorf("open span should continue from 1 h: spans %+v open %v", spans, open)
	}
}

func TestForecastOutlet(t *testing.T) {
	// Too little history: no forecast, so nothing changes.
	if f := forecastOutlet(edgesFor([2]float64{0, 2}, [2]float64{24, 3}), enT0.Add(72*time.Hour), time.UTC); f.OK || f.History != 2 {
		t.Fatalf("2 spans: %+v", f)
	}
	// Five evening spans (start 20:00, 2-6 h) and three morning ones (09:00, 1 h).
	var sp [][2]float64
	for i, h := range []float64{2, 3, 4, 5, 6} {
		sp = append(sp, [2]float64{float64(24*i) + 20, h})
	}
	for i := 0; i < 3; i++ {
		sp = append(sp, [2]float64{float64(24*i) + 9, 1})
	}
	e := edgesFor(sp...)
	// Unplugged at 20:00 on day 6: conditioned on the evening.
	e = append(e, PowerEdge{At: enT0.Add(6*24*time.Hour + 20*time.Hour), AC: false})
	now := enT0.Add(6*24*time.Hour + 20*time.Hour)
	f := forecastOutlet(e, now, time.UTC)
	if !f.OK || f.Basis != "hour" || f.Spans != 5 || !near(f.P80H, 5) || !near(f.P50H, 4) || f.PlanH != outletCapH {
		t.Fatalf("evening forecast %+v (P80 uncapped, the plan capped at 2 h)", f)
	}
	if outletCapH != 2 {
		t.Fatalf("Josh, 24 Nov: the predicted plan is capped at 2 h, got %v", outletCapH)
	}
	// Two hours in, only spans longer than 2 h count, at what was left after their own 2 h (1,2,3,4).
	f = forecastOutlet(e, now.Add(2*time.Hour), time.UTC)
	if !f.OK || f.Spans != 4 || !near(f.P80H, 4) || !near(f.ElapsedH, 2) {
		t.Fatalf("2 h in: %+v", f)
	}
	// At 09:00 (on AC: "if unplugged now") the morning has only 3 spans: all spans, P80 of {1,1,1,2,3,4,5,6}.
	f = forecastOutlet(e[:len(e)-1], enT0.Add(6*24*time.Hour+9*time.Hour), time.UTC)
	if !f.OK || f.Basis != "all" || f.Spans != 8 || !near(f.P80H, 5) {
		t.Fatalf("morning forecast %+v", f)
	}
	// Seven hours in: longer than every span seen: the plan is the cap, with no P80 to score.
	f = forecastOutlet(e, now.Add(7*time.Hour), time.UTC)
	if !f.OK || f.Basis != "beyond" || f.PlanH != outletCapH || f.P80H != 0 {
		t.Fatalf("beyond history %+v", f)
	}
	// A short forecast is not raised to the cap.
	short := edgesFor([2]float64{0, 1}, [2]float64{30, 1}, [2]float64{60, 1.5})
	if f = forecastOutlet(short, enT0.Add(100*time.Hour), time.UTC); !near(f.P80H, 1.5) || !near(f.PlanH, 1.5) {
		t.Errorf("short: %+v", f)
	}
	// 20 h spans: the P80 stays 20 h (logged for scoring), the plan is capped at 2 h.
	long := edgesFor([2]float64{0, 20}, [2]float64{30, 20}, [2]float64{60, 20})
	if f = forecastOutlet(long, enT0.Add(100*time.Hour), time.UTC); f.P80H != 20 || f.P50H != 20 || f.PlanH != outletCapH {
		t.Errorf("cap: %+v", f)
	}
}

func TestQuantileNearestRank(t *testing.T) {
	v := []float64{5, 1, 4, 2, 3}
	if q := quantile(v, 0.8); q != 4 {
		t.Errorf("P80 = %v", q)
	}
	if q := quantile(v, 0.5); q != 3 {
		t.Errorf("P50 = %v", q)
	}
	if q := quantile(nil, 0.8); q != 0 {
		t.Errorf("empty = %v", q)
	}
	if v[0] != 5 {
		t.Error("quantile sorted its input in place")
	}
}

// enSample is a battery reading at minute m after enT0.
func enSample(m int, pct int, ac bool) Sample {
	return Sample{At: enT0.Add(time.Duration(m) * time.Minute), Batt: &Battery{Present: true, Pct: pct, OnAC: ac}}
}

func TestDrainStretchesSkipJobsAndGaps(t *testing.T) {
	var hist []Sample
	hist = append(hist, enSample(0, 90, true)) // on AC first: the stretch after it starts cleanly
	pct := 90
	for m := 1; m <= 120; m++ { // 2 h on battery at 5 %/h, sampled each minute
		if m%12 == 0 {
			pct--
		}
		hist = append(hist, enSample(m, pct, false))
	}
	hist = append(hist, enSample(121, pct, true)) // back on AC: the stretch is closed
	got := drainStretches(hist, nil)
	if len(got) != 1 || got[0].Pct0 != 90 || got[0].Pct1 != 80 {
		t.Fatalf("stretches %+v", got)
	}
	// A guarded job from minute 50 to 70 splits it: 1-49 (49 min) and 71-120 (50 min).
	job := JobRun{At: enT0.Add(70 * time.Minute), Secs: 20 * 60, Name: "gates"}
	if got = drainStretches(hist, []JobRun{job}); len(got) != 2 {
		t.Fatalf("job split: %+v", got)
	}
	// A sleep gap over historyGap also splits; the 10 min piece after it is too short to count.
	gap := append([]Sample{}, hist[:61]...)
	for m := 90; m <= 100; m++ {
		gap = append(gap, enSample(m, 85, false))
	}
	gap = append(gap, enSample(101, 85, true))
	if got = drainStretches(gap, nil); len(got) != 1 || got[0].End.Sub(got[0].Start) != 59*time.Minute {
		t.Fatalf("gap split: %+v", got)
	}
	// The still-open stretch (no AC after it) and one that starts at the history's first sample are not kept.
	if got = drainStretches(hist[1:121], nil); len(got) != 0 {
		t.Errorf("open or truncated stretch kept: %+v", got)
	}
}

func TestMeasuredDrain(t *testing.T) {
	now := enT0.Add(48 * time.Hour)
	mk := func(startH float64, hours float64, drop int) DrainStretch {
		s := enT0.Add(time.Duration(startH * float64(time.Hour)))
		return DrainStretch{Start: s, End: s.Add(time.Duration(hours * float64(time.Hour))), Pct0: 80, Pct1: 80 - drop}
	}
	// Under 3 h of evidence: the 6 %/h default.
	d := measuredDrain([]DrainStretch{mk(1, 1, 4), mk(5, 1, 4)}, nil, now)
	if d.Measured || d.PctH != eclipseBaseDrainH {
		t.Fatalf("2 h of evidence: %+v", d)
	}
	// 4 h: 1 h at 4 %/h, 2 h at 4.5 %/h, 1 h at 10 %/h: the weighted median is 4.5, rounded up to 5.
	d = measuredDrain([]DrainStretch{mk(1, 1, 4), mk(5, 2, 9), mk(9, 1, 10)}, nil, now)
	if !d.Measured || d.PctH != 5 || d.N != 3 || !near(d.Hours, 4) {
		t.Fatalf("measured: %+v", d)
	}
	// A job that finished later and overlaps a stretch removes it; old stretches age out.
	job := JobRun{At: enT0.Add(6 * time.Hour), Secs: 600, Name: "gates"}
	if d = measuredDrain([]DrainStretch{mk(1, 1, 4), mk(5, 2, 9), mk(9, 1, 10)}, []JobRun{job}, now); d.Measured {
		t.Errorf("overlapping job not excluded: %+v", d)
	}
	if d = measuredDrain([]DrainStretch{mk(1, 4, 16)}, nil, enT0.Add(20*24*time.Hour)); d.Measured {
		t.Errorf("a 20-day-old stretch still counts: %+v", d)
	}
	// Clamped to a sane range: a sleeping Mac (0.2 %/h) or a runaway one (40 %/h).
	if d = measuredDrain([]DrainStretch{mk(1, 4, 1)}, nil, now); d.PctH != drainMinPctH {
		t.Errorf("low clamp: %+v", d)
	}
	if d = measuredDrain([]DrainStretch{mk(1, 4, 79)}, nil, now); d.PctH != drainMaxPctH {
		t.Errorf("high clamp: %+v", d)
	}
}

func TestEnergyStepPredictsAndScores(t *testing.T) {
	var st EnergyState
	st.Edges = edgesFor([2]float64{0, 2}, [2]float64{24, 3}, [2]float64{48, 4}) // P80 of {2,3,4} = 4 h
	at := enT0.Add(72 * time.Hour)
	// Still on AC: no prediction.
	st, logs := energyStep(st, enSample(72*60, 90, true), nil, nil, at, time.UTC)
	if st.Open != nil || len(logs) != 0 {
		t.Fatalf("on AC: open %+v logs %+v", st.Open, logs)
	}
	// Unplugged: one prediction, logged once.
	st, logs = energyStep(st, enSample(72*60+1, 90, false), nil, nil, at.Add(time.Minute), time.UTC)
	// The log keeps the uncapped P80 (4 h) for scoring beside the 2 h plan the budget used.
	if st.Open == nil || len(logs) != 1 || logs[0].Kind != "predict" || !near(logs[0].P80H, 4) || !near(logs[0].PlanH, 2) || logs[0].Basis != "all" {
		t.Fatalf("unplugged: open %+v logs %+v", st.Open, logs)
	}
	if st, logs = energyStep(st, enSample(72*60+2, 89, false), nil, nil, at.Add(2*time.Minute), time.UTC); len(logs) != 0 {
		t.Fatalf("predicted twice: %+v", logs)
	}
	// AC after 3 h: the outcome is scored against the prediction.
	back := at.Add(time.Minute + 3*time.Hour)
	st, logs = energyStep(st, Sample{At: back, Batt: &Battery{Present: true, Pct: 70, OnAC: true}}, nil, nil, back, time.UTC)
	if st.Open != nil || len(logs) != 1 || logs[0].Kind != "outcome" || !near(logs[0].ActualH, 3) {
		t.Fatalf("outcome: open %+v logs %+v", st.Open, logs)
	}
	if n := len(st.Edges); n != 8 || st.Edges[n-1].Src != "argo" {
		t.Errorf("edges not recorded: %+v", st.Edges)
	}
	// No battery (a desktop): nothing at all.
	st2, logs := energyStep(EnergyState{}, Sample{At: back}, nil, nil, back, time.UTC)
	if len(st2.Edges) != 0 || len(logs) != 0 {
		t.Errorf("desktop: %+v %+v", st2, logs)
	}
}

func TestOutletAccuracy(t *testing.T) {
	logs := []EnergyLog{
		{Kind: "predict", ID: 1, P50H: 2, P80H: 4, PlanH: 2},
		{Kind: "outcome", ID: 1, ActualH: 3},
		{Kind: "predict", ID: 2, P50H: 1, P80H: 2, PlanH: 2},
		{Kind: "outcome", ID: 2, ActualH: 5},
		{Kind: "predict", ID: 4, PlanH: 2, Basis: "beyond"}, // no P80: plan scored, forecast not
		{Kind: "outcome", ID: 4, ActualH: 1},
		{Kind: "predict", ID: 3, P50H: 1, P80H: 2}, // still open
		{Kind: "outcome", ID: 9, ActualH: 1},       // no prediction: ignored
	}
	a := outletAccuracy(logs)
	if a.N != 2 || !near(a.MAEH, 2.5) || !near(a.Coverage, 0.5) || a.PlanN != 3 || !near(a.PlanCoverage, 1.0/3) {
		t.Fatalf("accuracy %+v", a)
	}
	if a = outletAccuracy(nil); a.N != 0 {
		t.Errorf("empty: %+v", a)
	}
}

func TestEnergyPlanManualWins(t *testing.T) {
	st := EnergyState{Edges: edgesFor([2]float64{0, 2}, [2]float64{24, 3}, [2]float64{48, 4})}
	now := enT0.Add(72 * time.Hour)
	batt := enSample(72*60, 70, false)
	p := planFor(time.Time{}, st, nil, batt, now, time.UTC)
	if p.Src != "predicted" || !p.Until.Equal(now.Add(2*time.Hour)) || p.DrainH != eclipseBaseDrainH || !near(p.Forecast.P80H, 4) {
		t.Fatalf("predicted plan %+v", p)
	}
	manual := now.Add(10 * time.Hour)
	if p = planFor(manual, st, nil, batt, now, time.UTC); p.Src != "manual" || !p.Until.Equal(manual) {
		t.Fatalf("a manual plan must win: %+v", p)
	}
	// On AC the forecast is shown but not used.
	if p = planFor(time.Time{}, st, nil, enSample(72*60, 70, true), now, time.UTC); p.Src != "" || !p.Until.IsZero() || !p.Forecast.OK {
		t.Fatalf("on AC: %+v", p)
	}
	// The budget: 30 reserve + 8 default cost + 2 h (P80 4 h, capped) x 6 %/h = 50.
	e := eclipseWith(batt, nil, "gates", planFor(time.Time{}, st, nil, batt, now, time.UTC))
	if e.Need != 50 || !strings.Contains(e.why(), "2 h to an outlet (predicted)") {
		t.Errorf("predicted budget %d: %s", e.Need, e.why())
	}
	// The old wrapper still reads as before for a manual plan.
	if e := eclipseFor(batt, nil, "gates", now.Add(2*time.Hour)); e.Need != 50 || !strings.Contains(e.why(), "2 h unplugged x 6%/h") {
		t.Errorf("manual budget %d: %s", e.Need, e.why())
	}
	// The 2 h cap is for the forecast only: a manual 10 h plan keeps all 10 h (30 + 8 + 60).
	if e := eclipseWith(batt, nil, "gates", planFor(manual, st, nil, batt, now, time.UTC)); e.Need != 98 || e.PlanH != 10 {
		t.Errorf("manual 10 h budget %d (%d h): %s", e.Need, e.PlanH, e.why())
	}
}

func TestEnergyStoreRoundTripAndLogCap(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	st := EnergyState{Edges: edgesFor([2]float64{0, 2}), PmsetAt: enT0}
	if err := s.saveEnergy(st); err != nil {
		t.Fatal(err)
	}
	if got := s.loadEnergy(); len(got.Edges) != 2 || !got.PmsetAt.Equal(enT0) {
		t.Fatalf("round trip %+v", got)
	}
	if fi, _ := os.Stat(s.path("energy.json")); fi.Mode().Perm() != 0o600 {
		t.Errorf("energy.json mode %v", fi.Mode())
	}
	// Appends in batches of 10; the file is cut back to the newest energyLogKeep once it doubles.
	n := 2*energyLogKeep + 10
	for i := 0; i < n; i += 10 {
		var batch []EnergyLog
		for j := i; j < i+10; j++ {
			batch = append(batch, EnergyLog{Kind: "predict", ID: int64(j)})
		}
		if err := s.appendEnergyLog(batch); err != nil {
			t.Fatal(err)
		}
	}
	logs := s.energyLogs()
	if len(logs) > energyLogKeep+10 || logs[len(logs)-1].ID != int64(n-1) {
		t.Errorf("log kept %d lines, last %+v", len(logs), logs[len(logs)-1])
	}
	if fi, _ := os.Stat(s.path("energy.jsonl")); fi.Mode().Perm() != 0o600 {
		t.Errorf("energy.jsonl mode %v", fi.Mode())
	}
}

func TestCollapseEdgesCapsAndAges(t *testing.T) {
	var e []PowerEdge
	for i := 0; i < 2*outletMaxEdges; i++ {
		e = append(e, PowerEdge{At: enT0.Add(time.Duration(i) * time.Minute), AC: i%2 == 0})
	}
	e = append(e, PowerEdge{At: enT0.Add(-40 * 24 * time.Hour), AC: true}) // older than the window
	e = append(e, PowerEdge{At: enT0.Add(3 * time.Minute), AC: false})     // a duplicate observation
	got := collapseEdges(e, enT0.Add(24*time.Hour))
	if len(got) > outletMaxEdges {
		t.Errorf("kept %d edges", len(got))
	}
	for i := 1; i < len(got); i++ {
		if got[i].AC == got[i-1].AC || got[i].At.Before(got[i-1].At) {
			t.Fatalf("not collapsed at %d: %+v %+v", i, got[i-1], got[i])
		}
	}
}

type fakeLog struct {
	body string
	err  error
	n    int
}

func (f *fakeLog) open(context.Context) (io.ReadCloser, error) {
	f.n++
	if f.err != nil {
		return nil, f.err
	}
	return io.NopCloser(strings.NewReader(f.body)), nil
}

func TestEnergyImportOncePerDay(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	body := "2026-11-17 20:09:35 +0800 Assertions \tSummary- Using AC(Charge: 52)\n" +
		"2026-11-17 22:41:53 +0800 Assertions \tSummary- Using Batt(Charge: 73)\n" +
		"2026-11-18 01:00:00 +0800 Assertions \tSummary- Using AC(Charge: 50)\n"
	src := &fakeLog{body: body}
	now := time.Date(2026, 11, 18, 2, 0, 0, 0, time.UTC)
	if err := energyImport(context.Background(), s, src.open, now, false, storeLock(s)); err != nil {
		t.Fatal(err)
	}
	if got := s.loadEnergy(); len(got.Edges) != 3 || !got.PmsetAt.Equal(now) {
		t.Fatalf("import: %+v", got)
	}
	_ = energyImport(context.Background(), s, src.open, now.Add(time.Hour), false, storeLock(s))
	if src.n != 1 {
		t.Errorf("imported again within a day: %d reads", src.n)
	}
	// A failure is an attempt too (no retry every minute), and forced runs ignore the day.
	bad := &fakeLog{err: errors.New("no pmset")}
	if err := energyImport(context.Background(), s, bad.open, now.Add(25*time.Hour), false, storeLock(s)); err == nil {
		t.Error("error not returned")
	}
	if got := s.loadEnergy(); !got.PmsetAt.Equal(now.Add(25 * time.Hour)) {
		t.Errorf("failed attempt not recorded: %v", got.PmsetAt)
	}
	if err := energyImport(context.Background(), s, src.open, now.Add(25*time.Hour+time.Minute), true, storeLock(s)); err != nil || src.n != 2 {
		t.Errorf("forced import: %v, %d reads", err, src.n)
	}
}

// The tick holds the (non-re-entrant) store lock for its whole run: the import must merge under it
// with heldLock, where taking the lock again would fail and lose the day's import.
func TestEnergyImportUnderTickLock(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	unlock, err := s.Lock()
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	src := &fakeLog{body: "2026-11-17 22:41:53 +0800 Assertions \tSummary- Using Batt(Charge: 73)\n"}
	now := time.Date(2026, 11, 18, 2, 0, 0, 0, time.UTC)
	if err := energyImport(context.Background(), s, src.open, now, false, storeLock(s)); err == nil {
		t.Fatal("taking the held lock again should fail (that is why the tick passes heldLock)")
	}
	if err := energyImport(context.Background(), s, src.open, now, true, heldLock); err != nil {
		t.Fatal(err)
	}
	if got := s.loadEnergy(); len(got.Edges) != 1 || !got.PmsetAt.Equal(now) {
		t.Errorf("import under the tick's lock: %+v", got)
	}
}

func TestPhoneBatteryAndHotspotLow(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	src := phoneBatteryFile(s.path("phone-battery.json"))
	if _, ok := src.latest(); ok {
		t.Fatal("no file: should be unknown")
	}
	for _, bad := range [][]string{{}, {"101"}, {"-1"}, {"x"}, {"40", "maybe"}} {
		if err := recordPhoneBattery(s, bad, enT0); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	if err := recordPhoneBattery(s, []string{"0.18"}, enT0); err != nil { // a Shortcuts fraction
		t.Fatal(err)
	}
	ph, ok := src.latest()
	if !ok || ph.Pct != 18 || ph.Charging || !ph.At.Equal(enT0) {
		t.Fatalf("read back %+v %v", ph, ok)
	}
	if fi, _ := os.Stat(s.path("phone-battery.json")); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", fi.Mode())
	}
	cases := []struct {
		name               string
		pct                int
		charging, hot, was bool
		age                time.Duration
		want               bool
	}{
		{"low on the hotspot", 18, false, true, false, time.Minute, true},
		{"low, not on the hotspot", 18, false, false, false, time.Minute, false},
		{"low but charging", 18, true, true, false, time.Minute, false},
		{"stale reading is unknown", 18, false, true, false, 31 * time.Minute, false},
		{"25%: not yet", 25, false, true, false, time.Minute, false},
		{"25% while low: stays low (hysteresis)", 25, false, true, true, time.Minute, true},
		{"30% while low: recovered", 30, false, true, true, time.Minute, false},
	}
	for _, c := range cases {
		ph := PhoneBattery{Pct: c.pct, Charging: c.charging, At: enT0}
		if got := hotspotLow(ph, true, c.hot, c.was, enT0.Add(c.age)); got != c.want {
			t.Errorf("%s: %v", c.name, got)
		}
	}
	if hotspotLow(PhoneBattery{}, false, true, false, enT0) {
		t.Error("unknown phone battery must not enter power-save")
	}
}

func TestPowerSaveHotspotLow(t *testing.T) {
	good := psBatt(true, &Adapter{Volts: 20, Watts: 30}, 30, 6)
	p, ch := powerSaveStepWith(PowerSave{}, good, true, psT0)
	if ch != "entered" || p.Reason != PSHotspotLow || !dataDeferred(p) {
		t.Fatalf("hotspot-low: %+v %q", p, ch)
	}
	// Hotspot recovered but the Mac is on battery: still on, for the battery.
	batt := psBatt(false, nil, 0, 6)
	if p, ch = powerSaveStepWith(p, batt, false, psT0.Add(time.Minute)); ch != "" || p.Reason != PSBattery || dataDeferred(p) {
		t.Fatalf("back to battery: %+v %q", p, ch)
	}
	if !strings.Contains(powerSaveText(PowerSave{On: true, Reason: PSHotspotLow}, good), "hotspot") {
		t.Error("text does not name the hotspot")
	}
	// The tick texts once on the switch to hotspot-low, under its own key.
	s := Store{Dir: t.TempDir()}
	var sent []string
	phone := testPhone(t, func(_, msg string) error { sent = append(sent, msg); return nil })
	f := &fakeApps{ps: ""}
	var log bytes.Buffer
	powerSaveTickWith(context.Background(), s, f.fx(), phone, batt, false, psT0, &log)
	powerSaveTickWith(context.Background(), s, f.fx(), phone, batt, true, psT0.Add(time.Minute), &log)
	powerSaveTickWith(context.Background(), s, f.fx(), phone, batt, true, psT0.Add(2*time.Minute), &log)
	hot := 0
	for _, m := range sent {
		if strings.Contains(m, "hotspot") {
			hot++
		}
	}
	if hot != 1 {
		t.Errorf("hotspot texts: %d (%q)", hot, sent)
	}
}

func TestEnergyStatusText(t *testing.T) {
	st := EnergyState{Edges: edgesFor([2]float64{0, 2}, [2]float64{24, 3}, [2]float64{48, 4})}
	now := enT0.Add(72 * time.Hour)
	p := planFor(time.Time{}, st, nil, enSample(72*60, 70, false), now, time.UTC)
	out := energyStatusText(p, st, []EnergyLog{{Kind: "predict", ID: 1, P50H: 2, P80H: 4, PlanH: 2}, {Kind: "outcome", ID: 1, ActualH: 3}}, PhoneBattery{}, false, now)
	for _, want := range []string{"outlet forecast", "P80 4.0 h", "plan 2.0 h (capped at 2 h)", "3 battery spans", "2 h to an outlet (forecast capped at 2 h)",
		"6 %/h (default", "1 scored", "0% of 1 spans ended within the plan", "phone battery: unknown"} {
		if !strings.Contains(out, want) {
			t.Errorf("status lacks %q:\n%s", want, out)
		}
	}
	line := energyPlanLine(p, now)
	if line != "2 6 predicted" {
		t.Errorf("plan line %q", line)
	}
	if l := energyPlanLine(EnergyPlan{DrainH: 6}, now); l != "0 6 none" {
		t.Errorf("no plan line %q", l)
	}
}

// TestReplayPowerLog measures the forecaster on a real `pmset -g log` dump, walk-forward: each battery
// span is forecast at its start from the spans before it only. Opt-in (it never reads the real log by
// default): ARGO_REPLAY_PMSET=<file> go test -run TestReplayPowerLog -v . Prints aggregates only.
func TestReplayPowerLog(t *testing.T) {
	path := os.Getenv("ARGO_REPLAY_PMSET")
	if path == "" {
		t.Skip("set ARGO_REPLAY_PMSET to a pmset -g log dump")
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	edges, err := parsePmsetLog(f)
	if err != nil || len(edges) == 0 {
		t.Fatal(err, len(edges))
	}
	last := edges[len(edges)-1].At
	spans, _ := batterySpans(collapseEdges(edges, last))
	var logs []EnergyLog
	byBasis := map[string]int{}
	for i, sp := range spans {
		var before []PowerEdge
		for _, e := range edges {
			if e.At.Before(sp.start) {
				before = append(before, e)
			}
		}
		before = append(before, PowerEdge{At: sp.start, AC: false})
		fc := forecastOutlet(before, sp.start, time.Local)
		if !fc.OK {
			continue
		}
		byBasis[fc.Basis]++
		logs = append(logs, EnergyLog{Kind: "predict", ID: int64(i), P50H: fc.P50H, P80H: fc.P80H, PlanH: fc.PlanH, Basis: fc.Basis},
			EnergyLog{Kind: "outcome", ID: int64(i), ActualH: sp.end.Sub(sp.start).Hours()})
	}
	var lens []float64
	for _, sp := range spans {
		lens = append(lens, sp.end.Sub(sp.start).Hours())
	}
	a := outletAccuracy(logs)
	t.Logf("edges %d, battery spans %d (median %.2f h, P80 %.2f h, max %.2f h), %s to %s",
		len(edges), len(spans), quantile(lens, 0.5), quantile(lens, 0.8), quantile(lens, 1), edges[0].At.Format(time.DateOnly), last.Format(time.DateOnly))
	t.Logf("walk-forward: %d forecasts scored (%v): MAE %.2f h (P50), %.0f%% ended within the P80; %.0f%% of %d within the %.0f h plan",
		a.N, byBasis, a.MAEH, a.Coverage*100, a.PlanCoverage*100, a.PlanN, outletCapH)
	if at, err := time.Parse(time.RFC3339, os.Getenv("ARGO_REPLAY_AT")); err == nil {
		fc := forecastOutlet(edges, at, time.Local)
		t.Logf("at %s: %+v", at.Format(time.RFC3339), fc)
	}
}

// TestReplayDrain measures the base drain on a real Argo state directory (read only): guard.jsonl and
// jobs.jsonl. Opt-in: ARGO_REPLAY_STATE=<dir> go test -run TestReplayDrain -v . Prints aggregates only.
func TestReplayDrain(t *testing.T) {
	dir := os.Getenv("ARGO_REPLAY_STATE")
	if dir == "" {
		t.Skip("set ARGO_REPLAY_STATE to an Argo state directory")
	}
	s := Store{Dir: dir}
	hist, runs := s.guardHistory(), s.jobRuns()
	if len(hist) == 0 {
		t.Fatal("no guard history")
	}
	st := drainStretches(hist, runs)
	d := measuredDrain(st, runs, hist[len(hist)-1].At)
	cost, n := batteryCost(runs, "gates")
	t.Logf("gates battery cost %d%%/run (%d runs measured): with a 2 h plan a gate needs %d%%", cost, n, eclipseReservePct+cost+2*d.PctH)
	t.Logf("guard samples %d (%s to %s), jobs %d: %d quiet stretches, %.1f h: %+v",
		len(hist), hist[0].At.Format(time.DateTime), hist[len(hist)-1].At.Format(time.DateTime), len(runs), len(st), d.Hours, d)
}

func TestEnergyCmd(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	plan := filepath.Join(t.TempDir(), "gauss-unplugged")
	_ = os.WriteFile(plan, []byte(strconv.FormatInt(enT0.Add(3*time.Hour).Unix(), 10)), 0o600)
	cur := enSample(0, 70, false)
	var out bytes.Buffer
	if err := energyCmd(context.Background(), []string{"plan"}, s, cur, plan, nil, enT0, &out); err != nil || strings.TrimSpace(out.String()) != "3 6 manual" {
		t.Fatalf("plan: %v %q", err, out.String())
	}
	out.Reset()
	if err := energyCmd(context.Background(), []string{"phone", "22", "charging"}, s, cur, plan, nil, enT0, &out); err != nil || !strings.Contains(out.String(), "22%") {
		t.Fatalf("phone: %v %q", err, out.String())
	}
	out.Reset()
	if err := energyCmd(context.Background(), nil, s, cur, "", nil, enT0, &out); err != nil || !strings.Contains(out.String(), "phone battery: 22% charging") {
		t.Fatalf("status: %v %q", err, out.String())
	}
	src := &fakeLog{body: "2026-11-17 22:41:53 +0800 Assertions \tSummary- Using Batt(Charge: 73)\n"}
	out.Reset()
	if err := energyCmd(context.Background(), []string{"import"}, s, cur, "", src.open, enT0, &out); err != nil || src.n != 1 {
		t.Fatalf("import: %v %d", err, src.n)
	}
	if err := energyCmd(context.Background(), []string{"bogus"}, s, cur, "", nil, enT0, &out); err == nil {
		t.Error("bogus subcommand accepted")
	}
}

func TestDoctorBuild(t *testing.T) {
	bi := &debug.BuildInfo{Settings: []debug.BuildSetting{{Key: "vcs.revision", Value: "0123456789abcdef"}, {Key: "vcs.time", Value: "2026-11-24T10:00:00Z"}, {Key: "vcs.modified", Value: "true"}}}
	out := doctorBuild(bi, true, EnergyState{})
	if !strings.Contains(out, "0123456789ab (2026-11-24T10:00:00Z)") || !strings.Contains(out, "uncommitted") || strings.Contains(out, "WARN") {
		t.Errorf("build line %q", out)
	}
	if out = doctorBuild(nil, false, EnergyState{Rev: energyRev + 1}); !strings.Contains(out, "no VCS revision") || !strings.Contains(out, "older than the energy code") {
		t.Errorf("no info, newer state: %q", out)
	}
	s := Store{Dir: t.TempDir()}
	_ = s.saveEnergy(EnergyState{Rev: energyRev + 3})
	if got := s.loadEnergy().Rev; got != energyRev+3 {
		t.Errorf("an older binary lowered the rev to %d", got)
	}
}
