package main

// Brownout load shedding (2 Nov, Josh: "a software solution to power flow and offer some
// self-healing"). Eclipse mode pauses jobs on battery; a weak charger (the 8 W phone brick)
// is the case between: the Mac is plugged in, yet the battery still pays for part of the load.
// A spacecraft in that state sheds non-essential loads at a depth of discharge and switches them
// back on once the battery has recovered. The guard does the same for running jobs:
//   - shed (SIGSTOP) when plugged in, not charging and the battery is at shedPct or below;
//   - restore when it has charged back to restorePct, or a charger that can carry the load
//     (strongChargerW) is charging it.
//
// The gap between the two is the hysteresis: while paused, even 8 W charges the battery, so jobs
// run in bursts the charger can pay for instead of draining it to the floor. Paused longer than
// maxPause, a job exits 75 and the queue retries it later, as in eclipse.
const (
	shedPct        = 35
	restorePct     = 50
	strongChargerW = 30 // claude-heavy's MIN_ADAPTER_W
)

// brownout says whether a running job should be (or stay) shed. shedding is the current state,
// so the thresholds differ on the way down and on the way up.
func brownout(s Sample, a Assessment, shedding bool) bool {
	b := s.Batt
	if b == nil || !b.Present || !b.OnAC {
		return false // on battery is eclipse's call; no battery, nothing to protect
	}
	if shedding {
		strong := b.Charging && b.AdapterW >= strongChargerW
		return b.Pct < restorePct && !strong
	}
	return b.Pct <= shedPct && (a.ChargerBehind || !b.Charging)
}
