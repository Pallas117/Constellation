package main

// Low-signal mode (REQ-ARG-040..041). Argo already measures the link on every
// probe: failed probes, connect time (RTT), its spread (jitter), the speed grade
// and, on Wi-Fi, RSSI. This file turns those into one verdict with hysteresis,
// so a weak hotspot makes Argo smaller, slower and quieter instead of louder:
//
//   - relay chunks shrink 1 MiB -> 64 KiB -> 4 KiB (a chunk that fits the link
//     gets through; the sender resumes at the first chunk not yet confirmed
//     because every chunk is its own persisted bundle);
//   - timeouts grow and retries back off exponentially with jitter, so a bad
//     link never sees a retry storm (the delay desynchronises devices, the
//     approach of RFC 8085 section 3.1 for UDP-style senders and of
//     exponential back-off generally; "equal jitter" form);
//   - the mesh report goes out less often and without history;
//   - alerts and receipts leave before bulk chunks (relay.go pending);
//   - phone alerts prefer SMS when data probes fail (phone.go).
//
// The mode is entered after a few bad probes in a row and left only after a
// long run of good ones AND a minimum time in the mode, so it cannot flap.

import (
	"context"
	"math"
	"net"
	"strconv"
	"time"
)

// chunkLadder is the relay chunk size at each low-signal level (0 = normal).
var chunkLadder = [...]int{chunkSize, 64 << 10, 4 << 10}

const (
	lowEnterBad     = 3                // consecutive bad probes to enter
	lowLeaveGood    = 10               // consecutive good probes to leave
	lowStepDownGood = 5                // good probes to relax one level while still in the mode
	lowMinStay      = 15 * time.Minute // never leave sooner than this after entering
	lowWindow       = 12               // probes kept for the loss figure
	lowRTTKeep      = 8                // RTTs kept for jitter
	lowReportEvery  = 5 * time.Minute  // mesh report cadence in the mode
	lowBulkPerSync  = 4                // bulk chunks uploaded per sync in the mode
	// the largest file the 4 KiB level will chunk (4096 bundles); bigger waits for a better link
	lowMaxFileBytes = 16 << 20
)

// LinkSample is what one probe says about the link.
type LinkSample struct {
	Online   bool
	Failed   bool    // a data probe (DNS or API) failed this round
	Loss     float64 // failed share of the recent window, 0-1
	RTTMs    int     // -1 unknown
	JitterMs int     // spread of recent RTTs, 0 unknown
	Poor     bool    // the speed grade is "poor"
	RSSI     int     // dBm, 0 unknown
}

// LowSignal is the persisted verdict (State.Low).
type LowSignal struct {
	On     bool      `json:"on,omitempty"`
	Level  int       `json:"level,omitempty"` // 1 or 2 while On: index into chunkLadder
	Since  time.Time `json:"since,omitempty"`
	Bad    int       `json:"bad,omitempty"`  // consecutive bad probes
	Good   int       `json:"good,omitempty"` // consecutive good probes
	Recent []bool    `json:"recent,omitempty"`
	RTTs   []int     `json:"rtts,omitempty"`
	// LastFailures is how many of the last 3 probes failed; the phone prefers SMS at 2 or more.
	LastFailures int `json:"last_failures,omitempty"`
}

func isBadSample(s LinkSample) bool {
	return !s.Online || s.Failed || s.Loss >= 0.15 || s.RTTMs >= 1500 || s.JitterMs >= 800 || s.Poor || (s.RSSI != 0 && s.RSSI <= -85)
}

func isGoodSample(s LinkSample) bool {
	return s.Online && !s.Failed && s.Loss < 0.05 && s.RTTMs >= 0 && s.RTTMs < 600 && !s.Poor && (s.RSSI == 0 || s.RSSI > -75)
}

// levelFor is how small chunks should be for this sample: 2 when most probes
// fail, 1 for a lossy or slow link.
func levelFor(s LinkSample) int {
	switch {
	case s.Loss >= 0.35 || !s.Online || s.RTTMs >= 3000:
		return 2
	case s.Loss >= 0.15 || s.RTTMs >= 1500 || s.JitterMs >= 800 || s.Poor || (s.RSSI != 0 && s.RSSI <= -85):
		return 1
	}
	return 0
}

// Observe folds one probe in and reports whether the mode or level changed.
// Samples in between "good" and "bad" change nothing: that is the hysteresis.
func (l *LowSignal) Observe(s LinkSample, now time.Time) bool {
	was, wasLevel := l.On, l.Level
	l.Recent = append(l.Recent, !s.Failed && s.Online)
	if len(l.Recent) > lowWindow {
		l.Recent = l.Recent[len(l.Recent)-lowWindow:]
	}
	if s.RTTMs >= 0 && s.Online {
		l.RTTs = append(l.RTTs, s.RTTMs)
		if len(l.RTTs) > lowRTTKeep {
			l.RTTs = l.RTTs[len(l.RTTs)-lowRTTKeep:]
		}
	}
	l.LastFailures = 0
	for i := len(l.Recent) - 1; i >= 0 && i >= len(l.Recent)-3; i-- {
		if !l.Recent[i] {
			l.LastFailures++
		}
	}
	switch {
	case isBadSample(s):
		l.Bad, l.Good = l.Bad+1, 0
	case isGoodSample(s):
		l.Good, l.Bad = l.Good+1, 0
	}
	target := levelFor(s)
	if !l.On {
		if l.Bad >= lowEnterBad {
			l.On, l.Since, l.Level = true, now, max(target, 1)
		}
		return l.On != was
	}
	if target > l.Level {
		l.Level = target // worse: shrink at once
	} else if l.Good > 0 && l.Good%lowStepDownGood == 0 && l.Level > 1 {
		l.Level-- // better: relax one step at a time
	}
	if l.Good >= lowLeaveGood && now.Sub(l.Since) >= lowMinStay {
		*l = LowSignal{Recent: l.Recent, RTTs: l.RTTs, LastFailures: l.LastFailures}
	}
	return l.On != was || l.Level != wasLevel
}

