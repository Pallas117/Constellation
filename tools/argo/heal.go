package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

// ---- self-healing, slice 2: blocker episodes and the remedy library ----
//
// Design: argo-self-healing-design-2026-10-31.md (claude-outputs). Every guard
// tick turns the assessment's findings into blocker episodes: one per finding
// code, from the first sample that showed it to the last, closed once it has
// been absent for healSettle. Each episode names the remedy the library would
// choose. Remedies that Argo already runs ("live": eclipse pause, autoscaled
// admission, power-budget workers) are recorded as such; the rest run in
// shadow ("shadow": chosen and logged, never executed) until the evidence in
// heal.jsonl shows they would have helped. Nothing here acts on the host.
//
// The episode log is the evidence for the later slices: replay, then a
// Thompson-sampling chooser. It stays on this device.

// healSettle is how long a blocker must stay absent before its episode
// closes, so one calm sample in a bad stretch does not split it in two.
const healSettle = 3 * time.Minute

// healKeep is how many closed episodes heal.jsonl keeps (about 200 KB).
const healKeep = 1000

// Remedy is what the library does about one blocker.
type Remedy struct {
	Name string `json:"name"`
	Kind string `json:"kind"` // live (Argo does it now) | shadow (chosen, not run) | person (needs Josh)
	Note string `json:"note"`
}

// remedyFor is the rules order of the design (phase 1): cheapest and safest
// first, reversible and own-workload only. Unknown codes go to a person.
func remedyFor(code string) Remedy {
	switch code {
	case "mem-critical", "mem-paging", "mem-warn-sustained", "swap-rising":
		return Remedy{"shed-load", "shadow", "pause guarded jobs above light size, mem-guard trim, unload the local model"}
	case "mem-warn", "swap-high", "no-headroom":
		return Remedy{"admit-light", "live", "admission limited to light work (autoscale)"}
	case "mem-warn-coping":
		return Remedy{"admit-by-available", "live", "coping: admit by what the kernel counts as available"}
	case "battery-floor", "battery-low", "battery-draining", "battery-low-pressure", "on-battery":
		return Remedy{"eclipse-pause", "live", "guarded jobs pause on battery and resume on AC"}
	case "charger-behind", "charger-weak":
		return Remedy{"power-budget", "live", "fewer workers within the charger's watts; a 20 W+ charger ends it"}
	case "disk-critical", "disk-low", "disk-tight":
		return Remedy{"clear-caches", "shadow", "clear the whitelisted rebuildable caches (disk-cleanup)"}
	case "cpu-throttled":
		return Remedy{"fewer-workers", "shadow", "halve workers until the OS lifts its speed limit"}
	case "cpu-saturated", "cpu-busy":
		return Remedy{"admit-light", "live", "admission limited or closed until load falls (autoscale)"}
	}
	return Remedy{"report", "person", "no remedy in the library: tell Josh"}
}

// Episode is one blocker from first seen to cleared.
type Episode struct {
	Code     string    `json:"code"`
	Resource string    `json:"resource"`
	Start    time.Time `json:"start"`
	LastSeen time.Time `json:"last_seen"`
	Peak     Level     `json:"peak"`
	Remedy   string    `json:"remedy"`
	Kind     string    `json:"kind"`
	// While open, the episode also counts ticks, so a closed one says how
	// much of its span the blocker was really there.
	Seen int `json:"seen"`
}

// Mins is the episode's length in whole minutes (at least 1: it was seen).
func (e Episode) Mins() int {
	m := int(e.LastSeen.Sub(e.Start).Round(time.Minute) / time.Minute)
	if m < 1 {
		m = 1
	}
	return m
}

// healStep folds one assessment into the open episodes and returns the ones
// that closed. Only findings at watch or worse are blockers.
func healStep(open map[string]Episode, a Assessment, now time.Time) (map[string]Episode, []Episode) {
	next := map[string]Episode{}
	for k, e := range open {
		next[k] = e
	}
	for _, f := range a.Findings {
		if f.Level < LevelWatch {
			continue
		}
		e, ok := next[f.Code]
		if !ok {
			r := remedyFor(f.Code)
			e = Episode{Code: f.Code, Resource: f.Resource, Start: now, Peak: f.Level, Remedy: r.Name, Kind: r.Kind}
		}
		if f.Level > e.Peak {
			e.Peak = f.Level
		}
		e.LastSeen = now
		e.Seen++
		next[f.Code] = e
	}
	var closed []Episode
	for k, e := range next {
		if now.Sub(e.LastSeen) >= healSettle {
			closed = append(closed, e)
			delete(next, k)
		}
	}
	sort.Slice(closed, func(i, j int) bool { return closed[i].Start.Before(closed[j].Start) })
	return next, closed
}

