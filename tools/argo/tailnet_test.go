package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestParseTailscalePing(t *testing.T) {
	cases := []struct {
		out string
		ms  int
		via string
		ok  bool
	}{
		{"pong from judith (100.64.0.1) via DERP(sin) in 123ms\n", 123, "relay", true},
		{"pong from judith (100.64.0.1) via 203.0.113.5:41641 in 12.4ms\n", 12, "direct", true},
		{"pong from judith (100.64.0.1) via [2001:db8::1]:41641 in 0.3ms\n", 1, "direct", true},
		{"timeout waiting for ping reply\n", -1, "", false},
		{"", -1, "", false},
	}
	for _, c := range cases {
		ms, via, ok := parseTailscalePing(c.out)
		if ms != c.ms || via != c.via || ok != c.ok {
			t.Errorf("%q → %d %q %v, want %d %q %v", c.out, ms, via, ok, c.ms, c.via, c.ok)
		}
	}
}

func TestParseNetcheck(t *testing.T) {
	out := `{"UDP":true,"IPv4":true,"PreferredDERP":3,"RegionLatency":{"1":268278417,"3":41500000,"10":175452042}}`
	if r, ms := parseNetcheck(out); r != 3 || ms != 41 {
		t.Fatalf("region %d ms %d, want 3 41", r, ms)
	}
	if r, ms := parseNetcheck(`{"PreferredDERP":0}`); r != 0 || ms != -1 {
		t.Fatalf("no DERP: %d %d", r, ms)
	}
	if r, ms := parseNetcheck(`{"PreferredDERP":7,"RegionLatency":{}}`); r != 7 || ms != -1 {
		t.Fatalf("missing latency: %d %d", r, ms)
	}
	if r, ms := parseNetcheck("not json"); r != 0 || ms != -1 {
		t.Fatalf("junk: %d %d", r, ms)
	}
}

// tsFakeRunner records every command and answers from a script; the clock is fake too.
type tsFakeRunner struct {
	calls []string
	ping  string
	pingE error
	nc    string
	ncE   error
	now   time.Time
}

func (f *tsFakeRunner) run(_ context.Context, name string, args ...string) (string, error) {
	f.calls = append(f.calls, name+" "+strings.Join(args, " "))
	f.now = f.now.Add(250 * time.Millisecond)
	if len(args) > 0 && args[0] == "ping" {
		return f.ping, f.pingE
	}
	return f.nc, f.ncE
}

func (f *tsFakeRunner) clock() time.Time { return f.now }

func TestKickTailnetWithFakeRunner(t *testing.T) {
	t0 := time.Date(2026, 11, 5, 11, 25, 0, 0, time.UTC)
	cli := "/usr/local/bin/tailscale"

	// The hub answers: one ping, no netcheck, the path and time recorded.
	f := &tsFakeRunner{ping: "pong from gauss-hub (100.64.0.9) via DERP(sin) in 87ms\n", now: t0}
	c := kickTailnet(context.Background(), f.run, cli, "gauss-hub", f.clock)
	if !c.Answered() || c.Ms != 87 || c.Via != "relay" || c.Peer != "gauss-hub" || c.TookMs != 250 || c.Err != "" {
		t.Fatalf("answered: %+v", c)
	}
	if len(f.calls) != 1 || f.calls[0] != cli+" ping --c 1 --timeout 3s gauss-hub" {
		t.Fatalf("calls = %v", f.calls)
	}

	// The hub is silent: netcheck says which relay is near; deliveries fall back to the outbox.
	f = &tsFakeRunner{ping: "timeout waiting for ping reply\n", pingE: errors.New("exit status 1"),
		nc: `{"PreferredDERP":3,"RegionLatency":{"3":41500000}}`, now: t0}
	c = kickTailnet(context.Background(), f.run, cli, "gauss-hub", f.clock)
	if c.Answered() || c.Ms != -1 || c.DERPRegion != 3 || c.DERPMs != 41 || c.TookMs != 500 || !strings.HasPrefix(c.Err, "ping: timeout") {
		t.Fatalf("silent: %+v", c)
	}
	if len(f.calls) != 2 || f.calls[1] != cli+" netcheck --format=json" {
		t.Fatalf("calls = %v", f.calls)
	}

	// No hub configured: netcheck only.
	f = &tsFakeRunner{nc: `{"PreferredDERP":3,"RegionLatency":{"3":41500000}}`, now: t0}
	c = kickTailnet(context.Background(), f.run, cli, "", f.clock)
	if c.Answered() || c.Peer != "" || c.DERPMs != 41 || len(f.calls) != 1 || c.Err != "" {
		t.Fatalf("no hub: %+v calls %v", c, f.calls)
	}

	// Everything fails: both errors kept (masked), nothing panics.
	f = &tsFakeRunner{pingE: errors.New("tailscale: not running"), ncE: errors.New("exit status 1"), now: t0}
	c = kickTailnet(context.Background(), f.run, cli, "gauss-hub", f.clock)
	if c.Answered() || c.DERPMs != -1 || !strings.Contains(c.Err, "netcheck") || !strings.Contains(c.Err, "ping") {
		t.Fatalf("all failed: %+v", c)
	}
}

