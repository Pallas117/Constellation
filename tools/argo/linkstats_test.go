package main

import (
	"math"
	"strings"
	"testing"
	"time"
)

func TestLinkStats(t *testing.T) {
	t0 := time.Date(2026, 10, 22, 0, 0, 0, 0, time.UTC)
	now := t0.Add(10 * time.Hour)
	at := func(d time.Duration) time.Time { return t0.Add(d) }
	in := []Incident{
		{Time: at(time.Hour), Event: "open", Class: Offline},
		{Time: at(time.Hour + 5*time.Minute), Event: "resolved", Class: Offline},
		// DNS turning into PORT_BLOCK is one 10-minute outage, not two.
		{Time: at(3 * time.Hour), Event: "open", Class: DNS},
		{Time: at(3*time.Hour + 2*time.Minute), Event: "superseded", Class: DNS},
		{Time: at(3*time.Hour + 2*time.Minute), Event: "open", Class: PortBlock},
		{Time: at(3*time.Hour + 5*time.Minute), Event: "attempt", Class: PortBlock},
		{Time: at(3*time.Hour + 10*time.Minute), Event: "resolved", Class: PortBlock},
		{Time: now.Add(-time.Minute), Event: "open", Class: Offline}, // still down
	}
	s := linkStats(in, t0, now, 24*time.Hour)
	if s.ObservedSec != 36000 || s.Outages != 3 || s.DownSec != 960 {
		t.Fatalf("%+v", s)
	}
	if math.Abs(s.Availability-(1-960.0/36000)) > 1e-9 || s.MTTRP50Sec != 300 || s.MTTRP95Sec != 600 || s.MTBFSec != (36000-960)/3 {
		t.Fatalf("%+v", s)
	}
	last := linkStats(in, t0, now, time.Hour)
	if last.Outages != 1 || last.DownSec != 60 || last.MTTRP50Sec != -1 {
		t.Fatalf("1 h window: %+v", last)
	}
	// An outage that began before the window counts its time inside, not as a new drop.
	span := []Incident{{Time: now.Add(-70 * time.Minute), Event: "open", Class: Offline}, {Time: now.Add(-50 * time.Minute), Event: "resolved", Class: Offline}}
	if c := linkStats(span, t0, now, time.Hour); c.Outages != 0 || c.DownSec != 600 {
		t.Fatalf("clipped: %+v", c)
	}
	if n := linkStats(nil, time.Time{}, now, time.Hour); n.Availability != -1 || !strings.Contains(n.Line(), "not measured") {
		t.Fatalf("no history must be 'not measured': %+v", n)
	}
	if q := linkStats(nil, t0, now, time.Hour); q.Availability != 1 || q.Outages != 0 || q.MTBFSec != -1 {
		t.Fatalf("quiet hour: %+v", q)
	}
	r := linkReport(in, State{Networks: map[string]Net{"n": {FirstSeen: t0}}}, now)
	if r.Score() != 97 || !strings.Contains(r.Text(), "Link stability 97/100") || !strings.Contains(r.Day.Line(), "3 drops") {
		t.Fatalf("report: %d\n%s", r.Score(), r.Text())
	}
}
