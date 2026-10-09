package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSlackWebhookMustBeSlack(t *testing.T) {
	if err := validWebhook("https://hooks.slack.com/services/T0/B0/xyz"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"http://hooks.slack.com/services/x", "https://evil.example/services/x", "https://hooks.slack.com.evil.example/services/x", "https://hooks.slack.com/other"} {
		if validWebhook(bad) == nil {
			t.Errorf("%s accepted", bad)
		}
	}
}

func TestSlackQueuesWhileOfflineAndFlushesInOrder(t *testing.T) {
	var mu sync.Mutex
	var got []string
	up := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		if !up {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		b, _ := io.ReadAll(r.Body)
		var m slackMsg
		_ = json.Unmarshal(b, &m)
		got = append(got, m.Text)
	}))
	defer srv.Close()
	s := &Slack{Webhook: srv.URL, Queue: filepath.Join(t.TempDir(), "q.jsonl"), Device: "judith", Client: srv.Client()}
	at := time.Date(2026, 10, 9, 8, 20, 0, 0, time.UTC)

	s.Send("Argo: REGION", "api.anthropic.com returned 403 (exit loc=HK)", at) // offline: queued
	s.Send("Argo: OFFLINE", "no default route", at)
	if n := len(s.readQueue()); n != 2 {
		t.Fatalf("queued %d, want 2", n)
	}
	up = true
	s.Flush()
	if len(got) != 2 || !strings.Contains(got[0], "REGION") || !strings.Contains(got[1], "OFFLINE") {
		t.Fatalf("delivered %v", got)
	}
	if len(s.readQueue()) != 0 {
		t.Fatal("queue not cleared")
	}
	if !strings.Contains(got[0], "`judith`") {
		t.Errorf("device missing: %q", got[0])
	}
}

func TestSlackMasksSecretsAndCapsQueue(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer srv.Close()
	s := &Slack{Webhook: srv.URL, Queue: filepath.Join(t.TempDir(), "q.jsonl"), Device: "d", Client: srv.Client()}
	for i := 0; i < maxQueued+5; i++ {
		s.Send("Argo: DEAD_PROXY", "HTTPS_PROXY=http://user:pw@127.0.0.1:4000 token=abc123", time.Now())
	}
	q := s.readQueue()
	if len(q) != maxQueued {
		t.Fatalf("queue len %d", len(q))
	}
	if strings.Contains(q[0], "pw@") || strings.Contains(q[0], "abc123") {
		t.Fatalf("secret leaked: %q", q[0])
	}
}
