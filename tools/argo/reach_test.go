package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"net"
	"strings"
	"testing"
	"time"
)

// fakeNet is the 2026-11-18 dorm network: everything resolves; GSFC's addresses never answer.
type fakeNet struct {
	dns      map[string][]string
	dead     map[string]bool // ip → no TCP answer
	tlsErr   map[string]error
	anchorUp bool
}

func (f fakeNet) reacher() reacher {
	return reacher{
		lookup: func(_ context.Context, h string) ([]string, error) {
			if a, ok := f.dns[h]; ok {
				return a, nil
			}
			return nil, &net.DNSError{Err: "no such host", Name: h, IsNotFound: true}
		},
		dial: func(_ context.Context, addr string) (net.Conn, error) {
			ip, _, _ := net.SplitHostPort(addr)
			if f.dead[ip] {
				return nil, errors.New("dial tcp " + addr + ": i/o timeout")
			}
			return fakeConn{}, nil
		},
		handshake: func(_ context.Context, _ net.Conn, host string) error { return f.tlsErr[host] },
		anchors:   func(context.Context) bool { return f.anchorUp },
	}
}

func dorm() fakeNet {
	return fakeNet{
		dns: map[string][]string{
			"api.anthropic.com":      {"160.79.104.10"},
			"services.swpc.noaa.gov": {"140.172.17.100"},
			"iswa.gsfc.nasa.gov":     {"169.154.154.65"},
			"cdaweb.gsfc.nasa.gov":   {"169.154.198.69"},
		},
		dead:     map[string]bool{"169.154.154.65": true, "169.154.198.69": true},
		tlsErr:   map[string]error{},
		anchorUp: true,
	}
}

func verdicts(rs []HostReach) map[string]string {
	m := map[string]string{}
	for _, r := range rs {
		m[r.Host] = r.Verdict
	}
	return m
}

func TestReachFindsThePerHostBlock(t *testing.T) {
	targets, err := reachTargets(nil, "")
	if err != nil {
		t.Fatal(err)
	}
	rs := dorm().reacher().reach(context.Background(), targets)
	v := verdicts(rs)
	want := map[string]string{
		"api.anthropic.com:443": ReachOK, "services.swpc.noaa.gov:443": ReachOK,
		"iswa.gsfc.nasa.gov:443": ReachBlocked, "cdaweb.gsfc.nasa.gov:443": ReachBlocked,
	}
	for h, w := range want {
		if v[h] != w {
			t.Errorf("%s: %s, want %s", h, v[h], w)
		}
	}
	var out bytes.Buffer
	if bad := printReach(&out, rs, nil, false); bad != 2 {
		t.Fatalf("bad = %d", bad)
	}
	s := out.String()
	for _, w := range []string{"iswa.gsfc.nasa.gov resolves but no address answers", "2 other host(s) work", "iPhone hotspot", "Argo can't fix that here"} {
		if !strings.Contains(s, w) {
			t.Errorf("report lacks %q:\n%s", w, s)
		}
	}
	// On the hotspot already, the hotspot is not the advice.
	out.Reset()
	printReach(&out, rs, nil, true)
	if strings.Contains(out.String(), "over the iPhone hotspot") {
		t.Fatalf("hotspot advice on the hotspot:\n%s", out.String())
	}
}

func TestReachDeadUplinkIsNotAHostBlock(t *testing.T) {
	f := dorm()
	f.anchorUp = false
	for _, ips := range f.dns {
		f.dead[ips[0]] = true
	}
	rs := f.reacher().reach(context.Background(), []string{"iswa.gsfc.nasa.gov:443", "services.swpc.noaa.gov:443"})
	for _, r := range rs {
		if r.Verdict != ReachUplink {
			t.Fatalf("%s: %s, want uplink_down", r.Host, r.Verdict)
		}
	}
	n := Net{}
	rememberBlocks(&n, rs, time.Now())
	if len(n.BlockedHosts) != 0 {
		t.Fatalf("a dead uplink says nothing about a host: %v", n.BlockedHosts)
	}
}

