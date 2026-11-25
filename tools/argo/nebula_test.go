package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
	"testing"
	"time"
)

var nebNow = time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)

// nebCertJSON is what `nebula-cert print -json` prints for one certificate: a JSON array. The shape follows
// cert/cert_v2.go marshalJSON at slackhq/nebula v1.12.0 (read 25 Nov 2026); it is UNVERIFIED against a real
// run because nebula is not installed on this Mac.
func nebCertJSON(name, network string, groups []string, notAfter time.Time, isCA bool) map[string]any {
	return map[string]any{
		"curve": "CURVE25519",
		"details": map[string]any{
			"groups": groups, "isCa": isCA, "issuer": strings.Repeat("ab", 32), "name": name,
			"networks": []string{network}, "notAfter": notAfter.Format(time.RFC3339), "notBefore": nebNow.Add(-24 * time.Hour).Format(time.RFC3339),
			"unsafeNetworks": []string{},
		},
		"fingerprint": strings.Repeat("cd", 32), "publicKey": strings.Repeat("ef", 32), "signature": strings.Repeat("01", 64), "version": 2,
	}
}

func nebPrint(certs ...map[string]any) string {
	b, _ := json.Marshal(certs)
	return string(b) + "\n"
}

type nebFake struct {
	files   map[string]bool
	print   string
	printEr error
	up, ok  bool
	addrs   map[netip.Addr]string
	calls   []string
}

func (f *nebFake) env() nebulaEnv {
	return nebulaEnv{
		run: func(_ context.Context, name string, args ...string) (string, error) {
			f.calls = append(f.calls, name+" "+strings.Join(args, " "))
			if strings.HasSuffix(name, "/nebula-cert") && len(args) > 0 && args[0] == "print" {
				return f.print, f.printEr
			}
			return "", errors.New("unexpected command")
		},
		exists: func(p string) bool { return f.files[p] },
		procUp: func(context.Context) (bool, bool) { return f.up, f.ok },
		addrs:  func() map[netip.Addr]string { return f.addrs },
		now:    nebNow,
	}
}

// healthy: Homebrew nebula on a Mac, running, overlay address on utun7, 29 days left.
func healthyNeb(days int) *nebFake {
	return &nebFake{
		files: map[string]bool{"/usr/local/libexec/lightbound/nebula": true, "/opt/homebrew/bin/nebula-cert": true, "/etc/nebula/host.crt": true},
		print: nebPrint(nebCertJSON("mac", "10.117.0.50/24", []string{"dev"}, nebNow.Add(time.Duration(days)*24*time.Hour+time.Hour), false)),
		up:    true, ok: true,
		addrs: map[netip.Addr]string{netip.MustParseAddr("10.117.0.50"): "utun7", netip.MustParseAddr("192.168.1.20"): "en0"},
	}
}

func TestNebulaStatusHealthy(t *testing.T) {
	f := healthyNeb(29)
	s := nebulaStatus(context.Background(), f.env())
	if s.Level != postureOK || !s.Installed || s.Running != "yes" || s.DaysLeft != 29 || s.Overlay != "10.117.0.50" || s.Iface != "utun7" {
		t.Fatalf("status = %+v", s)
	}
	if s.Cert == nil || s.Cert.Name != "mac" || strings.Join(s.Cert.Groups, ",") != "dev" {
		t.Fatalf("cert = %+v", s.Cert)
	}
	txt := nebulaText(s)
	for _, want := range []string{"nebula: up", "10.117.0.50", "29 days left", "groups dev"} {
		if !strings.Contains(txt, want) {
			t.Errorf("text lacks %q:\n%s", want, txt)
		}
	}
	var out bytes.Buffer
	if code, err := netCmd(context.Background(), []string{"status"}, f.env(), &out); code != 0 || err != nil {
		t.Fatalf("net status = %d, %v", code, err)
	}
}

