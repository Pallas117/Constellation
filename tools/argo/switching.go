package main

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

// LinkOutage is one outage as the incident log recorded it: from the first blocking class to
// the resolve, with every class it passed through. `argo report --episodes` and the
// switching measurements (docs/argo/switching-2026-11-05.md) are built from these, so the
// numbers quoted there can be re-derived from the same log.
type LinkOutage struct {
	Start, End  time.Time
	Fingerprint string
	Classes     []Class   // in the order they were opened
	Attempts    int       // "attempt" events: a plan was shown or an automatic step ran
	FirstAdvice time.Time // first attempt; zero when the log has none
	Fix         string    // credited fix, "" when it cleared by itself
	Open        bool      // no resolve yet
}

func (e LinkOutage) Duration() time.Duration {
	if e.End.IsZero() {
		return 0
	}
	return e.End.Sub(e.Start)
}

// episodes folds the incident log into outages. "superseded" joins two classes into one
// outage (the loop keeps one IncidentAt across a flip, loop.go), "resolved" closes it.
func linkOutages(in []Incident) []LinkOutage {
	sorted := append([]Incident(nil), in...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Time.Before(sorted[j].Time) })
	var out []LinkOutage
	var cur *LinkOutage
	for _, e := range sorted {
		switch e.Event {
		case "open":
			if cur == nil {
				out = append(out, LinkOutage{Start: e.Time, Fingerprint: e.Fingerprint, Open: true})
				cur = &out[len(out)-1]
			}
			cur.Classes = append(cur.Classes, e.Class)
		case "attempt":
			if cur != nil {
				cur.Attempts++
				if cur.FirstAdvice.IsZero() {
					cur.FirstAdvice = e.Time
				}
			}
		case "resolved":
			if cur != nil {
				cur.End, cur.Fix, cur.Open = e.Time, e.Fix, false
				cur = nil
			}
		}
	}
	return out
}

// linkOutageLines renders episodes for `argo report --episodes`, newest last.
func linkOutageLines(eps []LinkOutage) []string {
	var out []string
	for _, e := range eps {
		cls := make([]string, len(e.Classes))
		for i, c := range e.Classes {
			cls[i] = string(c)
		}
		end, fix := "open", "cleared by itself"
		if !e.Open {
			end = e.Duration().Round(time.Second).String()
		}
		if e.Fix != "" {
			fix = "fix: " + e.Fix
		}
		advice := "no advice"
		if !e.FirstAdvice.IsZero() {
			advice = fmt.Sprintf("advice after %s", e.FirstAdvice.Sub(e.Start).Round(time.Second))
		}
		out = append(out, fmt.Sprintf("%s  %-12s %-22s %-8s %s, %d attempts, %s",
			e.Start.Local().Format("2006-01-02 15:04:05"), e.Fingerprint, strings.Join(cls, "→"), end, advice, e.Attempts, fix))
	}
	return out
}
