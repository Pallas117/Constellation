package main

import (
	"context"
	"testing"
	"time"
)

// Argo learns from what really happened (Josh, 2026-10-23: "the system should
// be adapting better, not making the same mistakes"). On the hostel hotspot
// that day: 17 of 18 incidents had an empty network fingerprint, "wait" was
// credited as the fix for OFFLINE 7 times, "switch network" for PORT_BLOCK 3
// times though nobody switched, and every recovery sent a notification.

type adaptiveRig struct {
	t               *testing.T
	l               Loop
	fx              *fakeFx
	ok, port, offln Snapshot
}

func newAdaptiveRig(t *testing.T) *adaptiveRig {
	ok := fixture(t, "my_sim_ok.json")
	port := fixture(t, "port_block.json")
	port.GatewayMAC, port.PublicIP = ok.GatewayMAC, "" // same router; the internet isn't answering
	offln := fixture(t, "offline.json")
	l, fx := newLoop(t, ok)
	return &adaptiveRig{t: t, l: l, fx: fx, ok: ok, port: port, offln: offln}
}

func (r *adaptiveRig) tick(s Snapshot, after time.Duration) State {
	r.fx.now = r.fx.now.Add(after)
	r.l.Prober = &seqProber{snaps: []Snapshot{s}}
	return r.l.Tick(context.Background())
}

// blip runs one incident of snapshot s that clears by itself after d.
func (r *adaptiveRig) blip(s Snapshot, d time.Duration) {
	r.tick(s, time.Minute)
	r.tick(r.ok, d)
}

func TestOfflineBelongsToTheNetworkWeWereOn(t *testing.T) {
	r := newAdaptiveRig(t)
	home := r.tick(r.ok, 0).Fingerprint
	r.tick(r.offln, time.Minute)
	for _, in := range r.l.Store.Incidents() {
		if in.Fingerprint != home {
			t.Fatalf("%s %s recorded on %q, want the network we were on (%s)", in.Event, in.Class, in.Fingerprint, home)
		}
	}
	st := r.tick(r.ok, 3*time.Minute)
	if got := st.Networks[home].Recover[Offline]; len(got) != 1 || got[0] != 180 {
		t.Fatalf("recovery not learned for this network: %v", st.Networks[home])
	}
	if st.Networks[home].Fixes[Offline] != "" {
		t.Fatal(`"wait" must never be credited as a fix`)
	}
	if last := r.l.Store.Incidents(); last[len(last)-1].Detail != "cleared by itself" {
		t.Fatalf("resolved event: %+v", last[len(last)-1])
	}
}

func TestSwitchNetworkCreditedOnlyWhenTheNetworkChanged(t *testing.T) {
	r := newAdaptiveRig(t)
	r.port.Tailscale.ExitCandidates = nil // no allow-listed exit node: switching is the advice
	home := r.tick(r.ok, 0).Fingerprint
	st := r.tick(r.port, time.Minute)
	if st.LastFix != "switch-network" {
		t.Fatalf("plan: %s", st.LastFix)
	}
	st = r.tick(r.ok, 2*time.Minute) // same network, it just came back
	if st.Networks[home].Fixes[PortBlock] != "" || len(st.Networks[home].Recover[PortBlock]) != 1 {
		t.Fatalf("a blip that cleared itself was credited to switch-network: %+v", st.Networks[home])
	}
	r.tick(r.port, time.Minute)
	other := r.ok
	other.GatewayMAC, other.PublicIP = "02:00:00:00:00:01", "198.51.100.7"
	st = r.tick(other, 2*time.Minute) // the person really moved
	if st.Networks[home].Fixes[PortBlock] != "switch-network" {
		t.Fatalf("leaving the network is what fixed it: %+v", st.Networks[home])
	}
}

func TestUsualBlipsStayQuietUnlessTheyLastLonger(t *testing.T) {
	r := newAdaptiveRig(t)
	r.tick(r.ok, 0)
	for range 3 {
		r.blip(r.port, 2*time.Minute)
	}
	if n := countNotes(r.fx.notes, "Argo: PORT_BLOCK"); n != 3 {
		t.Fatalf("while Argo is still learning, each one is announced: %d %v", n, r.fx.notes)
	}
	r.fx.notes = nil

	// The fourth looks like the others: no text, and the advice says so.
	st := r.tick(r.port, time.Minute)
	if len(r.fx.notes) != 0 {
		t.Fatalf("a usual blip was announced: %v", r.fx.notes)
	}
	if st.LastFix != "usual-blip" {
		t.Fatalf("first advice: %s", st.LastFix)
	}
	r.tick(r.ok, 2*time.Minute)
	if len(r.fx.notes) != 0 {
		t.Fatalf("a quiet blip's recovery was announced: %v", r.fx.notes)
	}

	// The fifth outlasts what this network usually does: one text, then one on recovery.
	r.tick(r.port, time.Minute)
	r.tick(r.port, time.Minute)
	if len(r.fx.notes) != 0 {
		t.Fatalf("announced before the usual recovery time passed: %v", r.fx.notes)
	}
	r.tick(r.port, 2*time.Minute)
	if len(r.fx.notes) != 1 || r.fx.notes[0] != "Argo: PORT_BLOCK" {
		t.Fatalf("a longer-than-usual outage must be announced once: %v", r.fx.notes)
	}
	r.tick(r.port, time.Minute)
	r.tick(r.ok, time.Minute)
	if len(r.fx.notes) != 2 || r.fx.notes[1] != "Argo: recovered" {
		t.Fatalf("its recovery should be announced too: %v", r.fx.notes)
	}
}

func TestOfflineRecoveryAnnouncedOnlyAfterALongOutage(t *testing.T) {
	r := newAdaptiveRig(t)
	r.tick(r.ok, 0)
	r.blip(r.offln, 3*time.Minute)
	if len(r.fx.notes) != 0 {
		t.Fatalf("a 3-minute hotspot drop sent: %v", r.fx.notes)
	}
	r.blip(r.offln, 40*time.Minute)
	if len(r.fx.notes) != 1 || r.fx.notes[0] != "Argo: recovered" {
		t.Fatalf("back after 40 minutes is worth saying: %v", r.fx.notes)
	}
}

func TestNoEscalationWithinTheUsualRecoveryTime(t *testing.T) {
	r := newAdaptiveRig(t)
	r.tick(r.ok, 0)
	for range 3 {
		r.blip(r.port, 20*time.Minute) // this network's PORT_BLOCK takes ~20 min to clear
	}
	r.fx.notes = nil
	var st State
	for range maxAttempts + 1 {
		st = r.tick(r.port, 3*time.Minute) // attempts pile up faster than the network recovers
	}
	if !st.BreakerUntil.IsZero() || countNotes(r.fx.notes, "Argo needs you") != 0 {
		t.Fatalf("escalated inside the usual recovery time: breaker=%v notes=%v", st.BreakerUntil, r.fx.notes)
	}
}