func TestNebulaCertExpiresWithinSevenDaysWarns(t *testing.T) {
	for _, days := range []int{6, 1, 0} {
		f := healthyNeb(days)
		s := nebulaStatus(context.Background(), f.env())
		if s.Level != postureWarn {
			t.Fatalf("%d days: level %s, want warn (%+v)", days, s.Level, s.Findings)
		}
		if len(s.Findings) != 1 || !strings.Contains(s.Findings[0].Text, "expires in") || !strings.Contains(s.Findings[0].Fix, "sign.sh") {
			t.Fatalf("%d days: findings %+v", days, s.Findings)
		}
		var out bytes.Buffer
		if code, _ := netCmd(context.Background(), nil, f.env(), &out); code != 1 {
			t.Fatalf("%d days: exit %d, want 1 so scripts can act", days, code)
		}
	}
	// Seven full days and an hour is not "under 7 days".
	if s := nebulaStatus(context.Background(), healthyNeb(7).env()); s.Level != postureOK {
		t.Fatalf("7 days: level %s, want ok", s.Level)
	}
}

func TestNebulaExpiredFails(t *testing.T) {
	f := healthyNeb(0)
	f.print = nebPrint(nebCertJSON("mac", "10.117.0.50/24", []string{"dev"}, nebNow.Add(-2*time.Hour), false))
	s := nebulaStatus(context.Background(), f.env())
	if s.Level != postureFail || !strings.Contains(s.Findings[0].Text, "expired") {
		t.Fatalf("status = %+v", s)
	}
}

func TestNebulaNotRunningOrNoOverlayWarns(t *testing.T) {
	f := healthyNeb(20)
	f.up = false
	s := nebulaStatus(context.Background(), f.env())
	if s.Level != postureWarn || s.Running != "no" || !strings.Contains(s.Findings[0].Text, "not running") {
		t.Fatalf("down: %+v", s)
	}
	// The fix is a sentence for a person: Argo never starts a root service itself.
	if !strings.Contains(s.Findings[0].Fix, "sudo") {
		t.Fatalf("fix should name the command for the person to run: %q", s.Findings[0].Fix)
	}
	f = healthyNeb(20)
	f.addrs = map[netip.Addr]string{netip.MustParseAddr("192.168.1.20"): "en0"}
	if s := nebulaStatus(context.Background(), f.env()); s.Level != postureWarn || !strings.Contains(s.Findings[0].Text, "overlay address") {
		t.Fatalf("no overlay: %+v", s)
	}
	f = healthyNeb(20)
	f.ok = false // pgrep unavailable: unknown, and no warning claimed from it
	if s := nebulaStatus(context.Background(), f.env()); s.Running != "unknown" || s.Level != postureOK {
		t.Fatalf("pgrep unknown: %+v", s)
	}
}

func TestNebulaAbsentPrintsNothingInDoctor(t *testing.T) {
	f := &nebFake{files: map[string]bool{}}
	s := nebulaStatus(context.Background(), f.env())
	if s.Installed || s.Level != nebulaAbsent {
		t.Fatalf("status = %+v", s)
	}
	var out bytes.Buffer
	doctorNebula(context.Background(), f.env(), &out)
	if out.Len() != 0 {
		t.Fatalf("doctor printed %q for a machine without Nebula", out.String())
	}
	if len(f.calls) != 0 {
		t.Fatalf("ran %v with nothing installed", f.calls)
	}
	out.Reset()
	if code, _ := netCmd(context.Background(), []string{"status"}, f.env(), &out); code != 0 || !strings.Contains(out.String(), "not installed") {
		t.Fatalf("net status without Nebula: %d %q", code, out.String())
	}
}

