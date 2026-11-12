package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testAttention(t *testing.T) *Attention {
	quiet, err := parseQuietHours("")
	if err != nil {
		t.Fatal(err)
	}
	return &Attention{Path: filepath.Join(t.TempDir(), "attention.json"), Quiet: quiet}
}

func clock(h, m int) time.Time { return time.Date(2026, 11, 10, h, m, 0, 0, time.Local) }

func TestAlertLevelFromTitle(t *testing.T) {
	for _, c := range []struct {
		a    Alert
		want AlertLevel
	}{
		{Alert{Title: "Gauss: battery 12%"}, AlertWarn},
		{Alert{Title: "Gauss: battery 4%", Key: "battery-critical"}, AlertUrgent},
		{Alert{Title: "Gauss: shutting down services"}, AlertUrgent},
		{Alert{Title: "Gauss recovered"}, AlertInfo},
		{Alert{Title: "✅ Remote access: power OK"}, AlertInfo},
		{Alert{Title: "Argo: DNS", Msg: "usually cleared by itself in 3 min"}, AlertWarn}, // only the title decides info
		{Alert{Title: "Claude Code", Msg: "Claude needs your OK"}, AlertWarn},
		{Alert{Level: AlertInfo, Title: "Gauss: battery critical"}, AlertInfo}, // an explicit level wins
	} {
		if got := c.a.level(); got != c.want {
			t.Errorf("%q: level %d, want %d", c.a.Title, got, c.want)
		}
	}
}

func TestAlertTopicMergesWatchers(t *testing.T) {
	for _, c := range []struct {
		a      Alert
		topic  string
		coarse bool
	}{
		{Alert{Title: "🔌 judith is on battery (34%)"}, "power", true},
		{Alert{Title: "Gauss: battery 31%"}, "power", true},
		{Alert{Title: "Gauss: charger can't keep up", Key: "charger-weak"}, "power", true},
		{Alert{Title: "Gauss: memory over budget (9.8 GB)"}, "memory", true},
		{Alert{Title: "Argo: swap climbing"}, "memory", true},
		{Alert{Title: "Gauss: disk 11 GB free"}, "disk", true},
		{Alert{Title: "Claude Code", Key: "claude-input"}, "claude-input", false},
		{Alert{Title: "Gauss: data is stale (12 min)"}, "gauss data is stale min", false},
	} {
		if topic, coarse := c.a.topic(); topic != c.topic || coarse != c.coarse {
			t.Errorf("%q: topic %q coarse %v, want %q %v", c.a.Title, topic, coarse, c.topic, c.coarse)
		}
	}
}

