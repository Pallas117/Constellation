package main

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Foreground first (2 Nov, Josh: "I have a remote job ... make sure I can use chrome for video
// calls and the mercor AI workflow ... keep developing whilst I'm away"). The owner's own work
// on this Mac comes before Gauss's jobs, like a satellite's payload before housekeeping:
//   - In a call: new jobs over lightJobGB wait, running ones that big pause (SIGSTOP) until the
//     call ends, and Argo holds Wi-Fi resets until an outage outlasts callRejoinAfter.
//   - At the keyboard: a job must leave interactiveGB more free, so the browser stays responsive.
//   - Every guarded job runs at a lower CPU priority (jobNice). With nothing else running that
//     costs nothing; while the owner works, their apps get the CPU first.
//   - Away from the keyboard: no extra limit, so development continues unattended.
const (
	interactiveGB   = 0.5
	activeIdle      = 5 * time.Minute
	callRejoinAfter = offlineTellAfter // by then the call has dropped anyway
	jobNice         = 10
)

// Call detection reads `pmset -g assertions`. Chrome (and other Chromium browsers) holds an
// assertion named "WebRTC has active PeerConnections" during Meet, Zoom web, Teams web and the
// like (its type varies by version, so any type counts); the desktop call apps keep the display
// awake while in a call.
var (
	assertOwnerRe = regexp.MustCompile(`^\s*pid \d+\(([^)]+)\):.*\s(\w+) named: "([^"]*)"`)
	callApps      = []string{"zoom.us", "msteams", "microsoft teams", "facetime", "webex"}
)

// parseCallAssertions returns the app holding a call open, or "".
func parseCallAssertions(out string) string {
	for _, line := range strings.Split(out, "\n") {
		m := assertOwnerRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		owner, kind, name := m[1], m[2], strings.ToLower(m[3])
		if strings.Contains(name, "webrtc") {
			return owner
		}
		if kind != "PreventUserIdleDisplaySleep" && kind != "NoDisplaySleepAssertion" {
			continue
		}
		for _, app := range callApps {
			if strings.Contains(strings.ToLower(owner), app) {
				return owner
			}
		}
	}
	return ""
}

var hidIdleRe = regexp.MustCompile(`"HIDIdleTime"\s*=\s*(\d+)`)

// parseHIDIdle reads `ioreg -c IOHIDSystem -r -d 1 -k HIDIdleTime` (nanoseconds since the
// last key, click or trackpad touch).
func parseHIDIdle(out string) (time.Duration, bool) {
	m := hidIdleRe.FindStringSubmatch(out)
	if m == nil {
		return 0, false
	}
	ns, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return time.Duration(ns), true
}

// heavyForCall: a job big enough to pause during a call.
func heavyForCall(askedGB, peakGB float64) bool { return askedGB > lightJobGB || peakGB > lightJobGB }