func TestNebulaUnreadableIsUnknownNeverOK(t *testing.T) {
	for name, mod := range map[string]func(*nebFake){
		"print fails": func(f *nebFake) { f.print, f.printEr = "", errors.New("exit status 1") },
		"not json":    func(f *nebFake) { f.print = "Error: error while unmarshaling cert" },
		"only a CA": func(f *nebFake) {
			f.print = nebPrint(nebCertJSON("Lightbound mesh CA", "10.117.0.0/24", nil, nebNow.Add(400*24*time.Hour), true))
		},
		"no notAfter":    func(f *nebFake) { f.print = `[{"details":{"name":"mac","isCa":false}}]` },
		"no cert file":   func(f *nebFake) { delete(f.files, "/etc/nebula/host.crt") },
		"no nebula-cert": func(f *nebFake) { delete(f.files, "/opt/homebrew/bin/nebula-cert") },
		"huge output":    func(f *nebFake) { f.print = "[" + strings.Repeat(" ", nebulaPrintMax) + "]" },
	} {
		f := healthyNeb(20)
		mod(f)
		s := nebulaStatus(context.Background(), f.env())
		if s.Level != postureUnknown {
			t.Errorf("%s: level %s, want unknown (%+v)", name, s.Level, s.Findings)
		}
	}
}

func TestNebulaRunsOnlyPinnedAbsolutePaths(t *testing.T) {
	f := healthyNeb(20)
	nebulaStatus(context.Background(), f.env())
	if len(f.calls) != 1 {
		t.Fatalf("calls = %v", f.calls)
	}
	if want := "/opt/homebrew/bin/nebula-cert print -json -path /etc/nebula/host.crt"; f.calls[0] != want {
		t.Fatalf("call = %q, want %q", f.calls[0], want)
	}
	for _, p := range append(append(append([]string{}, nebulaBins...), nebulaCertTools...), nebulaCertPaths...) {
		if !strings.HasPrefix(p, "/") {
			t.Errorf("%q is not an absolute path", p)
		}
	}
	// An override cert path from the environment is used as given, still through the pinned tool.
	f = healthyNeb(20)
	f.files["/srv/nebula/host.crt"] = true
	e := f.env()
	e.certPath = "/srv/nebula/host.crt"
	nebulaStatus(context.Background(), e)
	if !strings.HasSuffix(f.calls[0], "-path /srv/nebula/host.crt") {
		t.Fatalf("override ignored: %v", f.calls)
	}
}

func TestNebulaDualCertificateUsesEarliestExpiry(t *testing.T) {
	f := healthyNeb(20)
	v1 := nebCertJSON("mac", "10.117.0.50/24", []string{"dev"}, nebNow.Add(3*24*time.Hour+time.Hour), false)
	v1["version"] = 1
	f.print = nebPrint(nebCertJSON("mac", "10.117.0.50/24", []string{"dev"}, nebNow.Add(20*24*time.Hour), false), v1)
	s := nebulaStatus(context.Background(), f.env())
	if s.DaysLeft != 3 || s.Level != postureWarn {
		t.Fatalf("status = %+v", s)
	}
	// Older nebula-cert (before 1.10) printed one object with details.ips instead of an array with networks.
	f = healthyNeb(20)
	f.print = `{"details":{"name":"mac","ips":["10.117.0.50/24"],"groups":["dev"],"notAfter":"2026-12-15T12:00:00Z","isCa":false},"fingerprint":"` + strings.Repeat("cd", 32) + `"}`
	s = nebulaStatus(context.Background(), f.env())
	if s.DaysLeft != 20 || s.Overlay != "10.117.0.50" || s.Level != postureOK {
		t.Fatalf("old format: %+v", s)
	}
}

func TestNetCmdJSONAndUsage(t *testing.T) {
	f := healthyNeb(5)
	var out bytes.Buffer
	code, err := netCmd(context.Background(), []string{"status", "--json"}, f.env(), &out)
	if err != nil || code != 1 {
		t.Fatalf("code %d err %v", code, err)
	}
	var got NebulaStatus
	if err := json.Unmarshal(out.Bytes(), &got); err != nil || got.Level != postureWarn || got.DaysLeft != 5 {
		t.Fatalf("json %q: %v %+v", out.String(), err, got)
	}
	if _, err := netCmd(context.Background(), []string{"enroll"}, f.env(), &out); err == nil || !strings.Contains(err.Error(), "usage") {
		t.Fatalf("enroll must not exist in Phase 1: %v", err)
	}
}
