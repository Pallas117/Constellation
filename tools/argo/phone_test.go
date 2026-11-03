package main

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestPhoneServiceChoosesSendOrder(t *testing.T) {
	if !phoneSupported {
		t.Skip("phone alerts go through macOS Messages; off on this OS")
	}
	ptr := func(f func(string, string) error) uintptr { return reflect.ValueOf(f).Pointer() }
	cases := []struct {
		cfg  Config
		want func(string, string) error
	}{
		{Config{PhoneTo: "+60123456789", PhoneService: "sms"}, smsFirst},
		{Config{PhoneTo: "+60123456789", PhoneService: "SMS"}, smsFirst},
		{Config{PhoneTo: "+60123456789"}, iMessage},                       // default stays iMessage first
		{Config{PhoneTo: "me@icloud.com", PhoneService: "sms"}, iMessage}, // SMS needs a phone number
	}
	for _, c := range cases {
		p := newPhoneFor(c.cfg)
		if p == nil || ptr(p.send) != ptr(c.want) {
			t.Errorf("%+v: wrong send order", c.cfg)
		}
	}
	if newPhoneFor(Config{PhoneTo: "not a handle", PhoneService: "sms"}) != nil {
		t.Error("invalid handle must not build a phone")
	}
}

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

func TestSMSOutcomeReadsTheRow(t *testing.T) {
	for _, c := range []struct {
		out  string
		want smsState
	}{
		{"", smsPending}, // not recorded yet
		{`[{"error":0,"is_sent":0,"is_delivered":0}]`, smsPending},
		{`[{"error":0,"is_sent":1,"is_delivered":0}]`, smsSent},
		{`[{"error":0,"is_sent":0,"is_delivered":1}]`, smsSent},
		{`[{"error":22,"is_sent":0,"is_delivered":0}]` + "\n", smsFailedState},
		{"not json", smsPending},
	} {
		if got := smsOutcome([]byte(c.out)); got != c.want {
			t.Errorf("%q: got %d, want %d", c.out, got, c.want)
		}
	}
}

// TestSMSFirstResendsAFailedSMSOverIMessage: Messages accepts the SMS, the
// iPhone then fails it; the alert goes out again over iMessage. A sent SMS,
// or one Argo can't check, is not doubled.
func TestSMSFirstResendsAFailedSMSOverIMessage(t *testing.T) {
	oldSend, oldStatus := sendVia, smsStatus
	t.Cleanup(func() { sendVia, smsStatus = oldSend, oldStatus })
	for _, c := range []struct {
		name   string
		states []smsState
		want   []string
	}{
		{"failed after a moment", []smsState{smsPending, smsFailedState}, []string{"SMS", "iMessage"}},
		{"sent", []smsState{smsPending, smsSent}, []string{"SMS"}},
		{"no Full Disk Access", []smsState{smsUnreadable}, []string{"SMS"}},
	} {
		var via []string
		sendVia = func(service, _, _ string) error { via = append(via, service); return nil }
		i := 0
		smsStatus = func(string, time.Time) smsState {
			st := c.states[min(i, len(c.states)-1)]
			i++
			return st
		}
		if err := smsFirst("+60123456789", "x"); err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if strings.Join(via, ",") != strings.Join(c.want, ",") {
			t.Errorf("%s: sent via %v, want %v", c.name, via, c.want)
		}
	}
	// Messages refuses the SMS outright: iMessage at once, no status wait.
	var via []string
	sendVia = func(service, _, _ string) error {
		via = append(via, service)
		if service == "SMS" {
			return errors.New("no SMS account")
		}
		return nil
	}
	smsStatus = func(string, time.Time) smsState { t.Fatal("status read after a refused send"); return smsPending }
	if err := smsFirst("+60123456789", "x"); err != nil || strings.Join(via, ",") != "SMS,iMessage" {
		t.Errorf("refused SMS: %v %v", via, err)
	}
}
