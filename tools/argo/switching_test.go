package main

import (
	"bufio"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func loadIncidentLog(t *testing.T, name string) []Incident {
	t.Helper()
	f, err := os.Open("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []Incident
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var in Incident
		if err := json.Unmarshal(sc.Bytes(), &in); err != nil {
			t.Fatal(err)
		}
		out = append(out, in)
	}
	return out
}

// Replay of 2026-11-05 (public Wi-Fi in Malaysia during a storm). The numbers in
// docs/argo/switching-2026-11-05.md come from this fixture; change one, change both.
func TestOutagesReplay20261105(t *testing.T) {
	kl := time.FixedZone("MYT", 8*3600)
	at := func(h, m, s int) time.Time { return time.Date(2026, 11, 5, h, m, s, 0, kl) }
	eps := linkOutages(loadIncidentLog(t, "incidents-2026-11-05.jsonl"))
	if len(eps) != 10 {
		t.Fatalf("episodes = %d, want 10: %v", len(eps), linkOutageLines(eps))
	}
	cases := []struct {
		i        int
		start    time.Time
		classes  []Class
		duration time.Duration
		fix      string
		attempts int
	}{
		{0, at(11, 31, 24), []Class{PortBlock}, 18*time.Minute + 25*time.Second, "", 1},
		{1, at(12, 49, 45), []Class{Offline, DNS, PortBlock, Offline, PortBlock}, 32*time.Minute + 26*time.Second, "", 4},
		{5, at(15, 40, 4), []Class{PortBlock}, 3*time.Minute + 43*time.Second, "switch-network", 2},
		{8, at(19, 13, 50), []Class{Offline, PortBlock}, 8*time.Minute + 3*time.Second, "", 3},
		{9, at(19, 24, 55), []Class{Offline}, 10 * time.Second, "", 1},
	}
	for _, c := range cases {
		e := eps[c.i]
		if !e.Start.Truncate(time.Second).Equal(c.start) || e.Duration().Round(time.Second) != c.duration || e.Fix != c.fix || e.Attempts != c.attempts || len(e.Classes) != len(c.classes) {
			t.Errorf("episode %d = %+v, want start %s classes %v duration %s fix %q attempts %d", c.i, e, c.start, c.classes, c.duration, c.fix, c.attempts)
		}
		for j := range c.classes {
			if j < len(e.Classes) && e.Classes[j] != c.classes[j] {
				t.Errorf("episode %d class %d = %s, want %s", c.i, j, e.Classes[j], c.classes[j])
			}
		}
	}
	// The 19:13 outage: classified OFFLINE at open, PORT_BLOCK 4m07s later, advice at open.
	e := eps[8]
	if e.FirstAdvice.Sub(e.Start) != 0 {
		t.Errorf("first advice %s after open, want 0", e.FirstAdvice.Sub(e.Start))
	}
	if lines := linkOutageLines(eps); len(lines) != 10 || lines[8] == "" {
		t.Errorf("linkOutageLines = %v", lines)
	}
}

func TestOutagesOpenAndEmpty(t *testing.T) {
	if got := linkOutages(nil); len(got) != 0 {
		t.Fatalf("linkOutages(nil) = %v", got)
	}
	now := time.Date(2026, 11, 5, 19, 0, 0, 0, time.UTC)
	eps := linkOutages([]Incident{{Time: now, Event: "open", Class: Offline, Fingerprint: "abc"}, {Time: now.Add(time.Minute), Event: "attempt", Class: Offline, Fingerprint: "abc"}})
	if len(eps) != 1 || !eps[0].Open || eps[0].Duration() != 0 || eps[0].FirstAdvice.Sub(eps[0].Start) != time.Minute {
		t.Fatalf("open episode = %+v", eps)
	}
	if l := linkOutageLines(eps); len(l) != 1 {
		t.Fatalf("lines = %v", l)
	}
}
