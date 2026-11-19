package main

import (
	"context"
	"errors"
	"net"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// deadUplink is the 2026-11-18 dorm night (GAU-247): associated, gateway up, both lookups
// time out, and no anchor answers by IP (mesh-heal's https://1.1.1.1 check failed 306 of 307 runs).
func deadUplink(ok Snapshot) Snapshot {
	s := ok
	s.PublicIP, s.Loc = "", ""
	s.DNS = Result{Err: ErrDNS, Detail: "lookup api.anthropic.com: i/o timeout"}
	s.API = Result{Err: ErrDNS, Detail: "lookup api.anthropic.com: i/o timeout"}
	s.Captive = Result{Err: ErrDNS, Detail: "lookup captive.apple.com: i/o timeout"}
	s.DNSDirectOK, s.IPUp = false, boolPtr(false)
	return s
}

func TestDeadUplinkIsNotDNS(t *testing.T) {
	ok := Snapshot{Online: true, Gateway: "192.168.88.1", Tailscale: Tailscale{Running: true, ExitCandidates: []string{"sg-exit"}}}
	dead := deadUplink(ok)
	dnsOnly := dead
	dnsOnly.IPUp = boolPtr(true) // IP gets out: the network's resolver is what's broken
	unmeasured := dead
	unmeasured.IPUp = nil // older fixtures and probes: classification unchanged
	magic := dead
	magic.DNSDirectOK, magic.IPUp = true, nil

	c, why := Classify(dead)
	if c != PortBlock || !strings.Contains(why, "uplink stalled") {
		t.Fatalf("dead uplink: %s %q", c, why)
	}
	plan := Plan(c, dead, "")
	if ids := ids(plan); slices.Contains(ids, "flush-dns") || slices.Contains(ids, "exit-node") || ids[0] != "switch-network" {
		t.Fatalf("a dead uplink needs another network, not DNS or exit-node steps: %v", ids)
	}
	if say := firstSay(plan); !strings.Contains(say, "hotspot") || !strings.Contains(say, "not DNS") {
		t.Fatalf("advice: %q", say)
	}
	for name, s := range map[string]Snapshot{"dns-only": dnsOnly, "unmeasured": unmeasured, "magicdns": magic} {
		if c, _ := Classify(s); c != DNS {
			t.Errorf("%s: %s, want DNS", name, c)
		}
	}
	// An exit node still helps when only Claude is dropped and the uplink works.
	onlyClaude := Snapshot{Online: true, Loc: "MY", Gateway: "192.168.88.1", API: Result{Err: ErrTimeout},
		Captive: Result{OK: true, Status: 200}, Tailscale: ok.Tailscale}
	if p := Plan(PortBlock, onlyClaude, ""); p[0].ID != "exit-node" {
		t.Fatalf("exit node dropped where it helps: %v", ids(p))
	}
}

type fakeConn struct{ net.Conn }

func (fakeConn) Close() error { return nil }

func TestIPReachableNeedsOnlyOneAnchor(t *testing.T) {
	var calls atomic.Int32
	none := func(context.Context, string) (net.Conn, error) { calls.Add(1); return nil, errors.New("i/o timeout") }
	if ipReachable(context.Background(), none) {
		t.Fatal("no anchor answered")
	}
	if int(calls.Load()) != len(ipAnchors) {
		t.Fatalf("dialled %d of %d anchors", calls.Load(), len(ipAnchors))
	}
	one := func(_ context.Context, a string) (net.Conn, error) {
		if a == "9.9.9.9:443" {
			return fakeConn{}, nil
		}
		return nil, errors.New("refused")
	}
	if !ipReachable(context.Background(), one) {
		t.Fatal("one anchor answering is enough")
	}
	for _, a := range ipAnchors {
		if h, _, err := net.SplitHostPort(a); err != nil || net.ParseIP(h) == nil {
			t.Fatalf("anchor %q must be an IP literal (no DNS involved)", a)
		}
	}
}

// Replays the shape of the 2026-11-18 night on the dorm network: 00:07-09:35, Argo checked about
// every 31 minutes (breaker cooldown), and the old build logged DNS with 22 flush-dns attempts.
func TestDormNightReplay(t *testing.T) {
	r := newAdaptiveRig(t)
	home := r.tick(r.ok, 0).Fingerprint
	dead := deadUplink(r.ok)
	r.tick(dead, time.Minute)
	for range 18 {
		r.tick(dead, 31*time.Minute)
	}
	st := r.tick(r.ok, 31*time.Minute)

	var escalations []string
	for _, in := range r.l.Store.Incidents() {
		if in.Class == DNS {
			t.Fatalf("a dead uplink was logged as DNS: %+v", in)
		}
		if slices.Contains(in.Actions, "flush-dns") {
			t.Fatalf("flush-dns suggested for a dead uplink: %+v", in)
		}
		if in.Event == "escalated" {
			escalations = append(escalations, in.Detail)
		}
	}
	if len(escalations) == 0 || !strings.Contains(escalations[0], "hotspot") || strings.HasSuffix(escalations[0], ":") {
		t.Fatalf("escalation should say what to do: %q", escalations)
	}
	if got := st.Networks[home].Recover; len(got[DNS]) != 0 || len(got[PortBlock]) != 1 {
		t.Fatalf("the outage must be learned as PORT_BLOCK on this network: %v", got)
	}
	if n := countNotes(r.fx.notes, "Argo needs you"); n > 6 {
		t.Fatalf("%d escalation texts in one night (at most one per %s)", n, escalateEvery)
	}
}

// The dorm network's DNS history still holds the 9.6 h night (34,451 s). A real DNS fault there
// must not be met with "usually recovers, nothing to do yet" for hours.
func TestUsualBlipNeverOutlastsQuietMax(t *testing.T) {
	r := newAdaptiveRig(t)
	home := r.tick(r.ok, 0).Fingerprint
	st := r.l.Store.Load()
	n := st.Networks[home]
	n.Recover = map[Class][]int{DNS: {409, 6363, 34451}}
	st.Networks[home] = n
	if err := r.l.Store.Save(st); err != nil {
		t.Fatal(err)
	}
	dnsOnly := deadUplink(r.ok)
	dnsOnly.IPUp = boolPtr(true)
	if got := r.tick(dnsOnly, time.Minute); got.Class != DNS || got.LastFix == "usual-blip" {
		t.Fatalf("p90 of 9.6 h made a DNS fault a usual blip: %s %s", got.Class, got.LastFix)
	}
}

func TestFirstSayNeverEndsOnAColon(t *testing.T) {
	s := Snapshot{Online: true, DNS: Result{Err: ErrDNS}}
	say := firstSay(Plan(DNS, s, ""))
	if strings.HasSuffix(say, ":") || !strings.Contains(say, "argo doctor") {
		t.Fatalf("%q", say)
	}
}
