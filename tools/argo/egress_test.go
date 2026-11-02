package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestEgressLogsEachTextAndHoldsWhenOff(t *testing.T) {
	var sent []string
	p := testPhone(t, func(_, text string) error { sent = append(sent, text); return nil })
	s := Store{Dir: filepath.Dir(p.Queue)}
	at := time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC)

	p.Send("Battery 9%", "plug in", at)
	log := readEgress(s.Dir)
	if len(sent) != 1 || len(log) != 1 {
		t.Fatalf("sent %d, logged %d", len(sent), len(log))
	}
	if e := log[0]; e.To != "+60…89" || e.Route != "imessage-first" || e.Via != "messages" || e.Bytes != len(sent[0]) || e.Text != sent[0] {
		t.Fatalf("entry %+v for %q", e, sent[0])
	}

	var out bytes.Buffer
	if err := egressCmd([]string{"off"}, s, p, &out, at); err != nil {
		t.Fatal(err)
	}
	p.Send("Disk 95%", "clean up", at)
	p.Flush()
	if len(sent) != 1 || len(p.readQueue()) != 1 || len(readEgress(s.Dir)) != 1 {
		t.Fatalf("held send went out: sent %d, queued %d", len(sent), len(p.readQueue()))
	}
	out.Reset()
	if err := egressCmd(nil, s, p, &out, at); err != nil || !strings.Contains(out.String(), "HELD (1 texts waiting)") {
		t.Fatalf("report while held: %v\n%s", err, out.String())
	}
	if err := egressCmd([]string{"on"}, s, p, &out, at); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 2 || len(p.readQueue()) != 0 || len(readEgress(s.Dir)) != 2 {
		t.Fatalf("released: sent %d, queued %d, logged %d", len(sent), len(p.readQueue()), len(readEgress(s.Dir)))
	}
	if egressCmd([]string{"bogus"}, s, p, &out, at) == nil {
		t.Error("bad argument accepted")
	}
}

func TestEgressFailedSendIsNotLogged(t *testing.T) {
	p := testPhone(t, func(string, string) error { return os.ErrDeadlineExceeded })
	p.Send("t", "m", time.Now())
	if n := len(readEgress(filepath.Dir(p.Queue))); n != 0 {
		t.Fatalf("logged %d texts that never left", n)
	}
}

func TestEgressReportCoversThirdPartiesAndOwnNetwork(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	now := time.Date(2026, 11, 3, 9, 0, 0, 0, time.Local)
	logEgress(s.Dir, EgressEntry{At: now.AddDate(0, 0, -9), Route: "sms-first", To: "+60…89", Bytes: 50, Text: "too old"})
	logEgress(s.Dir, EgressEntry{At: now.Add(-time.Hour), Route: "sms-first", To: "+60…89", Bytes: 2048, Text: "Claude Code on judith\nwaiting"})
	countOwnEgress(s.Dir, "gauss report", "100.101.1.2:3001", 700, now.AddDate(0, 0, -20)) // pruned
	countOwnEgress(s.Dir, "gauss report", "100.101.1.2:3001", 700, now.Add(-time.Minute))
	countOwnEgress(s.Dir, "gauss report", "100.101.1.2:3001", 724, now)
	if days := loadOwnEgress(s.path("egress-own.json")); len(days) != 1 {
		t.Fatalf("own counters kept %d days, want 1 (older than %d days pruned)", len(days), egressOwnDays)
	}
	if left, _ := filepath.Glob(filepath.Join(s.Dir, "egress-own-*.tmp")); len(left) != 0 {
		t.Errorf("temp files left: %v", left)
	}
	var out bytes.Buffer
	if err := egressCmd(nil, s, nil, &out, now); err != nil {
		t.Fatal(err)
	}
	got := out.String()
	for _, want := range []string{"Third parties: 1 texts, 2.0 KB", routeNote["sms-first"], "Claude Code on judith · waiting",
		"gauss report → 100.101.1.2:3001: 2 sends, 1.4 KB", "Third-party sends: on."} {
		if !strings.Contains(got, want) {
			t.Errorf("report misses %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "too old") {
		t.Errorf("report shows a text older than %d days:\n%s", egressShowDays, got)
	}
}

func TestEgressLogRollsOverAndCutsLongTexts(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "egress.jsonl"), bytes.Repeat([]byte("x"), egressLogMax+1), 0o600); err != nil {
		t.Fatal(err)
	}
	logEgress(dir, EgressEntry{At: time.Now(), Text: strings.Repeat("é", 500)})
	if _, err := os.Stat(filepath.Join(dir, "egress.jsonl.1")); err != nil {
		t.Fatal("full log did not roll over")
	}
	log := readEgress(dir)
	if len(log) != 1 || len([]rune(log[0].Text)) != egressTextMax {
		t.Fatalf("got %d entries, text %d runes", len(log), len([]rune(log[0].Text)))
	}
	if fi, _ := os.Stat(filepath.Join(dir, "egress.jsonl")); fi.Mode().Perm() != 0o600 {
		t.Errorf("egress log mode %v, want 0600", fi.Mode().Perm())
	}
}

func TestMaskHandle(t *testing.T) {
	for in, want := range map[string]string{"+60123456789": "+60…89", "josh@icloud.com": "j…@icloud.com", "+6012": "…"} {
		if got := maskHandle(in); got != want {
			t.Errorf("maskHandle(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPhoneChooseRouteSavesConfig(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := Config{PhoneTo: "+60123456789", PhoneService: "sms"}
	if err := phoneSetup([]string{"imessage"}, cfg); err != nil {
		t.Fatal(err)
	}
	if c := loadConfig(); c.PhoneService != "" || c.PhoneTo != "+60123456789" {
		t.Fatalf("after imessage: %+v", c)
	}
	if err := phoneSetup([]string{"sms"}, loadConfig()); err != nil {
		t.Fatal(err)
	}
	if c := loadConfig(); c.PhoneService != "sms" {
		t.Fatalf("after sms: %+v", c)
	}
	if phoneSetup([]string{"sms"}, Config{PhoneTo: "me@icloud.com"}) == nil {
		t.Error("SMS route accepted for an email handle")
	}
}
