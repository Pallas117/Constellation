package main

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestParseLsof(t *testing.T) {
	out := "p678\ncidentityservicesd\nf49\nn[fe80:15::cda:1e12]:1024->[fe80:15::1b00:9955]:1024\n" +
		"p900\ncGoogle Chrome Helper\nf20\nn172.20.10.4:55624->142.250.4.100:443\nf21\nn172.20.10.4:55625->142.250.4.101:443\n" +
		"f22\nn172.20.10.4:55626->192.168.1.5:8080\nf23\nn100.73.232.74:50000->100.101.1.2:22\n" +
		"p901\ncsketchy\nf3\nn[2001:d08:2309:11::5]:5555->[2606:4700:4700::1111]:6667\n"
	got := parseLsof(out)
	want := []Conn{{900, "Google Chrome Helper", "142.250.4.0/24", 443}, {901, "sketchy", "2606:4700:4700::/48", 6667}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("conns (link-local, private, tailnet dropped; one per prefix+port):\n got %v\nwant %v", got, want)
	}
}

func TestParseNettop(t *testing.T) {
	got := parseNettop(",bytes_out,\nlaunchd.1,0,\napsd.381,1146122,\nGoogle Chrome H.900,52428800,\n")
	if got[381] != 1146122 || got[900] != 52428800 || got[1] != 0 || len(got) != 3 {
		t.Fatalf("sent: %v", got)
	}
}

var leakT0 = time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC)

func titles(f []leakFinding) string {
	var s []string
	for _, x := range f {
		s = append(s, x.App+": "+x.Title)
	}
	return strings.Join(s, "; ")
}

// TestLeakLearnsQuietlyForAWeek: nothing is texted while learning.
func TestLeakLearnsQuietlyForAWeek(t *testing.T) {
	var l Leak
	c := []Conn{{1, "newapp", "203.0.113.0/24", 9999}}
	if f := leakCheck(&l, c, nil, leakT0); len(f) != 0 {
		t.Fatalf("texted while learning: %s", titles(f))
	}
	if f := leakCheck(&l, []Conn{{2, "other", "198.51.100.0/24", 443}}, nil, leakT0.Add(6*24*time.Hour)); len(f) != 0 {
		t.Fatalf("texted on day 6: %s", titles(f))
	}
}

func learned(t *testing.T) *Leak {
	l := &Leak{}
	leakCheck(l, []Conn{{10, "Slack", "203.0.113.0/24", 443}, {11, "Notes", "198.51.100.0/24", 443}}, map[int]int64{10: 1 << 20}, leakT0)
	return l
}

func TestLeakFlagsANewAppAfterLearning(t *testing.T) {
	l := learned(t)
	f := leakCheck(l, []Conn{{12, "unknownd2", "192.0.2.0/24", 443}}, nil, leakT0.Add(8*24*time.Hour))
	if titles(f) != "unknownd2: Argo: new app sending data" {
		t.Fatalf("new app: %s", titles(f))
	}
	if f := leakCheck(l, []Conn{{12, "unknownd2", "192.0.2.0/24", 443}}, nil, leakT0.Add(8*24*time.Hour+5*time.Minute)); len(f) != 0 {
		t.Fatalf("told twice: %s", titles(f))
	}
}

func TestLeakFlagsABurstOfNewDestinationsOncePerDay(t *testing.T) {
	l := learned(t)
	var c []Conn
	for i := 0; i < leakNewDests; i++ {
		c = append(c, Conn{10, "Slack", fmt.Sprintf("192.0.%d.0/24", i), 443})
	}
	at := leakT0.Add(8 * 24 * time.Hour)
	if f := leakCheck(l, c, nil, at); !strings.Contains(titles(f), "many new places") {
		t.Fatalf("burst: %s", titles(f))
	}
	for i := range c {
		c[i].Dest = fmt.Sprintf("10%d.0.0.0/24", i) // another burst an hour later: same day, no text
	}
	if f := leakCheck(l, c, nil, at.Add(time.Hour)); len(f) != 0 {
		t.Fatalf("retold within a day: %s", titles(f))
	}
}

func TestLeakFlagsAnOddPortButNotApplesDaemons(t *testing.T) {
	l := learned(t)
	at := leakT0.Add(8 * 24 * time.Hour)
	if f := leakCheck(l, []Conn{{11, "Notes", "198.51.100.0/24", 6667}}, nil, at); !strings.Contains(titles(f), "unusual port") {
		t.Fatalf("odd port: %s", titles(f))
	}
	l2 := learned(t)
	leakCheck(l2, []Conn{{20, "apsd", "17.0.0.0/24", 5223}}, nil, leakT0) // learned during the week
	if f := leakCheck(l2, []Conn{{20, "apsd", "17.0.0.0/24", 2195}}, nil, at); len(f) != 0 {
		t.Fatalf("Apple daemon flagged: %s", titles(f))
	}
}

func TestLeakFlagsALargeUploadAgainstTheAppsUsual(t *testing.T) {
	l := learned(t)
	at := leakT0.Add(8 * 24 * time.Hour)
	// usual: ~1 MB per sample; now 60 MB more than last time
	leakCheck(l, []Conn{{10, "Slack", "203.0.113.0/24", 443}}, map[int]int64{10: 2 << 20}, at)
	f := leakCheck(l, []Conn{{10, "Slack", "203.0.113.0/24", 443}}, map[int]int64{10: 62 << 20}, at.Add(5*time.Minute))
	if !strings.Contains(titles(f), "large upload") {
		t.Fatalf("upload spike: %s", titles(f))
	}
}
