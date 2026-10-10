package main

import (
	"fmt"
	"sort"
	"strings"
	"time"
)

const summaryEvery = 7 * 24 * time.Hour

// weeklySummary describes what Argo caught, fixed and learned between from and to.
func weeklySummary(in []Incident, nets map[string]Net, from, to time.Time) string {
	opened := map[Class]int{}
	fixed, selfResolved := 0, 0
	for _, i := range in {
		if i.Time.Before(from) || i.Time.After(to) {
			continue
		}
		switch i.Event {
		case "open":
			opened[i.Class]++
		case "resolved":
			if i.Fix == "" || i.Fix == "wait" {
				selfResolved++
			} else {
				fixed++
			}
		}
	}
	newNets := 0
	for _, n := range nets {
		if !n.FirstSeen.Before(from) && !n.FirstSeen.After(to) {
			newNets++
		}
	}
	total := 0
	var classes []string
	for c, n := range opened {
		total += n
		classes = append(classes, fmt.Sprintf("%s %d", c, n))
	}
	sort.Strings(classes)

	var b strings.Builder
	fmt.Fprintf(&b, "Week to %s: ", to.Local().Format("Mon 2 Jan"))
	if total == 0 {
		b.WriteString("no network problems.")
	} else {
		fmt.Fprintf(&b, "%d problem(s) (%s); fixed %d, %d cleared on their own.", total, strings.Join(classes, ", "), fixed, selfResolved)
	}
	fmt.Fprintf(&b, " Networks known: %d (%d new this week).", len(nets), newNets)
	return b.String()
}

// maybeSendWeekly sends the summary by iMessage once every 7 days. The first
// call only starts the clock, so installing Argo doesn't trigger a message.
func maybeSendWeekly(s Store, phone *Phone, now time.Time) {
	if phone == nil {
		return
	}
	st := s.Load()
	switch {
	case st.LastSummaryAt.IsZero():
		st.LastSummaryAt = now
	case now.Sub(st.LastSummaryAt) >= summaryEvery:
		phone.Send("Argo weekly", weeklySummary(s.Incidents(), st.Networks, st.LastSummaryAt, now), now)
		st.LastSummaryAt = now
	default:
		return
	}
	_ = s.Save(st)
}
