package main

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func relayEvents(l Loop) []string {
	var e []string
	for _, in := range l.Store.Incidents() {
		if in.Event == "relay" {
			e = append(e, in.Detail)
		}
	}
	return e
}

// TestOfflineTextedOnceThroughTheRelayAfterFiveMinutes (GAU-233).
func TestOfflineTextedOnceThroughTheRelayAfterFiveMinutes(t *testing.T) {
	off := offlineSnap(t, "On")
	l, fx := newLoop(t, off, off, off, off, off, off, off, off)
	l.Tick(context.Background())
	fx.now = fx.now.Add(3 * time.Minute)
	l.Tick(context.Background())
	if len(fx.relayed) != 0 {
		t.Fatalf("texted before 5 min: %v", fx.relayed)
	}
	fx.now = fx.now.Add(3 * time.Minute)
	l.Tick(context.Background())
	fx.now = fx.now.Add(30 * time.Minute)
	l.Tick(context.Background())
	if len(fx.relayed) != 1 || fx.relayed[0] != "Argo: Mac offline" {
		t.Fatalf("want one relayed text per outage, got %v", fx.relayed)
	}
	if e := relayEvents(l); len(e) != 1 || e[0] != "sent through the iPhone relay" {
		t.Fatalf("relay evidence: %v", e)
	}
}

// TestNewOutageTextsAgain: after recovery, the next outage gets its own text.
func TestNewOutageTextsAgain(t *testing.T) {
	off := offlineSnap(t, "On")
	ok := fixture(t, "my_sim_ok.json")
	l, fx := newLoop(t, off, off, off, ok, off, off, off, off)
	l.Tick(context.Background())
	fx.now = fx.now.Add(6 * time.Minute)
	l.Tick(context.Background()) // relay text, then the Wi-Fi cycle brings it back (ok)
	fx.now = fx.now.Add(time.Minute)
	l.Tick(context.Background()) // offline again: a new incident
	fx.now = fx.now.Add(6 * time.Minute)
	l.Tick(context.Background())
	if len(fx.relayed) != 2 {
		t.Fatalf("want a text per outage, got %v", fx.relayed)
	}
}

// TestRelayRefusedIsLoggedAsQueued: when Messages won't take it, the evidence says so.
func TestRelayRefusedIsLoggedAsQueued(t *testing.T) {
	off := offlineSnap(t, "On")
	l, fx := newLoop(t, off, off, off, off)
	fx.relayFail = true
	l.Tick(context.Background())
	fx.now = fx.now.Add(6 * time.Minute)
	l.Tick(context.Background())
	if e := relayEvents(l); len(e) != 1 || !strings.Contains(e[0], "queued") {
		t.Fatalf("relay evidence: %v", e)
	}
}

// TestSendRelayGoesSMSFirstAndQueuesOnFailure.
func TestSendRelayGoesSMSFirstAndQueuesOnFailure(t *testing.T) {
	var used []string
	p := &Phone{To: "+60123456789", Queue: filepath.Join(t.TempDir(), "q.jsonl"), Device: "judith",
		send:      func(_, _ string) error { used = append(used, "imessage"); return nil },
		sendRelay: func(_, _ string) error { used = append(used, "sms"); return nil }}
	if !p.SendRelay("t", "m", time.Now()) || strings.Join(used, ",") != "sms" {
		t.Fatalf("relay path: ok=false or used %v", used)
	}
	p.sendRelay = func(_, _ string) error { return errors.New("no relay") }
	if p.SendRelay("t", "m", time.Now()) || len(p.readQueue()) != 1 {
		t.Fatalf("a refused relay must be queued: %v", p.readQueue())
	}
}
