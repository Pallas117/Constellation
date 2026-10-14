package main

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPhoneHandleValidation(t *testing.T) {
	for _, ok := range []string{"+60123456789", "me@icloud.com"} {
		if newPhone(ok, "d") == nil {
			t.Errorf("%s rejected", ok)
		}
	}
	for _, bad := range []string{"", "0123456789", `x" & do shell script "rm`, "me@icloud"} {
		if newPhone(bad, "d") != nil {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestPhoneQueuesWhileOfflineAndFlushesInOrder(t *testing.T) {
	var sent []string
	online := false
	p := newPhone("+60123456789", "judith")
	p.Queue = filepath.Join(t.TempDir(), "q.jsonl")
	p.send = func(_, text string) error {
		if !online {
			return errors.New("offline")
		}
		sent = append(sent, text)
		return nil
	}
	at := time.Date(2026, 10, 9, 8, 20, 0, 0, time.UTC)
	p.Send("Argo: REGION", "api.anthropic.com returned 403 (exit loc=HK)", at)
	p.Send("Argo: OFFLINE", "no default route", at)
	if n := len(p.readQueue()); n != 2 {
		t.Fatalf("queued %d, want 2", n)
	}
	online = true
	p.Flush()
	if len(sent) != 2 || !strings.Contains(sent[0], "REGION") || !strings.Contains(sent[1], "OFFLINE") || !strings.Contains(sent[0], "judith") {
		t.Fatalf("delivered %v", sent)
	}
	if len(p.readQueue()) != 0 {
		t.Fatal("queue not cleared")
	}
}

func TestPhoneMasksSecretsAndCapsQueue(t *testing.T) {
	p := newPhone("+60123456789", "d")
	p.Queue = filepath.Join(t.TempDir(), "q.jsonl")
	p.send = func(string, string) error { return errors.New("offline") }
	for i := 0; i < maxQueued+5; i++ {
		p.Send("Argo: DEAD_PROXY", "HTTPS_PROXY=http://user:pw@127.0.0.1:4000 token=abc123", time.Now())
	}
	q := p.readQueue()
	if len(q) != maxQueued {
		t.Fatalf("queue len %d", len(q))
	}
	if strings.Contains(q[0], "pw@") || strings.Contains(q[0], "abc123") {
		t.Fatalf("secret leaked: %q", q[0])
	}
}