// ChunkBytes is the relay chunk size for the current level.
func (l LowSignal) ChunkBytes() int {
	if !l.On || l.Level <= 0 {
		return chunkLadder[0]
	}
	return chunkLadder[min(l.Level, len(chunkLadder)-1)]
}

// TimeoutScale multiplies network timeouts: 1 normally, 3 and 6 in the mode.
func (l LowSignal) TimeoutScale() int {
	switch {
	case !l.On:
		return 1
	case l.Level >= 2:
		return 6
	}
	return 3
}

// ReportGap is the least time between mesh reports (0 = every check).
func (l LowSignal) ReportGap() time.Duration {
	if l.On {
		return lowReportEvery
	}
	return 0
}

// PreferSMS says data probes are failing, so a phone alert should go by SMS.
func (l LowSignal) PreferSMS() bool { return l.On && l.LastFailures >= 2 }

// Label is the short text for `argo status`.
func (l LowSignal) Label() string {
	if !l.On {
		return ""
	}
	return " low-signal (" + humanBytes(l.ChunkBytes()) + " chunks)"
}

func humanBytes(n int) string {
	switch {
	case n >= 1<<20:
		return strconv.Itoa(n>>20) + " MiB"
	case n >= 1<<10:
		return strconv.Itoa(n>>10) + " KiB"
	}
	return strconv.Itoa(n) + " B"
}

// sampleFor builds the sample from one probe and the score already computed.
func sampleFor(s Snapshot, n NetScore, l LowSignal) LinkSample {
	ls := LinkSample{Online: s.Online, RTTMs: n.RTTMs, Poor: n.Speed == "poor"}
	// One dead path is not a weak link: with any independent anchor reachable, a failed
	// API or DNS lookup is that host's problem, not the signal's.
	anchorsOK := s.Anchors.Total > 0 && s.Anchors.Up > 0
	ls.Failed = !s.Online || ((s.API.Err != "" || s.DNS.Err != "") && !anchorsOK)
	if s.Signal != nil {
		ls.RSSI = s.Signal.RSSI
	}
	fails, total := 0, 0
	for _, ok := range l.Recent {
		total++
		if !ok {
			fails++
		}
	}
	total++
	if ls.Failed {
		fails++
	}
	if total >= 4 {
		ls.Loss = float64(fails) / float64(total)
	}
	if len(l.RTTs) > 0 && n.RTTMs >= 0 {
		lo, hi := n.RTTMs, n.RTTMs
		for _, r := range l.RTTs {
			lo, hi = min(lo, r), max(hi, r)
		}
		ls.JitterMs = hi - lo
	}
	return ls
}

// jitterBackoff is exponential back-off with "equal jitter": half the delay is
// fixed and half random, so retries from many devices spread out. rnd is a
// number in [0,1); the delay never exceeds ceil and never falls below base/2.
func jitterBackoff(attempts int, base, ceil time.Duration, rnd float64) time.Duration {
	if attempts < 1 {
		attempts = 1
	}
	d := base
	for i := 1; i < attempts && d < ceil; i++ {
		d *= 2
	}
	if d > ceil || d <= 0 {
		d = ceil
	}
	rnd = math.Min(math.Max(rnd, 0), 0.999999)
	return d/2 + time.Duration(rnd*float64(d/2))
}

var anchorHosts = []string{"1.1.1.1:443", "9.9.9.9:443", "8.8.8.8:443"}

// probeAnchors dials several independent hosts at once (2 s each).
func probeAnchors(ctx context.Context) Anchors {
	res := make(chan bool, len(anchorHosts))
	for _, h := range anchorHosts {
		go func() {
			d := net.Dialer{Timeout: 2 * time.Second}
			c, err := d.DialContext(ctx, "tcp", h)
			if err == nil {
				c.Close()
			}
			res <- err == nil
		}()
	}
	a := Anchors{Total: len(anchorHosts)}
	for range anchorHosts {
		if <-res {
			a.Up++
		}
	}
	return a
}

// recentLoss is the failed share of the recent probe window (for the parity ratio).
func recentLoss(l LowSignal) float64 {
	if len(l.Recent) < 4 {
		return 0
	}
	f := 0
	for _, ok := range l.Recent {
		if !ok {
			f++
		}
	}
	return float64(f) / float64(len(l.Recent))
}