func TestParseQuietHours(t *testing.T) {
	at := &Attention{}
	var err error
	if at.Quiet, err = parseQuietHours(""); err != nil {
		t.Fatal(err)
	}
	for h, want := range map[int]bool{22: false, 23: true, 0: true, 6: true, 7: false, 12: false} {
		if got := at.inQuiet(clock(h, 30)); got != want {
			t.Errorf("default quiet at %02d:30 = %v, want %v", h, got, want)
		}
	}
	if at.Quiet, err = parseQuietHours("23:00-07:00, 09:00-12:30"); err != nil || len(at.Quiet) != 2 {
		t.Fatalf("two windows: %v %v", at.Quiet, err)
	}
	if !at.inQuiet(clock(10, 0)) || at.inQuiet(clock(12, 30)) {
		t.Error("the work window should cover 10:00 and end at 12:30")
	}
	if q, err := parseQuietHours("off"); err != nil || q != nil {
		t.Errorf("off: %v %v", q, err)
	}
	for _, bad := range []string{"23-07", "25:00-07:00", "23:00", "a:b-c:d"} {
		if _, err := parseQuietHours(bad); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
	// A typo in config falls back to the default instead of no quiet hours.
	if a := newAttention(t.TempDir(), "nonsense"); !a.inQuiet(clock(2, 0)) {
		t.Error("bad config should keep the default quiet hours")
	}
}

func TestAttentionAdmit(t *testing.T) {
	at := testAttention(t)
	battery := Alert{Title: "Gauss: battery 31%"}
	if !at.admit(battery, clock(9, 0)) {
		t.Fatal("the first battery warning should text")
	}
	if at.admit(Alert{Title: "🔌 judith is on battery (30%)"}, clock(9, 20)) {
		t.Error("a second watcher's power alert within 2 h should be held")
	}
	if at.admit(Alert{Title: "Gauss recovered"}, clock(9, 30)) {
		t.Error("a recovery never texts by itself")
	}
	if !at.admit(Alert{Title: "Gauss: battery 4%", Key: "battery-critical"}, clock(9, 40)) {
		t.Error("critical must text although the topic texted 40 min ago")
	}
	if at.admit(Alert{Title: "Gauss: battery 3%", Key: "battery-critical"}, clock(9, 45)) {
		t.Error("an urgent repeat within 15 min should be held")
	}
	if !at.admit(battery, clock(11, 1)) {
		t.Error("the same topic should text again after 2 h")
	}
	if at.held() != 3 {
		t.Errorf("held %d, want 3", at.held())
	}
}

func TestAttentionQuietHoursAndBudget(t *testing.T) {
	at := testAttention(t)
	if at.admit(Alert{Title: "Gauss: data is stale"}, clock(2, 0)) {
		t.Error("a warning at 02:00 should wait for the morning")
	}
	if !at.admit(Alert{Level: AlertUrgent, Title: "Gauss: services down"}, clock(2, 5)) {
		t.Error("urgent texts in quiet hours")
	}
	// Different topics, same hour: only textsPerHour of them text.
	sent := 0
	for i, title := range []string{"Argo: DNS", "Argo: PORT_BLOCK", "Gauss: data is stale", "Argo: new app sending data", "Gauss: running slow", "Argo: iphone offline"} {
		if at.admit(Alert{Title: title}, clock(14, i)) {
			sent++
		}
	}
	if sent != textsPerHour {
		t.Errorf("texted %d in one hour, want %d", sent, textsPerHour)
	}
	if !at.admit(Alert{Title: "Gauss: running slow"}, clock(15, 5)) {
		t.Error("the budget should reopen an hour later")
	}
}

func TestAttentionDigest(t *testing.T) {
	at := testAttention(t)
	at.admit(Alert{Title: "Gauss: battery 31%"}, clock(1, 0))
	at.admit(Alert{Title: "Gauss: battery 28%"}, clock(3, 0))
	at.admit(Alert{Title: "Gauss recovered"}, clock(3, 30))
	if d := at.digest(clock(6, 59)); d != "" {
		t.Fatalf("no digest in quiet hours, got %q", d)
	}
	d := at.digest(clock(7, 0))
	for _, want := range []string{"3 alerts held since 01:00", "2× Gauss: battery 28% (last 03:00)", "1× Gauss recovered (last 03:30)"} {
		if !strings.Contains(d, want) {
			t.Errorf("digest %q lacks %q", d, want)
		}
	}
	if at.held() != 0 || at.digest(clock(7, 1)) != "" {
		t.Error("a digest should empty the held list")
	}
	// Held during the day: one digest once the oldest is 3 h old, not before.
	at.admit(Alert{Title: "Gauss recovered"}, clock(10, 0))
	if d := at.digest(clock(12, 59)); d != "" {
		t.Errorf("too early: %q", d)
	}
	if d := at.digest(clock(13, 0)); !strings.Contains(d, "1 alerts held since 10:00") {
		t.Errorf("digest after 3 h: %q", d)
	}
}

func TestAttentionDigestIsShortAndMasked(t *testing.T) {
	at := testAttention(t)
	for i := 0; i < 30; i++ {
		at.admit(Alert{Level: AlertInfo, Title: "topic " + strings.Repeat("x", i+1) + " token=abc123"}, clock(8, i))
	}
	d := at.digest(clock(12, 0))
	if strings.Contains(d, "abc123") {
		t.Error("the digest must not carry secrets")
	}
	if n := strings.Count(d, "\n"); n != digestLines+1 || !strings.Contains(d, "+ 22 more topics") {
		t.Errorf("digest has %d lines: %q", n, d)
	}
}

// Nothing is lost: a held alert reaches the phone in the digest, and a digest
// that fails to send stays in the queue for the next tick.
func TestPhoneHoldsThenSendsDigest(t *testing.T) {
	var sent []string
	online := true
	p := testPhone(t, func(_, text string) error {
		if !online {
			return errors.New("offline")
		}
		sent = append(sent, text)
		return nil
	})
	p.Policy = &Attention{Path: filepath.Join(t.TempDir(), "attention.json"), Quiet: []clockSpan{{23 * 60, 7 * 60}}}
	p.Send("Gauss: data is stale", "No new data for 12 min.", clock(2, 0))
	p.Send("Gauss recovered", "Cleared: data is stale.", clock(2, 20))
	p.flushAt(clock(3, 0))
	if len(sent) != 0 {
		t.Fatalf("nothing should text at night: %q", sent)
	}
	online = false
	p.flushAt(clock(7, 0)) // digest is due but the send fails
	online = true
	p.flushAt(clock(7, 1))
	if len(sent) != 1 || !strings.HasPrefix(sent[0], "Argo digest on judith (07:00)\n2 alerts held since 02:00") {
		t.Fatalf("sent %q", sent)
	}
	p.SendAlert(Alert{Level: AlertUrgent, Title: "Gauss: services down", Msg: "Backend is not answering."}, clock(23, 30))
	if len(sent) != 2 || !strings.HasPrefix(sent[1], "Gauss: services down on judith (23:30)") {
		t.Fatalf("urgent should text at once: %q", sent)
	}
}

func TestNotifyLevelFlag(t *testing.T) {
	var sent []string
	p := testPhone(t, func(_, text string) error { sent = append(sent, text); return nil })
	p.Policy = testAttention(t)
	s := Store{Dir: t.TempDir()}
	if err := notifyCmd([]string{"-level", "info", "Deploy finished", "main abc1234 is live"}, p, s, clock(12, 0)); err != nil {
		t.Fatal(err)
	}
	if err := notifyCmd([]string{"-level", "urgent", "Deploy failed", "rolled back"}, p, s, clock(2, 0)); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 1 || !strings.Contains(sent[0], "Deploy failed") {
		t.Fatalf("sent %q", sent)
	}
	if err := notifyCmd([]string{"-level", "loud", "x", "y"}, p, s, clock(12, 0)); err == nil {
		t.Error("an unknown level should be refused")
	}
}

func TestAttentionReplay(t *testing.T) {
	log := filepath.Join(t.TempDir(), "egress.jsonl")
	f, err := os.Create(log)
	if err != nil {
		t.Fatal(err)
	}
	add := func(at time.Time, text string) {
		b, _ := json.Marshal(EgressEntry{At: at, Via: "messages", Text: text})
		f.Write(append(b, '\n'))
	}
	for i := 0; i < 6; i++ { // six battery texts in an hour, then a recovery, then one at night
		add(clock(9, i*10), "Gauss: battery 30% on judith (09:00)\nPlug in.")
	}
	add(clock(10, 0), "Gauss recovered on judith (10:00)\nCleared: battery.")
	add(clock(23, 30), "Gauss: data is stale on judith (23:30)\nNo new data.")
	f.Close()
	quiet, _ := parseQuietHours("")
	out, err := attentionReplay(log, quiet)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "2026-11-10          8          1 (0, 0)") {
		t.Errorf("replay:\n%s", out)
	}
}

