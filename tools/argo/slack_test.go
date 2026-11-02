package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const testHook = "https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx"

func writeHook(t *testing.T, dir, url string, mode os.FileMode) {
	t.Helper()
	p := filepath.Join(dir, slackFile)
	if err := os.WriteFile(p, []byte(url+"\n"), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(p, mode); err != nil {
		t.Fatal(err)
	}
}

func TestSlackWebhookFileChecks(t *testing.T) {
	dir := t.TempDir()
	if _, err := readSlackURL(dir); err == nil {
		t.Fatal("missing file must not build a sink")
	}
	writeHook(t, dir, testHook, 0o644)
	if _, err := readSlackURL(dir); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("group/world-readable file must be refused, got %v", err)
	}
	for _, bad := range []string{"http://hooks.slack.com/services/T0000000/B0000000/abcdefghijkl", "https://evil.example/services/T0000000/B0000000/abcdefghijklmnop", "https://hooks.slack.com.evil.example/services/T0000000/B000/abcdefghijklmnop"} {
		writeHook(t, dir, bad, 0o600)
		if _, err := readSlackURL(dir); err == nil {
			t.Errorf("accepted %q", bad)
		} else if strings.Contains(err.Error(), "evil") || strings.Contains(err.Error(), "B0000000") {
			t.Errorf("error leaks the URL: %v", err)
		}
	}
	writeHook(t, dir, testHook, 0o600)
	if u, err := readSlackURL(dir); err != nil || u != testHook {
		t.Fatalf("good file refused: %v", err)
	}
	if s := newSlack(dir, t.TempDir(), "judith"); s == nil || s.Device != "judith" {
		t.Fatal("newSlack should build a sink from a good file")
	}
}

func TestSlackPosterErrorsNeverContainTheURL(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, 512)
		n, _ := r.Body.Read(b)
		got = string(b[:n])
		if strings.Contains(got, "fail") {
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer srv.Close()
	post := slackPoster(srv.URL+"/services/secret", srv.Client())
	if err := post("", "hello"); err != nil || !strings.Contains(got, `"text":"hello"`) {
		t.Fatalf("post: %v, body %q", err, got)
	}
	if err := post("", "fail"); err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "127.0.0.1") {
		t.Fatalf("HTTP error must be generic, got %v", err)
	}
	srv.Close()
	if err := post("", "offline"); err == nil || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "127.0.0.1") {
		t.Fatalf("network error must be generic, got %v", err)
	}
}

// routed builds a phone and a Slack sink that record what they were sent.
func routed(t *testing.T) (p *Phone, sms, slack *[]string) {
	dir := t.TempDir()
	sms, slack = &[]string{}, &[]string{}
	p = &Phone{To: "+60123456789", Queue: filepath.Join(dir, "phone-queue.jsonl"), Device: "d",
		send: func(_, text string) error { *sms = append(*sms, text); return nil }}
	p.Slack = &Phone{Queue: filepath.Join(dir, "slack-queue.jsonl"), Device: "d",
		send: func(_, text string) error { *slack = append(*slack, text); return nil }}
	return p, sms, slack
}

func TestLevelsRouteSMSAndSlack(t *testing.T) {
	p, sms, slack := routed(t)
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	p.SendLevel(AlertWarn, "Mesh", "uplink down", now)
	p.SendLevel(AlertUrgent, "Gauss", "backend down", now)
	p.SendLevel(AlertInfo, "Status", "all good at 09:00", now)
	if len(*sms) != 2 || len(*slack) != 3 {
		t.Fatalf("sms %d (want 2: warn+urgent), slack %d (want 3: every level)", len(*sms), len(*slack))
	}
	if strings.Contains(strings.Join(*sms, "\n"), "all good") {
		t.Error("info must not text the phone")
	}
	if _, err := parseLevel("loud"); err == nil {
		t.Error("unknown level accepted")
	}
}

func TestTopicGateCollapsesWatchersButPassesChanges(t *testing.T) {
	p, sms, slack := routed(t)
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	p.Send("Battery low", "18% on battery", now)                            // gauss-services
	p.Send("remote-watch", "battery at 17%, plug in", now.Add(time.Minute)) // a second watcher, same event
	if len(*sms) != 1 || len(*slack) != 1 {
		t.Fatalf("same battery event from two watchers: sms %d slack %d, want 1 each", len(*sms), len(*slack))
	}
	p.Send("Disk low", "2 GB free", now.Add(2*time.Minute)) // a different topic still goes
	p.Send("Battery critical", "5%, shutting down soon", now.Add(3*time.Minute))
	p.Send("Battery", "charger connected, recovered", now.Add(4*time.Minute))
	p.SendLevel(AlertUrgent, "Battery low", "urgent bypasses the gate", now.Add(5*time.Minute))
	if len(*sms) != 5 {
		t.Fatalf("disk, critical, recovery and urgent must pass the gate: sms %d, want 5", len(*sms))
	}
	p.Send("Battery low", "15%", now.Add(31*time.Minute)) // after the window a repeat goes again
	if len(*sms) != 6 {
		t.Fatalf("repeat after the window: sms %d, want 6", len(*sms))
	}
	if alertTopic("Mesh", "program started") != "" {
		t.Error("'ram' must match whole words only")
	}
}

func TestSlackQueuesOfflineAndFlushes(t *testing.T) {
	p, _, slack := routed(t)
	down := true
	p.Slack.send = func(_, text string) error {
		if down {
			return errors.New("slack: post failed (offline?)")
		}
		*slack = append(*slack, text)
		return nil
	}
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	p.Send("Mesh", "uplink down", now)
	if q := p.Slack.readQueue(); len(q) != 1 {
		t.Fatalf("offline Slack alert should be queued, queue %d", len(q))
	}
	down = false
	p.Flush()
	if len(*slack) != 1 || len(p.Slack.readQueue()) != 0 {
		t.Fatalf("flush should deliver the queued Slack alert: sent %d", len(*slack))
	}
}

func TestNotifyLevelFlag(t *testing.T) {
	p, sms, slack := routed(t)
	s := Store{Dir: t.TempDir()}
	now := time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)
	if err := notifyCmd([]string{"-level", "info", "Status", "09:00 all good"}, p, s, now); err != nil {
		t.Fatal(err)
	}
	if len(*sms) != 0 || len(*slack) != 1 {
		t.Fatalf("-level info: sms %d slack %d, want 0/1", len(*sms), len(*slack))
	}
	if err := notifyCmd([]string{"-level", "loud", "T", "M"}, p, s, now); err == nil {
		t.Fatal("bad -level accepted")
	}
}