func TestHubHost(t *testing.T) {
	for in, want := range map[string]string{
		"": "", "http://127.0.0.1:3001": "", "http://100.73.232.74:3001": "100.73.232.74",
		"https://judith.tail1234.ts.net": "judith.tail1234.ts.net", "https://evil.example": "",
	} {
		if got := hubHost(Config{GaussURL: in}); got != want {
			t.Errorf("hubHost(%q) = %q, want %q", in, got, want)
		}
	}
}

// A network change records the switch with the tailnet's answer; a silent hub means
// store-and-forward; the record stays until the next change.
func TestTickRecordsSwitchAndStoreForward(t *testing.T) {
	a := fixture(t, "my_sim_ok.json")
	a.GatewayMAC, a.PublicIP = "aa:bb:cc:dd:ee:01", "203.0.113.9"
	b := a
	b.GatewayMAC, b.PublicIP, b.Gateway = "aa:bb:cc:dd:ee:02", "198.51.100.7", "192.168.0.1"
	l, fx := newLoop(t, a, a, b, b)
	answers := []TailnetCheck{{Ms: 87, Via: "relay", Peer: "hub"}, {Ms: -1, Peer: "hub", DERPRegion: 3, DERPMs: 41}}
	var kicks int
	l.Tailnet = func(context.Context) TailnetCheck {
		c := answers[min(kicks, len(answers)-1)]
		kicks++
		c.At = fx.now
		return c
	}
	st := l.Tick(context.Background()) // first sight of network a: a switch from nothing
	if kicks != 1 || st.Switch == nil || st.Switch.To != Fingerprint(a.GatewayMAC, a.PublicIP) || st.Switch.From != "" || st.Switch.StoreForward {
		t.Fatalf("first tick: kicks %d switch %+v", kicks, st.Switch)
	}
	if got := linkReport(nil, st, fx.now); got.TailnetMs != 87 || got.TailnetVia != "relay" {
		t.Fatalf("link report = %+v", got)
	}
	fx.now = fx.now.Add(time.Minute)
	st = l.Tick(context.Background()) // same network: no kick, record kept
	if kicks != 1 || st.Switch == nil || st.Switch.Tailnet.Ms != 87 {
		t.Fatalf("same network: kicks %d switch %+v", kicks, st.Switch)
	}
	fx.now = fx.now.Add(time.Minute)
	st = l.Tick(context.Background()) // network b: the hub is silent
	if kicks != 2 || st.Switch.From != Fingerprint(a.GatewayMAC, a.PublicIP) || st.Switch.To != Fingerprint(b.GatewayMAC, b.PublicIP) || !st.Switch.StoreForward {
		t.Fatalf("switch to b: kicks %d switch %+v", kicks, st.Switch)
	}
	if got := linkReport(nil, st, fx.now); got.TailnetMs != -1 || got.TailnetVia != "" {
		t.Fatalf("link report after a silent hub = %+v", got)
	}
	line := switchLine(st, fx.now.Add(90*time.Second))
	if !strings.Contains(line, "switch 1m30s ago") || !strings.Contains(line, "hub silent, relay 41ms: store-and-forward") {
		t.Fatalf("status line: %q", line)
	}
	if switchLine(State{}, fx.now) != "" {
		t.Fatal("status line without a switch should be empty")
	}
	// A recovery on the same network asks again (the tailnet may have broken during the outage).
	down := Snapshot{Online: false}
	l2, fx2 := newLoop(t, b, down, down, b)
	l2.Store = l.Store
	k2 := 0
	l2.Tailnet = func(context.Context) TailnetCheck { k2++; return TailnetCheck{Ms: 30, Via: "direct", Peer: "hub"} }
	fx2.now = fx.now.Add(2 * time.Minute)
	l2.Tick(context.Background()) // b again, no change: no kick
	fx2.now = fx2.now.Add(time.Minute)
	l2.Tick(context.Background()) // OFFLINE
	fx2.now = fx2.now.Add(time.Minute)
	st = l2.Tick(context.Background()) // back
	if k2 != 1 || st.Switch == nil || st.Switch.From != "" || st.Switch.Tailnet.Ms != 30 || st.Switch.StoreForward {
		t.Fatalf("recovery: kicks %d switch %+v", k2, st.Switch)
	}
}