func TestReachTLSVerdicts(t *testing.T) {
	f := dorm()
	f.tlsErr["api.anthropic.com"] = x509.UnknownAuthorityError{}
	f.tlsErr["services.swpc.noaa.gov"] = errors.New("connection reset by peer")
	v := verdicts(f.reacher().reach(context.Background(), []string{"api.anthropic.com:443", "services.swpc.noaa.gov:443", "services.swpc.noaa.gov:80"}))
	if v["api.anthropic.com:443"] != ReachUntrusted || v["services.swpc.noaa.gov:443"] != ReachTLS || v["services.swpc.noaa.gov:80"] != ReachOK {
		t.Fatalf("%v", v)
	}
}

func TestReachDNSAndManyAddresses(t *testing.T) {
	f := dorm()
	f.dns["multi.example.org"] = []string{"192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4", "192.0.2.5", "192.0.2.6"}
	f.dead["192.0.2.1"], f.dead["192.0.2.2"] = true, true // the first answering address decides
	rs := f.reacher().reach(context.Background(), []string{"nope.example.org:443", "multi.example.org:443"})
	v := verdicts(rs)
	if v["nope.example.org:443"] != ReachDNS || v["multi.example.org:443"] != ReachOK {
		t.Fatalf("%v", v)
	}
	if rs[1].Addrs != 6 {
		t.Fatalf("addrs %d", rs[1].Addrs)
	}
}

func TestReachTargetsAreValidated(t *testing.T) {
	for _, bad := range []string{"https://iswa.gsfc.nasa.gov", "iswa.gsfc.nasa.gov/path", "a b", "host:0", "host:99999", "host:08", "-x.org", "user@host", "..", strings.Repeat("a.", 130) + "org"} {
		if _, err := reachTargets([]string{bad}, ""); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	got, err := reachTargets([]string{"ISWA.gsfc.nasa.gov", "iswa.gsfc.nasa.gov:443", "cdaweb.gsfc.nasa.gov:80", "192.0.2.7"}, "")
	if err != nil || strings.Join(got, ",") != "iswa.gsfc.nasa.gov:443,cdaweb.gsfc.nasa.gov:80,192.0.2.7:443" {
		t.Fatalf("%v %v", got, err)
	}
	if got, _ := reachTargets(nil, " a.org , b.org:8443 "); strings.Join(got, ",") != "a.org:443,b.org:8443" {
		t.Fatalf("env list: %v", got)
	}
	many := make([]string, reachMaxHosts+1)
	for i := range many {
		many[i] = "h" + string(rune('a'+i)) + ".org"
	}
	if _, err := reachTargets(many, ""); err == nil {
		t.Fatal("no cap on hosts")
	}
}

func TestRememberBlocksPerNetwork(t *testing.T) {
	now := time.Date(2026, 11, 18, 10, 30, 0, 0, time.UTC)
	n := Net{}
	rememberBlocks(&n, []HostReach{{Host: "iswa.gsfc.nasa.gov:443", Verdict: ReachBlocked}, {Host: "a.org:443", Verdict: ReachOK}}, now)
	if _, ok := n.BlockedHosts["iswa.gsfc.nasa.gov:443"]; !ok || len(n.BlockedHosts) != 1 {
		t.Fatalf("%v", n.BlockedHosts)
	}
	var out bytes.Buffer
	printReach(&out, []HostReach{{Host: "a.org:443", Verdict: ReachOK}}, n.BlockedHosts, false)
	if !strings.Contains(out.String(), "Seen blocked on this network before: iswa.gsfc.nasa.gov:443") {
		t.Fatalf("%s", out.String())
	}
	rememberBlocks(&n, []HostReach{{Host: "iswa.gsfc.nasa.gov:443", Verdict: ReachOK}}, now.Add(time.Hour))
	if n.BlockedHosts != nil {
		t.Fatalf("an answering host stays blocked: %v", n.BlockedHosts)
	}
	for i := range keepBlockedHosts + 5 {
		rememberBlocks(&n, []HostReach{{Host: "h" + string(rune('A'+i)) + ".org:443", Verdict: ReachBlocked}}, now.Add(time.Duration(i)*time.Minute))
	}
	if len(n.BlockedHosts) != keepBlockedHosts {
		t.Fatalf("cap: %d", len(n.BlockedHosts))
	}
	rememberBlocks(&n, nil, now.Add(blockedHostTTL+2*time.Hour))
	if n.BlockedHosts != nil {
		t.Fatalf("entries never expire: %d", len(n.BlockedHosts))
	}
}