// Texts that stop leaving the Mac must not fail silently (5 Nov 2026).
func TestPhoneHealthNoticesFailingTexts(t *testing.T) {
	var sent, banners []string
	online := false
	p := testPhone(t, func(_, text string) error {
		if !online {
			return errors.New("not allowed to send Apple events to Messages")
		}
		sent = append(sent, text)
		return nil
	})
	old := desktopBanner
	desktopBanner = func(title, _ string) { banners = append(banners, title) }
	defer func() { desktopBanner = old }()
	dir := filepath.Dir(p.Queue)
	if phoneStatus(dir, time.Now()) != "" {
		t.Fatal("healthy phone should add nothing to status")
	}
	for i := 0; i < maxQueued+5; i++ {
		p.Send("Gauss: data is stale", "No new data.", time.Now())
	}
	h := loadPhoneHealth(dir)
	if h.FailSince.IsZero() || h.Queued != maxQueued || h.Dropped != 5 {
		t.Fatalf("health %+v", h)
	}
	if s := phoneStatus(dir, time.Now()); !strings.Contains(s, "texts NOT reaching the phone") || !strings.Contains(s, "5 lost") {
		t.Errorf("status %q", s)
	}
	if len(banners) != 0 {
		t.Error("no banner in the first 10 minutes")
	}
	p.noteDelivery(maxQueued, 0, h.FailSince.Add(phoneFailBanner))
	p.noteDelivery(maxQueued, 0, h.FailSince.Add(2*phoneFailBanner))
	if len(banners) != 1 {
		t.Errorf("banners %q, want exactly one", banners)
	}
	online = true
	p.Flush()
	if len(sent) != maxQueued+1 || !strings.Contains(sent[maxQueued], "5 alerts were lost") {
		t.Fatalf("sent %d, last %q", len(sent), sent[len(sent)-1])
	}
	if phoneStatus(dir, time.Now()) != "" || len(p.readQueue()) != 0 {
		t.Error("recovery should clear the health record and the queue")
	}
}
