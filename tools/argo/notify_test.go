package main

import (
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testPhone(t *testing.T, send func(string, string) error) *Phone {
	p := newPhone("+60123456789", "judith")
	p.Queue = filepath.Join(t.TempDir(), "q.jsonl")
	p.send = send
	return p
}

func TestNotifyRateLimitsPerKey(t *testing.T) {
	var sent []string
	p := testPhone(t, func(_, text string) error { sent = append(sent, text); return nil })
	s := Store{Dir: t.TempDir()}
	at := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	args := []string{"-key", "battery-low", "-every", "30m", "Battery 9%", "plug in"}
	for _, d := range []time.Duration{0, 10 * time.Minute, 31 * time.Minute} {
		if err := notifyCmd(args, p, s, at.Add(d)); err != nil {
			t.Fatal(err)
		}
	}
	if err := notifyCmd([]string{"-key", "other", "-every", "30m", "Other", "x"}, p, s, at); err != nil {
		t.Fatal(err)
	}
	if len(sent) != 3 { // t=0 and t=31m for battery-low, plus the other key
		t.Fatalf("sent %d: %v", len(sent), sent)
	}
}

func TestNotifyRejectsBadInputAndMissingPhone(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	p := testPhone(t, func(string, string) error { return nil })
	for _, args := range [][]string{{"only-title"}, {"-key", "Bad Key!", "-every", "1m", "t", "m"}, {"-bogus", "t", "m"}} {
		if notifyCmd(args, p, s, time.Now()) == nil {
			t.Errorf("%v accepted", args)
		}
	}
	if notifyCmd([]string{"t", "m"}, nil, s, time.Now()) == nil {
		t.Error("no phone configured but no error")
	}
}

func TestNotifyMasksTruncatesAndQueuesOffline(t *testing.T) {
	online := false
	var sent []string
	p := testPhone(t, func(_, text string) error {
		if !online {
			return errors.New("offline")
		}
		sent = append(sent, text)
		return nil
	})
	s := Store{Dir: t.TempDir()}
	long := "token=abc123 " + strings.Repeat("x", 2*maxNotifyLen)
	if err := notifyCmd([]string{"Claude needs input", long}, p, s, time.Now()); err != nil {
		t.Fatal(err)
	}
	q := p.readQueue()
	if len(q) != 1 || strings.Contains(q[0], "abc123") || len([]rune(q[0])) > maxNotifyLen+80 {
		t.Fatalf("queue %q", q)
	}
	online = true
	p.Flush()
	if len(sent) != 1 || len(p.readQueue()) != 0 {
		t.Fatalf("sent %v", sent)
	}
}

func TestConcurrentSendsDoNotLoseAlerts(t *testing.T) {
	p := testPhone(t, func(string, string) error { return errors.New("offline") })
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); p.Send("t", "m", time.Now()) }()
	}
	wg.Wait()
	if n := len(p.readQueue()); n != 8 {
		t.Fatalf("queued %d of 8", n)
	}
}
