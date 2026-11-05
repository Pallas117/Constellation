package main

import (
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// `argo notify` lets other local tools (mesh-heal, the gauss-awake battery
// guard, Claude Code hooks) reach the phone through Argo's iMessage channel,
// so every alert shares one handle, one mask and one offline queue.

const maxNotifyLen = 600 // an iMessage alert should read at a glance

var notifyKeyRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// queueLock serialises the queue's read-modify-write between a tick's Flush
// and concurrent `argo notify` runs. It waits briefly rather than failing,
// because a lost alert is worse than a slow one.
func (p *Phone) queueLock() (func(), error) {
	l := p.Queue + ".lock"
	if err := os.MkdirAll(filepath.Dir(l), 0o700); err != nil {
		return nil, err
	}
	for i := 0; i < 240; i++ { // ~60s: a Flush of 20 queued iMessages can take a while
		if f, err := os.OpenFile(l, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600); err == nil {
			f.Close()
			return func() { os.Remove(l) }, nil
		}
		if fi, err := os.Stat(l); err == nil && time.Since(fi.ModTime()) > 3*time.Minute {
			os.Remove(l) // left by a killed run
			continue
		}
		time.Sleep(250 * time.Millisecond)
	}
	return nil, errors.New("phone queue is busy")
}

// shouldNotify records and reports whether an alert with this key may go out
// now: at most once per `every`. An empty key or zero interval always sends.
// Two racing callers can both send; a rare duplicate beats a lost alert.
func shouldNotify(s Store, key string, every time.Duration, now time.Time) bool {
	if key == "" || every <= 0 {
		return true
	}
	path := s.path("notify-sent.json")
	sent := map[string]time.Time{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &sent)
	}
	if last, ok := sent[key]; ok && now.Sub(last) < every {
		return false
	}
	sent[key] = now
	for k, t := range sent { // forget keys idle for a week
		if now.Sub(t) > 7*24*time.Hour {
			delete(sent, k)
		}
	}
	b, _ := json.Marshal(sent)
	_ = os.MkdirAll(s.Dir, 0o700)
	_ = os.WriteFile(path, b, 0o600) // if this fails, alerting beats silence
	return true
}

// notifyCmd: `argo notify [-key K -every 30m] TITLE MESSAGE`.
func notifyCmd(args []string, phone *Phone, s Store, now time.Time) error {
	fs := flag.NewFlagSet("notify", flag.ContinueOnError)
	key := fs.String("key", "", "rate-limit key (lowercase, e.g. battery-low)")
	every := fs.Duration("every", 0, "send at most once per this interval for -key")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() != 2 {
		return errors.New("usage: argo notify [-key K -every 30m] TITLE MESSAGE")
	}
	if *key != "" && !notifyKeyRe.MatchString(*key) {
		return errors.New("-key must be lowercase letters, digits, '.', '_' or '-'")
	}
	if phone == nil {
		return errors.New("phone alerts are not set up; run `argo phone <number>`")
	}
	title, msg := fs.Arg(0), fs.Arg(1)
	if r := []rune(msg); len(r) > maxNotifyLen {
		msg = string(r[:maxNotifyLen-1]) + "…"
	}
	if !shouldNotify(s, *key, *every, now) {
		return nil
	}
	phone.Send(title, msg, now) // queued if offline; the next tick delivers it
	return nil
}