func (s Store) healEpisodes() []Episode {
	f, err := os.Open(s.path("heal.jsonl"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []Episode
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var e Episode
		if json.Unmarshal(sc.Bytes(), &e) == nil && e.Code != "" {
			out = append(out, e)
		}
	}
	return out
}

// appendHeal adds closed episodes and, past twice healKeep, keeps the newest healKeep.
func (s Store) appendHeal(closed []Episode) error {
	if len(closed) == 0 {
		return nil
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	all := s.healEpisodes()
	if len(all)+len(closed) > 2*healKeep {
		keep := append(all, closed...)
		keep = keep[len(keep)-healKeep:]
		var b strings.Builder
		for _, e := range keep {
			j, _ := json.Marshal(e)
			b.Write(j)
			b.WriteByte('\n')
		}
		tmp := s.path("heal.jsonl.tmp")
		if err := os.WriteFile(tmp, []byte(b.String()), 0o600); err != nil {
			return err
		}
		return os.Rename(tmp, s.path("heal.jsonl"))
	}
	f, err := os.OpenFile(s.path("heal.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	for _, e := range closed {
		j, _ := json.Marshal(e)
		if _, err := f.Write(append(j, '\n')); err != nil {
			return err
		}
	}
	return nil
}

// HealStat sums the closed episodes of one blocker code.
type HealStat struct {
	Code    string  `json:"code"`
	Remedy  string  `json:"remedy"`
	Kind    string  `json:"kind"`
	N       int     `json:"n"`
	MedMin  float64 `json:"median_min"`
	P90Min  float64 `json:"p90_min"`
	MaxMin  float64 `json:"max_min"`
	TotalH  float64 `json:"total_h"`
	Blocked int     `json:"blocked"` // episodes that reached risk or block (no new work)
}

func healStats(eps []Episode, since time.Time) []HealStat {
	by := map[string][]Episode{}
	for _, e := range eps {
		if !e.LastSeen.Before(since) {
			by[e.Code] = append(by[e.Code], e)
		}
	}
	var out []HealStat
	for code, es := range by {
		r := remedyFor(code)
		st := HealStat{Code: code, Remedy: r.Name, Kind: r.Kind, N: len(es)}
		var mins []float64
		var total float64
		for _, e := range es {
			m := float64(e.Mins())
			mins = append(mins, m)
			total += m
			if m > st.MaxMin {
				st.MaxMin = m
			}
			if e.Peak >= LevelRisk {
				st.Blocked++
			}
		}
		st.MedMin, st.P90Min, st.TotalH = percentile(mins, 0.5), percentile(mins, 0.9), round1(total/60)
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].TotalH != out[j].TotalH {
			return out[i].TotalH > out[j].TotalH
		}
		return out[i].Code < out[j].Code
	})
	return out
}

// healText is `argo heal`: open blockers and what the library would do, then
// how long each kind of blocker has lasted.
func healText(open map[string]Episode, stats []HealStat, days int, now time.Time) string {
	var b strings.Builder
	keys := make([]string, 0, len(open))
	for k := range open {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) == 0 {
		b.WriteString("blockers now: none\n")
	} else {
		b.WriteString("blockers now:\n")
		for _, k := range keys {
			e := open[k]
			r := remedyFor(e.Code)
			fmt.Fprintf(&b, "  %-20s %-6s for %3d min   %s (%s): %s\n", e.Code, e.Peak, int(now.Sub(e.Start).Minutes()), r.Name, r.Kind, r.Note)
		}
	}
	fmt.Fprintf(&b, "\nblockers in the last %d days (closed episodes; remedies marked shadow were chosen, not run):\n", days)
	if len(stats) == 0 {
		b.WriteString("  none recorded yet (the log starts with this version)\n")
		return b.String()
	}
	fmt.Fprintf(&b, "  %-20s %4s %7s %7s %7s %7s  %s\n", "blocker", "n", "median", "p90", "max", "total", "remedy")
	for _, st := range stats {
		fmt.Fprintf(&b, "  %-20s %4d %5.0fm %5.0fm %5.0fm %6.1fh  %s (%s)\n", st.Code, st.N, st.MedMin, st.P90Min, st.MaxMin, st.TotalH, st.Remedy, st.Kind)
	}
	b.WriteString("  credit: none yet. Each episode cleared on its own or under a live remedy; shadow remedies are credited only after replay.\n")
	return b.String()
}
