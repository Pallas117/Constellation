package main

// Link stability from Argo's own incident log: how much of the time this
// device had a working path, how often it dropped and how long it took to
// recover. Availability A = MTBF / (MTBF + MTTR), computed directly as
// 1 − down/observed. Anything Argo didn't see is "not measured", never a
// guess. Time the Mac spent asleep counts as observed and up unless an
// incident was open, which is why the line says "while Argo was watching".

import (
	"fmt"
	"sort"
	"time"
)

// LinkStats covers one window (24 h or 7 days). Durations are seconds; -1
// means not measured (no history yet, or no outage to time).
type LinkStats struct {
	ObservedSec  int64   `json:"observedSec"`
	Availability float64 `json:"availability"` // 0..1, or -1
	Outages      int     `json:"outages"`
	DownSec      int64   `json:"downSec"`
	MTTRP50Sec   int64   `json:"mttrP50Sec"`
	MTTRP95Sec   int64   `json:"mttrP95Sec"`
	MTBFSec      int64   `json:"mtbfSec"`
}

type outage struct{ from, to time.Time }

// outages turns open/resolved/superseded events into merged down intervals.
// One failure turning into another ("superseded" then "open") stays one outage.
func outages(in []Incident, now time.Time) []outage {
	sorted := append([]Incident(nil), in...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Time.Before(sorted[j].Time) })
	var out []outage
	var open *time.Time
	for _, e := range sorted {
		switch e.Event {
		case "open":
			if open == nil {
				t := e.Time
				if n := len(out); n > 0 && !t.After(out[n-1].to) { // a supersede: continue the last outage
					t = out[n-1].from
					out = out[:n-1]
				}
				open = &t
			}
		case "resolved", "superseded":
			if open != nil {
				out = append(out, outage{*open, e.Time})
				open = nil
			}
		}
	}
	if open != nil {
		out = append(out, outage{*open, now})
	}
	return out
}

func nearestRank(sorted []int64, p float64) int64 {
	if len(sorted) == 0 {
		return -1
	}
	i := int(p*float64(len(sorted))+0.999999) - 1 // nearest rank
	return sorted[min(max(i, 0), len(sorted)-1)]
}

// linkStats measures one window ending now. since is when Argo started
// keeping history on this device (zero: unknown).
func linkStats(in []Incident, since, now time.Time, window time.Duration) LinkStats {
	start := now.Add(-window)
	if since.IsZero() {
		for _, e := range in {
			if since.IsZero() || e.Time.Before(since) {
				since = e.Time
			}
		}
	}
	if since.IsZero() || !since.Before(now) {
		return LinkStats{Availability: -1, MTTRP50Sec: -1, MTTRP95Sec: -1, MTBFSec: -1}
	}
	if since.After(start) {
		start = since
	}
	s := LinkStats{ObservedSec: int64(now.Sub(start) / time.Second)}
	var down time.Duration
	var mttr []int64
	for _, o := range outages(in, now) {
		from, to := o.from, o.to
		if !to.After(start) {
			continue
		}
		if from.Before(start) {
			from = start
		} else {
			s.Outages++
		}
		down += to.Sub(from)
		if o.to.Before(now) && !o.from.Before(start) { // only finished outages that began in the window
			mttr = append(mttr, int64(o.to.Sub(o.from)/time.Second))
		}
	}
	s.DownSec = int64(down / time.Second)
	s.Availability = 1
	if s.ObservedSec > 0 {
		s.Availability = max(0, 1-float64(s.DownSec)/float64(s.ObservedSec))
	}
	sort.Slice(mttr, func(i, j int) bool { return mttr[i] < mttr[j] })
	s.MTTRP50Sec, s.MTTRP95Sec = nearestRank(mttr, 0.5), nearestRank(mttr, 0.95)
	s.MTBFSec = -1
	if s.Outages > 0 {
		s.MTBFSec = (s.ObservedSec - s.DownSec) / int64(s.Outages)
	}
	return s
}

// LinkReport is what Argo sends to Gauss and prints for `argo link`.
type LinkReport struct {
	Day  LinkStats `json:"d1"`
	Week LinkStats `json:"d7"`
}

func linkReport(in []Incident, st State, now time.Time) LinkReport {
	var since time.Time
	for _, n := range st.Networks {
		if since.IsZero() || n.FirstSeen.Before(since) {
			since = n.FirstSeen
		}
	}
	for _, e := range in {
		if since.IsZero() || e.Time.Before(since) {
			since = e.Time
		}
	}
	return LinkReport{Day: linkStats(in, since, now, 24*time.Hour), Week: linkStats(in, since, now, 7*24*time.Hour)}
}

func humanSecs(s int64) string {
	switch {
	case s < 0:
		return "n/a"
	case s < 90:
		return fmt.Sprintf("%d s", s)
	case s < 90*60:
		return fmt.Sprintf("%d min", (s+30)/60)
	case s < 48*3600:
		return fmt.Sprintf("%.1f h", float64(s)/3600)
	}
	return fmt.Sprintf("%.1f days", float64(s)/86400)
}

func (s LinkStats) Line() string {
	if s.Availability < 0 {
		return "not measured yet"
	}
	line := fmt.Sprintf("%.1f%% up over %s, %d drop", 100*s.Availability, humanSecs(s.ObservedSec), s.Outages)
	if s.Outages != 1 {
		line += "s"
	}
	if s.MTTRP50Sec >= 0 {
		line += fmt.Sprintf(", typical outage %s (p95 %s)", humanSecs(s.MTTRP50Sec), humanSecs(s.MTTRP95Sec))
	}
	if s.MTBFSec >= 0 {
		line += fmt.Sprintf(", %s between drops", humanSecs(s.MTBFSec))
	}
	return line
}

// Score is the 7-day availability as 0-100, or -1 when not measured.
func (r LinkReport) Score() int {
	if r.Week.Availability < 0 {
		return -1
	}
	return int(100*r.Week.Availability + 0.5)
}

func (r LinkReport) Text() string {
	score := "not measured"
	if r.Score() >= 0 {
		score = fmt.Sprintf("%d/100", r.Score())
	}
	out := fmt.Sprintf("Link stability %s (7-day availability while Argo was watching)\n  24 h: %s\n  7 d:  %s", score, r.Day.Line(), r.Week.Line())
	if p95 := r.Week.MTTRP95Sec; p95 > 0 && time.Duration(p95)*time.Second > defaultTTL/2 {
		out += "\n  Outages this long can outlast a bundle's lifetime: send with a longer -ttl."
	}
	return out
}
