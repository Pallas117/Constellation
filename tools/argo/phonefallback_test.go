package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// An expired SIM (11 Nov 2026): sends to the number fail, the fallback carries the alert.
func TestPhoneFallbackCarriesFailedAlerts(t *testing.T) {
	var main, fallback []string
	mainUp := false
	p := testPhone(t, func(_, text string) error {
		if !mainUp {
			return errors.New("SMS not sent: no service")
		}
		main = append(main, text)
		return nil
	})
	p.Fallback = "josh@example.com"
	p.sendFallback = func(to, text string) error {
		if to != "josh@example.com" {
			t.Fatalf("fallback sent to %q", to)
		}
		fallback = append(fallback, text)
		return nil
	}
	p.Send("Gauss: data is stale", "No new data.", time.Now())
	if len(main) != 0 || len(fallback) != 1 || len(p.readQueue()) != 0 {
		t.Fatalf("main %d fallback %d queued %d", len(main), len(fallback), len(p.readQueue()))
	}
	b, err := os.ReadFile(filepath.Join(filepath.Dir(p.Queue), "egress.jsonl"))
	if err != nil || !strings.Contains(string(b), `"route":"fallback"`) || strings.Contains(string(b), "josh@example.com") {
		t.Errorf("egress should log the fallback route with a masked handle: %s", b)
	}
	mainUp = true
	p.Send("Gauss: running slow", "Updates take over 5 s.", time.Now())
	if len(main) != 1 || len(fallback) != 1 {
		t.Fatalf("with the main handle back, the fallback must stay unused: main %d fallback %d", len(main), len(fallback))
	}
}

func TestPhoneFallbackBothDownQueues(t *testing.T) {
	p := testPhone(t, func(_, _ string) error { return errors.New("down") })
	p.Fallback = "josh@example.com"
	p.sendFallback = func(_, _ string) error { return errors.New("offline") }
	p.Send("Gauss: data is stale", "No new data.", time.Now())
	if len(p.readQueue()) != 1 {
		t.Fatalf("an alert neither handle took must stay queued, got %d", len(p.readQueue()))
	}
}

func TestPhoneFallbackSetup(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	cfg := Config{PhoneTo: "+60123456789"}
	for _, bad := range []string{"not-a-handle", "+60123456789"} {
		if err := phoneFallbackSetup(bad, cfg); err == nil {
			t.Errorf("%q should be refused", bad)
		}
	}
	if err := phoneFallbackSetup("josh@example.com", cfg); err != nil {
		t.Fatal(err)
	}
	if got := loadConfig().PhoneFallback; got != "josh@example.com" {
		t.Fatalf("saved fallback %q", got)
	}
	if p := newPhoneFor(loadConfig()); phoneSupported && (p == nil || p.Fallback != "josh@example.com" || p.sendFallback == nil) {
		t.Fatalf("newPhoneFor should wire the fallback: %+v", p)
	}
	if err := phoneFallbackSetup("off", loadConfig()); err != nil || loadConfig().PhoneFallback != "" {
		t.Fatalf("off: %v %q", err, loadConfig().PhoneFallback)
	}
}
