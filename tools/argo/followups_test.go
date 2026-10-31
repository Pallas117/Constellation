package main

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

func TestHotspotKeepsOneFingerprintPerCountry(t *testing.T) {
	hs := func(ip, loc string) Snapshot { return Snapshot{Gateway: "172.20.10.1", PublicIP: ip, Loc: loc} }
	a, b := netFingerprint(hs("175.143.1.9", "MY")), netFingerprint(hs("60.50.200.3", "MY"))
	if a == "" || a != b {
		t.Fatalf("same phone, new carrier IP: %q vs %q", a, b)
	}
	if a == netFingerprint(hs("103.5.4.3", "HK")) {
		t.Fatal("an HK eSIM must not share the MY SIM's key")
	}
	home := Snapshot{Gateway: "192.168.1.254", GatewayMAC: "24:2f:d0:c5:e6:9e", PublicIP: "180.188.170.58", Loc: "MY"}
	if netFingerprint(home) != Fingerprint(home.GatewayMAC, home.PublicIP) {
		t.Fatal("other networks keep the gateway+/24 key")
	}
}

func TestFlipBetweenFailuresIsOneIncident(t *testing.T) {
	pb, dns := fixture(t, "port_block.json"), fixture(t, "dns_fail.json")
	for _, s := range []*Snapshot{&pb, &dns} {
		s.GatewayMAC, s.PublicIP = "aa:bb:cc:dd:ee:01", "203.0.113.9"
	}
	l, fx := newLoop(t, pb, pb, dns, dns, pb, pb)
	first := l.Tick(context.Background())
	if first.Class != PortBlock {
		t.Fatalf("class %s", first.Class)
	}
	notes := len(fx.notes)
	for i := 0; i < 2; i++ {
		fx.now = fx.now.Add(time.Minute)
		st := l.Tick(context.Background())
		if st.IncidentAt != first.IncidentAt {
			t.Fatalf("flip %d restarted the incident: %v -> %v", i, first.IncidentAt, st.IncidentAt)
		}
		if st.Attempts < first.Attempts {
			t.Fatalf("flip %d reset attempts/backoff: %d", i, st.Attempts)
		}
	}
	if len(fx.notes) != notes {
		t.Fatalf("flips sent more texts: %v", fx.notes[notes:])
	}
	var events []string
	for _, in := range l.Store.Incidents() {
		if in.Event != "attempt" {
			events = append(events, in.Event+":"+string(in.Class))
		}
	}
	if got := strings.Join(events, ","); !strings.Contains(got, "superseded:PORT_BLOCK,open:DNS") {
		t.Fatalf("history should still show the flip: %s", got)
	}
}

func TestIncidentsRotateAndStayReadable(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	if err := s.Append(Incident{Time: time.Now(), Event: "open", Class: Offline}); err != nil {
		t.Fatal(err)
	}
	// Grow past the cap, then append once more: the old file moves aside, both are read.
	f, _ := os.OpenFile(s.path("incidents.jsonl"), os.O_APPEND|os.O_WRONLY, 0o600)
	f.Write([]byte(strings.Repeat("x", incidentsMaxBytes) + "\n"))
	f.Close()
	if err := s.Append(Incident{Time: time.Now(), Event: "resolved", Class: Offline}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.path("incidents.jsonl.1")); err != nil {
		t.Fatal("not rotated")
	}
	if fi, _ := os.Stat(s.path("incidents.jsonl")); fi.Size() > 1024 {
		t.Fatalf("current file still %d bytes", fi.Size())
	}
	got := s.Incidents()
	if len(got) != 2 || got[0].Event != "open" || got[1].Event != "resolved" {
		t.Fatalf("incidents across rotation: %+v", got)
	}
}

func TestDNSFailureBlamesTailscaleWhenTheNetworkAnswers(t *testing.T) {
	s := fixture(t, "dns_fail.json")
	s.Tailscale.Running = true
	s.DNSDirectOK = true
	class, reason := Classify(s)
	if class != DNS || !strings.Contains(reason, "MagicDNS") {
		t.Fatalf("%s: %s", class, reason)
	}
	plan := Plan(class, s, "")
	if len(plan) == 0 || plan[0].ID != "check-magicdns" {
		t.Fatalf("plan should lead with Tailscale's resolver: %v", ids(plan))
	}
	n := 0
	for _, a := range plan {
		if a.ID == "check-magicdns" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("check-magicdns offered %d times", n)
	}
	s.DNSDirectOK = false
	if _, reason := Classify(s); strings.Contains(reason, "MagicDNS") {
		t.Fatal("without the direct check, don't blame Tailscale")
	}
}
