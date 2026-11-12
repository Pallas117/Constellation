package main

import (
	"fmt"
	"math"
	"sort"
)

// ---- power budget (SWaP) ----
//
// Josh 2026-11-02: "use a space systems technique like SWaP to measure and autoscale the power
// draw of this device and other devices on the network". A spacecraft power subsystem keeps a
// budget: what the source can supply after derating, what the loads draw, and the margin between
// them; loads are only switched on while the margin holds, and are shed in eclipse. Argo does the
// same for a laptop on a hostel charger:
//   - source: the charger's rating, derated (USB-C conversion losses and a charger that
//     sags when warm mean an 8 W adapter does not deliver 8 W to the machine);
//   - load:   what the whole machine draws now (the battery controller's SystemLoad);
//   - margin: source − load. ARGO_WORKERS never asks for more watts than the margin holds,
//     using the watts one worker added on earlier runs of the same job (measured, not guessed);
//   - modes:  positive (margin ≥ 0), negative (plugged in but the charger can't carry the load,
//     so the battery drains anyway) and eclipse (on battery: guarded jobs pause, see guardcmd.go).
// The mode and margin go to Gauss with every report, so it can place work on the devices that
// have power to spare. Desktops and hosts that report no draw get no power cap (mode unknown).

const (
	sourceDerate   = 0.8 // fraction of the charger's rating counted as available
	defaultWorkerW = 3.0 // watts one test or browser worker adds, until a job's own runs say otherwise
	minWorkerW     = 0.5 // a measurement below this is noise (the controller reports in 0.1 W steps)
)

// PowerMode is where the host sits in its power budget.
type PowerMode string

const (
	PowerUnknown  PowerMode = ""         // no battery controller, or no draw or charger reading
	PowerPositive PowerMode = "positive" // plugged in with margin to spare
	PowerNegative PowerMode = "negative" // plugged in, but drawing more than the charger supplies
	PowerEclipse  PowerMode = "eclipse"  // on battery
)

// PowerBudget is one reading of the budget. Watts, rounded to 0.1.
type PowerBudget struct {
	Mode    PowerMode `json:"mode,omitempty"`
	SourceW float64   `json:"sourceW,omitempty"` // derated charger supply; 0 on battery
	LoadW   float64   `json:"loadW,omitempty"`   // what the machine draws
	MarginW float64   `json:"marginW"`           // SourceW − LoadW; negative when the battery covers the gap
}

// powerBudget reads the budget from one sample.
func powerBudget(s Sample) PowerBudget {
	b := s.Batt
	if b == nil || !b.Present {
		return PowerBudget{}
	}
	if !b.OnAC {
		return PowerBudget{Mode: PowerEclipse, LoadW: b.SystemW, MarginW: round1(-b.SystemW)}
	}
	if b.AdapterW <= 0 || b.SystemW <= 0 {
		return PowerBudget{}
	}
	p := PowerBudget{SourceW: round1(b.AdapterW * sourceDerate), LoadW: b.SystemW}
	p.MarginW = round1(p.SourceW - p.LoadW)
	p.Mode = PowerPositive
	if p.MarginW < 0 {
		p.Mode = PowerNegative
	}
	return p
}

// powerWorkers caps a worker count by the power margin: in the negative mode one worker (the
// battery is already covering the gap), with a positive margin no more workers than it holds,
// never fewer than one. Unknown and eclipse leave n alone: eclipse is handled by admission
// (light work only) and by pausing jobs.
func powerWorkers(n int, p PowerBudget, workerW float64) int {
	switch p.Mode {
	case PowerNegative:
		return 1
	case PowerPositive:
		if workerW < minWorkerW {
			workerW = defaultWorkerW
		}
		if m := int(p.MarginW / workerW); m < n {
			n = m
		}
	}
	return max(n, 1)
}

// workerWatts is what one worker of this job added to the machine's draw, measured over its
// newest successful runs (median, so one run next to a video call doesn't decide), else the
// default. The note says which, for the output.
func workerWatts(runs []JobRun, name string) (float64, string) {
	var per []float64
	for i := len(runs) - 1; i >= 0 && len(per) < learnWindow; i-- {
		r := runs[i]
		if r.Name != name || r.Outcome != "exit 0" || r.Workers < 1 || r.AvgW <= 0 || r.BaseW <= 0 {
			continue
		}
		if w := (r.AvgW - r.BaseW) / float64(r.Workers); w >= minWorkerW {
			per = append(per, w)
		}
	}
	if len(per) < learnMin {
		return defaultWorkerW, ""
	}
	sort.Float64s(per)
	w := per[len(per)/2]
	if len(per)%2 == 0 {
		w = (per[len(per)/2-1] + w) / 2
	}
	w = round1(w)
	return w, fmt.Sprintf("%s adds %.1f W per worker, measured over its last %d runs", name, w, len(per))
}

// powerText is the budget in one line, for `argo guard`.
func powerText(p PowerBudget, workerW float64) string {
	switch p.Mode {
	case PowerPositive:
		return fmt.Sprintf("positive: %.1f W supplied (%.0f%% of the charger), %.1f W drawn, %.1f W margin = %d worker(s) at %.1f W",
			p.SourceW, sourceDerate*100, p.LoadW, p.MarginW, max(int(math.Floor(p.MarginW/workerW)), 1), workerW)
	case PowerNegative:
		return fmt.Sprintf("negative: drawing %.1f W from %.1f W supplied: the battery covers %.1f W, one worker only",
			p.LoadW, p.SourceW, -p.MarginW)
	case PowerEclipse:
		if p.LoadW > 0 {
			return fmt.Sprintf("eclipse: on battery, drawing %.1f W: guarded jobs pause until power returns", p.LoadW)
		}
		return "eclipse: on battery: guarded jobs pause until power returns"
	}
	return "unknown: no charger or draw reading, so no power cap"
}
