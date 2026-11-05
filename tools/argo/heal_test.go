package main

import (
	"strings"
	"testing"
	"time"
)

// ---- self-healing slice 2: episodes and remedies (heal.go) ----

func withFindings(fs ...Finding) Assessment {
	var a Assessment
	for _, f := range fs {
		a.add(f.Resource, f.Code, f.Level, "%s", f.Text)
	}
	return a
}

func TestHealStepOpensTracksAndClosesAfterSettle(t *testing.T) {
	t0 := time.Date(2026, 11, 4, 1, 0, 0, 0, time.UTC)
	warn := withFindings(Finding{Resource: "memory", Code: "mem-warn", Level: LevelWatch})
	worse := withFindings(Finding{Resource: "memory", Code: "mem-warn", Level: LevelRisk})
	calm := Assessment{}

	open, closed := healStep(nil, warn, t0)
	if len(open) != 1 || len(closed) != 0 || open["mem-warn"].Remedy != "admit-light" || open["mem-warn"].Kind != "live" {
		t.Fatalf("first sight: open=%v closed=%v", open, closed)
	}
	open, _ = healStep(open, worse, t0.Add(time.Minute))
	if e := open["mem-warn"]; e.Peak != LevelRisk || e.Seen != 2 || !e.Start.Equal(t0) {
		t.Fatalf("peak and count not kept: %+v", e)
	}
	// One calm sample inside the settle window must not split the episode.
	open, closed = healStep(open, calm, t0.Add(2*time.Minute))
	if len(closed) != 0 || len(open) != 1 {
		t.Fatalf("closed too early: %v", closed)
	}
	open, _ = healStep(open, warn, t0.Add(3*time.Minute))
	open, closed = healStep(open, calm, t0.Add(6*time.Minute))
	if len(closed) != 1 || len(open) != 0 {
		t.Fatalf("want one closed episode after settle, open=%v closed=%v", open, closed)
	}
	if e := closed[0]; e.Mins() != 3 || e.Seen != 3 || e.Peak != LevelRisk {
		t.Fatalf("closed episode: %+v (mins %d)", e, e.Mins())
	}
}

func TestHealStepIgnoresOKFindingsAndDoesNotMutateInput(t *testing.T) {
	t0 := time.Now()
	ok := withFindings(Finding{Resource: "memory", Code: "no-headroom", Level: LevelOK})
	open, _ := healStep(nil, ok, t0)
	if len(open) != 0 {
		t.Fatalf("LevelOK finding became a blocker: %v", open)
	}
	in := map[string]Episode{"disk-low": {Code: "disk-low", Start: t0, LastSeen: t0}}
	_, closed := healStep(in, Assessment{}, t0.Add(10*time.Minute))
	if len(closed) != 1 || len(in) != 1 {
		t.Fatalf("input map changed or episode not closed: in=%v closed=%v", in, closed)
	}
}

func TestRemedyLibraryIsReversibleOrPerson(t *testing.T) {
	// Every code the guard can raise has a remedy, and none is an unknown kind.
	codes := []string{"mem-critical", "mem-paging", "mem-warn-coping", "mem-warn-sustained", "mem-warn", "pressure-unknown",
		"swap-rising", "swap-high", "no-headroom", "battery-floor", "battery-low", "battery-draining", "battery-low-pressure",
		"on-battery", "charger-behind", "charger-weak", "disk-critical", "disk-low", "disk-tight", "cpu-throttled",
		"cpu-saturated", "cpu-busy"}
	for _, c := range codes {
		r := remedyFor(c)
		if r.Kind != "live" && r.Kind != "shadow" && r.Kind != "person" {
			t.Errorf("%s: kind %q", c, r.Kind)
		}
	}
	if remedyFor("pressure-unknown").Kind != "person" || remedyFor("something-new").Kind != "person" {
		t.Error("unknown blockers must go to a person")
	}
	if remedyFor("disk-low").Kind != "shadow" || remedyFor("mem-paging").Kind != "shadow" {
		t.Error("actions Argo does not run yet must stay shadow")
	}
}

func TestHealLogRoundTripTrimAndStats(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	t0 := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	var eps []Episode
	for i := 0; i < 2*healKeep+5; i++ {
		start := t0.Add(time.Duration(i) * time.Hour)
		eps = append(eps, Episode{Code: "disk-low", Resource: "disk", Start: start, LastSeen: start.Add(time.Duration(i%10+1) * time.Minute), Peak: LevelRisk})
	}
	if err := s.appendHeal(eps[:2*healKeep]); err != nil {
		t.Fatal(err)
	}
	if err := s.appendHeal(eps[2*healKeep:]); err != nil {
		t.Fatal(err)
	}
	got := s.healEpisodes()
	if len(got) != healKeep || !got[len(got)-1].Start.Equal(eps[len(eps)-1].Start) {
		t.Fatalf("trim kept %d (want %d, newest last)", len(got), healKeep)
	}
	st := healStats(got, time.Time{})
	if len(st) != 1 || st[0].N != healKeep || st[0].Blocked != healKeep || st[0].MaxMin != 10 || st[0].Kind != "shadow" {
		t.Fatalf("stats: %+v", st)
	}
	txt := healText(map[string]Episode{"disk-low": got[0]}, st, 7, got[0].Start.Add(5*time.Minute))
	for _, want := range []string{"blockers now:", "disk-low", "clear-caches (shadow)", "credit: none yet"} {
		if !strings.Contains(txt, want) {
			t.Errorf("heal text lacks %q:\n%s", want, txt)
		}
	}
}

func TestGuardStepRecordsEpisodes(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	t0 := time.Date(2026, 11, 4, 2, 0, 0, 0, time.UTC)
	low := Sample{At: t0, Pressure: "normal", RAMGB: 8, InRAMGB: 3, DiskGB: 1, CPUs: 8}
	guardStep(s, Config{}, low)
	if g := s.loadGuard(); g.Open["disk-critical"].Code == "" {
		t.Fatalf("disk-critical not opened: %+v", g.Open)
	}
	ok := low
	ok.DiskGB = 100
	for i := 1; i <= 5; i++ {
		ok.At = t0.Add(time.Duration(i) * time.Minute)
		guardStep(s, Config{}, ok)
	}
	if eps := s.healEpisodes(); len(eps) != 1 || eps[0].Code != "disk-critical" {
		t.Fatalf("want the disk episode logged once cleared, got %+v", eps)
	}
}
