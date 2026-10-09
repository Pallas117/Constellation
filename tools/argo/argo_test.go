package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func fixture(t *testing.T, name string) Snapshot {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var s Snapshot
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return s
}

func text(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestClassifyEveryFailureClass(t *testing.T) {
	cases := map[string]Class{
		"offline.json":                   Offline,
		"captive_portal.json":            Captive, // portal wins over the TLS error it causes
		"dns_fail.json":                  DNS,
		"econnrefused_env_proxy.json":    DeadProxy,
		"econnrefused_stale_daemon.json": StaleDaemon,
		"tls_intercept.json":             TLSIntercept,
		"port_block.json":                PortBlock,
		"hk_esim_403.json":               Region,
		"wpad_on.json":                   WPADRisk,
		"my_sim_ok.json":                 OK, // claude.ai's 403 to non-browsers must not count as REGION
		"sg_exit_ok.json":                OK,
	}
	for file, want := range cases {
		got, reason := Classify(fixture(t, file))
		if got != want {
			t.Errorf("%s: got %s (%s), want %s", file, got, reason, want)
		}
	}
}

func TestRegionByLocWithoutA403(t *testing.T) {
	s := fixture(t, "my_sim_ok.json")
	s.Loc = "HK"
	if c, _ := Classify(s); c != Region {
		t.Fatalf("loc=HK with API 405 should be REGION, got %s", c)
	}
}

func TestRegionBy403WhenTraceFails(t *testing.T) {
	s := fixture(t, "hk_esim_403.json")
	s.Loc = "" // Cloudflare trace blocked or timed out
	if c, _ := Classify(s); c != Region {
		t.Fatalf("API 403 alone should be REGION, got %s", c)
	}
}

func TestStaleProcCommandNeverIncludesEnv(t *testing.T) {
	ps := "900 /Users/x/.local/bin/claude ANTHROPIC_API_KEY=sk-ant-secret HTTPS_PROXY=http://127.0.0.1:4000\n"
	got := findStaleProcs(ps, func(string) bool { return false })
	if len(got) != 1 || got[0].Command != "/Users/x/.local/bin/claude" {
		t.Fatalf("%+v", got)
	}
}

func TestParseRecordedCommandOutput(t *testing.T) {
	if gw, ok := parseDefaultRoute(text(t, "route_default.txt")); !ok || gw != "192.168.1.254" {
		t.Errorf("route: %q %v", gw, ok)
	}
	if mac := parseARP("? (192.168.1.254) at 24:2f:d0:c5:e6:9e on en0 ifscope [ethernet]"); mac != "24:2f:d0:c5:e6:9e" {
		t.Errorf("arp: %q", mac)
	}
	sc := text(t, "scutil_proxy.txt")
	if wpad, pac := parseScutilAuto(sc); !wpad || pac {
		t.Errorf("scutil auto: wpad=%v pac=%v", wpad, pac)
	}
	if ps := parseScutilProxies(sc); len(ps) != 1 || ps[0].URL != "http://127.0.0.1:4000" {
		t.Errorf("scutil proxies: %+v", ps)
	}
	if ip, loc := parseTrace("fl=1\nip=180.188.170.58\nloc=hk\nwarp=off\n"); ip != "180.188.170.58" || loc != "HK" {
		t.Errorf("trace: %s %s", ip, loc)
	}
}

func TestFindStaleProcsFromRealPsOutput(t *testing.T) {
	dead := func(string) bool { return false }
	got := findStaleProcs(text(t, "ps_env.txt"), dead)
	pids := map[int]bool{}
	for _, p := range got {
		pids[p.PID] = true
	}
	for _, want := range []int{7036, 27950, 8167} {
		if !pids[want] {
			t.Errorf("pid %d should be flagged: %+v", want, got)
		}
	}
	if pids[31142] || pids[512] || pids[640] {
		t.Errorf("clean claude, non-claude, and non-loopback proxies must not be flagged: %+v", got)
	}
	if live := findStaleProcs(text(t, "ps_env.txt"), func(string) bool { return true }); len(live) != 0 {
		t.Errorf("a live proxy is not stale: %+v", live)
	}
}

func TestTailscaleExitCandidatesAreAllowListedOnly(t *testing.T) {
	allow := map[string]string{"exit-sg-1": "SG", "exit-my-1": "MY", "exit-hk-1": "HK"}
	ts := parseTailscale(text(t, "tailscale_status.json"), allow)
	if !ts.Running || ts.ExitNode != "exit-sg-1" {
		t.Fatalf("%+v", ts)
	}
	// HK is never offered; exit-my-1 is offline.
	if len(ts.ExitCandidates) != 1 || ts.ExitCandidates[0] != "exit-sg-1" {
		t.Fatalf("candidates: %v", ts.ExitCandidates)
	}
	if none := parseTailscale(text(t, "tailscale_status.json"), nil); len(none.ExitCandidates) != 0 {
		t.Fatalf("unconfigured nodes must not be trusted: %v", none.ExitCandidates)
	}
}

func TestPlanNeverAutomatesAdminOrTailscale(t *testing.T) {
	for _, f := range []string{"dns_fail.json", "econnrefused_env_proxy.json", "wpad_on.json", "port_block.json", "hk_esim_403.json", "econnrefused_stale_daemon.json", "tls_intercept.json"} {
		s := fixture(t, f)
		c, _ := Classify(s)
		for _, a := range Plan(c, s, "") {
			if a.Auto && (a.Admin || strings.Contains(a.Command, "sudo") || strings.Contains(a.Command, "tailscale")) {
				t.Errorf("%s: %s must not be automatic", f, a.ID)
			}
			if strings.Contains(a.Command, "insecure") || strings.Contains(a.Command, "NODE_TLS_REJECT_UNAUTHORIZED") {
				t.Errorf("%s: %s weakens TLS", f, a.ID)
			}
		}
	}
}

func TestPlanPutsRememberedFixFirst(t *testing.T) {
	s := fixture(t, "port_block.json")
	if p := Plan(PortBlock, s, "switch-network"); p[0].ID != "switch-network" {
		t.Fatalf("remembered fix not first: %v", ids(p))
	}
	if p := Plan(PortBlock, s, ""); p[0].ID != "exit-node" {
		t.Fatalf("default order changed: %v", ids(p))
	}
}

func TestMaskHidesSecrets(t *testing.T) {
	in := `ANTHROPIC_API_KEY=sk-ant-123 "token": "abc" password=hunter2 http://u:p@proxy:8080 loc=MY`
	out := Mask(in)
	for _, leak := range []string{"sk-ant-123", "abc", "hunter2", "u:p@"} {
		if strings.Contains(out, leak) {
			t.Errorf("leaked %q in %q", leak, out)
		}
	}
	if !strings.Contains(out, "loc=MY") {
		t.Errorf("over-masked: %q", out)
	}
}

func TestFingerprintHashesAndGroupsByPrefix(t *testing.T) {
	a := Fingerprint("24:2f:d0:c5:e6:9e", "180.188.170.58")
	if a != Fingerprint("24:2f:d0:c5:e6:9e", "180.188.170.200") {
		t.Error("same /24 on the same gateway should match")
	}
	if a == Fingerprint("24:2f:d0:c5:e6:9e", "180.188.171.58") {
		t.Error("different prefix should differ")
	}
	if strings.Contains(a, "180") || len(a) != 12 {
		t.Errorf("fingerprint should be an opaque hash: %q", a)
	}
}

func TestTailnetOnly(t *testing.T) {
	for _, ok := range []string{"http://100.73.232.74:3001", "https://judith.tail1234.ts.net"} {
		if _, err := tailnetOnly(ok); err != nil {
			t.Errorf("%s rejected: %v", ok, err)
		}
	}
	for _, bad := range []string{"https://evil.example", "http://192.168.1.10:3001", "http://100.128.0.1"} {
		if _, err := tailnetOnly(bad); err == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

// ---- loop: fake prober and effects ----

type seqProber struct{ snaps []Snapshot }

func (p *seqProber) Probe(context.Context) Snapshot {
	s := p.snaps[0]
	if len(p.snaps) > 1 {
		p.snaps = p.snaps[1:]
	}
	return s
}

type fakeFx struct {
	now     time.Time
	notes   []string
	opened  []string
	openErr error
}

func (f *fakeFx) Notify(title, msg string) { f.notes = append(f.notes, title) }
func (f *fakeFx) Open(u string) error      { f.opened = append(f.opened, u); return f.openErr }
func (f *fakeFx) Sleep(time.Duration)      {}
func (f *fakeFx) Now() time.Time           { return f.now }

func newLoop(t *testing.T, snaps ...Snapshot) (Loop, *fakeFx) {
	fx := &fakeFx{now: time.Date(2026, 10, 9, 8, 0, 0, 0, time.UTC)}
	return Loop{Prober: &seqProber{snaps: snaps}, Store: Store{Dir: t.TempDir()}, Fx: fx}, fx
}

func TestLoopCaptiveAutoOpensVerifiesAndRemembers(t *testing.T) {
	portal := fixture(t, "captive_portal.json")
	portal.GatewayMAC, portal.PublicIP = "aa:bb:cc:dd:ee:ff", "203.0.113.9"
	ok := fixture(t, "my_sim_ok.json")
	ok.GatewayMAC, ok.PublicIP = portal.GatewayMAC, portal.PublicIP
	l, fx := newLoop(t, portal, portal, ok) // probe, settle re-probe, verify

	st := l.Tick(context.Background())
	if len(fx.opened) != 1 || fx.opened[0] != "http://captive.apple.com" {
		t.Fatalf("portal not opened: %v", fx.opened)
	}
	if st.Class != OK || st.Networks[st.Fingerprint].Fixes[Captive] != "open-portal" {
		t.Fatalf("fix not verified/remembered: %+v", st)
	}
	var events []string
	for _, in := range l.Store.Incidents() {
		events = append(events, in.Event)
	}
	if strings.Join(events, ",") != "open,attempt,resolved" {
		t.Fatalf("incidents: %v", events)
	}
}

func TestLoopNotifiesOnlyOnClassChange(t *testing.T) {
	hk := fixture(t, "hk_esim_403.json")
	l, fx := newLoop(t, hk)
	for i := 0; i < 3; i++ {
		l.Tick(context.Background())
		fx.now = fx.now.Add(time.Hour) // past any backoff
	}
	n := 0
	for _, s := range fx.notes {
		if s == "Argo: REGION" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("REGION notified %d times: %v", n, fx.notes)
	}
}

func TestLoopBackoffAndCircuitBreaker(t *testing.T) {
	l, fx := newLoop(t, fixture(t, "port_block.json"))
	ctx := context.Background()
	st := l.Tick(ctx)
	if st.Attempts != 1 {
		t.Fatalf("attempts=%d", st.Attempts)
	}
	fx.now = fx.now.Add(30 * time.Second) // inside the 60s backoff
	if st = l.Tick(ctx); st.Attempts != 1 {
		t.Fatalf("backoff ignored: attempts=%d", st.Attempts)
	}
	for i := 0; i < maxAttempts; i++ {
		fx.now = fx.now.Add(backoffMax)
		st = l.Tick(ctx)
	}
	if !st.BreakerUntil.After(fx.now) {
		t.Fatalf("breaker should be open: %+v", st)
	}
	if fx.notes[len(fx.notes)-1] != "Argo needs you" {
		t.Fatalf("no escalation: %v", fx.notes)
	}
}

func TestLoopUserFixCreditedOnRecovery(t *testing.T) {
	stale := fixture(t, "econnrefused_stale_daemon.json")
	ok := fixture(t, "my_sim_ok.json")
	l, fx := newLoop(t, stale, stale, ok)
	l.Tick(context.Background())
	fx.now = fx.now.Add(5 * time.Minute)
	st := l.Tick(context.Background())
	if st.Class != OK || st.Networks[st.Fingerprint].Fixes[StaleDaemon] != "restart-daemon" {
		t.Fatalf("%+v", st.Networks)
	}
}

func TestStatusLine(t *testing.T) {
	now := time.Now()
	st := State{Class: Region, Loc: "HK", CheckedAt: now, Tailscale: Tailscale{Running: true}}
	if got := statusLine(st, now); got != "▲ REGION HK ts:on" {
		t.Errorf("%q", got)
	}
	st = State{Class: OK, Loc: "MY", CheckedAt: now.Add(-time.Hour), Tailscale: Tailscale{Running: true, ExitNode: "exit-sg-1"}}
	if got := statusLine(st, now); got != "● OK MY ts:exit-sg-1 (stale 1h0m0s)" {
		t.Errorf("%q", got)
	}
}

func TestNetworkSwitchBlipIsNotAnIncident(t *testing.T) {
	// Leaving Pitaya for the hotspot: the first probe lands mid-switch.
	l, fx := newLoop(t, fixture(t, "offline.json"), fixture(t, "my_sim_ok.json"))
	st := l.Tick(context.Background())
	if st.Class != OK || len(fx.notes) != 0 || len(l.Store.Incidents()) != 0 {
		t.Fatalf("blip became an incident: class=%s notes=%v incidents=%v", st.Class, fx.notes, l.Store.Incidents())
	}
}

func TestHotspotOnWrongSIMAlertsOnce(t *testing.T) {
	// Phone's data line flipped to the HK eSIM: persists past the settle check.
	ok, hk := fixture(t, "my_sim_ok.json"), fixture(t, "hk_esim_403.json")
	l, fx := newLoop(t, ok, hk, hk)
	l.Tick(context.Background())
	fx.now = fx.now.Add(5 * time.Minute)
	st := l.Tick(context.Background())
	if st.Class != Region || len(fx.notes) != 1 || fx.notes[0] != "Argo: REGION" {
		t.Fatalf("class=%s notes=%v", st.Class, fx.notes)
	}
}
