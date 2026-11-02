package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Phone alerts are iMessages from this Mac's Messages app to the user's own
// handle, so they reach the iPhone with no tokens or third-party apps. Only
// the masked title and reason are sent. Alerts that fail (e.g. offline) are
// queued and sent on the next successful alert or tick.

const maxQueued = 20

// handleRe accepts an E.164 phone number or an email address, nothing else,
// so the value can't smuggle anything into the AppleScript arguments.
var handleRe = regexp.MustCompile(`^(\+[1-9][0-9]{6,14}|[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})$`)

type Phone struct {
	To     string
	Queue  string // jsonl file of pending alerts
	Device string
	send   func(to, text string) error // replaced in tests
	// Slack, when set up, gets every alert too (GAU-197); info-level alerts go only there.
	Slack *Phone
}

// AlertLevel routes an alert: urgent and warn text the phone, info is Slack only.
// Every level goes to Slack when it is set up.
type AlertLevel int

const (
	AlertWarn AlertLevel = iota
	AlertUrgent
	AlertInfo
)

func parseLevel(s string) (AlertLevel, error) {
	switch strings.ToLower(s) {
	case "", "warn":
		return AlertWarn, nil
	case "urgent":
		return AlertUrgent, nil
	case "info":
		return AlertInfo, nil
	}
	return AlertWarn, errors.New("-level must be urgent, warn or info")
}

// Several watchers (gauss-services, remote-watch, gauss-tpm-watch, the guard)
// report the same battery/disk/memory condition, each with its own dedupe.
// One gate per topic stops one event becoming several texts. Recoveries and
// critical alerts always pass, so the gate can only delay a repeat, never
// hide a change.
const topicWindow = 30 * time.Minute

var (
	topicRes = []struct {
		topic string
		re    *regexp.Regexp
	}{
		{"battery", regexp.MustCompile(`(?i)\b(battery|charger|charging|power adapter)\b`)},
		{"disk", regexp.MustCompile(`(?i)\b(disk|storage|free space)\b`)},
		{"memory", regexp.MustCompile(`(?i)\b(memory|swap|ram)\b`)},
	}
	topicPassRe = regexp.MustCompile(`(?i)\b(recovered|restored|back to normal|cleared|resolved|ok again|critical|emergency|shutting down)\b`)
)

func alertTopic(title, msg string) string {
	text := title + " " + msg
	if topicPassRe.MatchString(text) {
		return ""
	}
	for _, t := range topicRes {
		if t.re.MatchString(text) {
			return t.topic
		}
	}
	return ""
}

func newPhone(to, device string) *Phone {
	if !handleRe.MatchString(to) {
		return nil
	}
	if device == "" {
		device, _ = os.Hostname()
		device = strings.TrimSuffix(device, ".local")
	}
	return &Phone{To: to, Queue: filepath.Join(DefaultStore().Dir, "phone-queue.jsonl"), Device: device, send: iMessage}
}

// newPhoneFor builds the phone from config, choosing the send order.
func newPhoneFor(cfg Config) *Phone {
	if !phoneSupported { // phone alerts go through macOS Messages
		return nil
	}
	p := newPhone(cfg.PhoneTo, cfg.Device)
	if p != nil && strings.EqualFold(cfg.PhoneService, "sms") && strings.HasPrefix(p.To, "+") {
		p.send = smsFirst
	}
	if p != nil {
		p.Slack = newSlack(configDir(), filepath.Dir(p.Queue), p.Device)
	}
	return p
}

// smsFirst sends an SMS (via the iPhone's Text Message Forwarding), which
// shows a banner even when it comes from your own number, then falls back to
// iMessage.
func smsFirst(to, text string) error {
	if err := messagesSend("SMS", to, text); err == nil {
		return nil
	}
	return messagesSend("iMessage", to, text)
}

// iMessage sends over iMessage, then falls back to SMS (the iPhone's Text
// Message Forwarding) for a phone-number handle, so one broken service
// doesn't silence alerts. Handle and text are argv items, never
// interpolated into the script.
func iMessage(to, text string) error {
	err := messagesSend("iMessage", to, text)
	if err != nil && strings.HasPrefix(to, "+") {
		if smsErr := messagesSend("SMS", to, text); smsErr == nil {
			return nil
		}
	}
	return err
}

// A send that macOS hasn't authorised (or Messages that hangs) times out
// instead of holding the tick for the ~2 min AppleEvent default.
const sendTimeout = 30 * time.Second

// Send is SendLevel at warn: the phone and Slack.
func (p *Phone) Send(title, msg string, at time.Time) { p.SendLevel(AlertWarn, title, msg, at) }

// SendLevel routes one alert by level after the shared topic gate.
func (p *Phone) SendLevel(level AlertLevel, title, msg string, at time.Time) {
	if level != AlertUrgent {
		if t := alertTopic(title, msg); t != "" && !shouldNotify(Store{Dir: filepath.Dir(p.Queue)}, "topic-"+t, topicWindow, at) {
			return
		}
	}
	if p.Slack != nil {
		p.Slack.send1(title, msg, at)
	}
	if level != AlertInfo && p.send != nil {
		p.send1(title, msg, at)
	}
}

// send1 delivers any queued alerts first, then this one; failures are queued.
func (p *Phone) send1(title, msg string, at time.Time) {
	text := fmt.Sprintf("%s on %s (%s)\n%s", Mask(title), p.Device, at.Local().Format("15:04"), Mask(msg))
	if unlock, err := p.queueLock(); err == nil {
		defer unlock()
	} // still best-effort deliver if the lock is stuck
	p.deliver(append(p.readQueue(), text))
}

// Flush retries queued alerts; called every tick so offline alerts arrive once back online.
func (p *Phone) Flush() {
	if p.Slack != nil {
		p.Slack.Flush()
	}
	if unlock, err := p.queueLock(); err == nil {
		defer unlock()
	}
	if q := p.readQueue(); len(q) > 0 {
		p.deliver(q)
	}
}

func (p *Phone) deliver(pending []string) {
	var failed []string
	for _, t := range pending {
		if len(failed) > 0 || p.send(p.To, t) != nil {
			failed = append(failed, t) // keep order: stop at the first failure
		}
	}
	p.writeQueue(failed)
}

func (p *Phone) readQueue() []string {
	f, err := os.Open(p.Queue)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var t string
		if json.Unmarshal(sc.Bytes(), &t) == nil {
			out = append(out, t)
		}
	}
	return out
}

func (p *Phone) writeQueue(q []string) {
	if len(q) > maxQueued {
		q = q[len(q)-maxQueued:]
	}
	if len(q) == 0 {
		os.Remove(p.Queue)
		return
	}
	_ = os.MkdirAll(filepath.Dir(p.Queue), 0o700)
	var b bytes.Buffer
	for _, t := range q {
		j, _ := json.Marshal(t)
		b.Write(append(j, '\n'))
	}
	_ = os.WriteFile(p.Queue, b.Bytes(), 0o600)
}

// phoneSetup: `argo phone <+60123456789|you@icloud.com>`, `argo phone test`, `argo phone off`.
func phoneSetup(args []string, cfg Config) error {
	if len(args) != 1 {
		return errors.New("usage: argo phone <your iMessage phone (+60...) or email> | test | off")
	}
	switch args[0] {
	case "test":
		p := newPhoneFor(cfg)
		if p == nil {
			return errors.New("no phone configured; run `argo phone <your number or Apple ID email>`")
		}
		if err := p.send(p.To, fmt.Sprintf("Argo test from %s: phone alerts are working.", p.Device)); err != nil {
			return err
		}
		fmt.Println("sent a test alert to", p.To)
		return nil
	case "off":
		cfg.PhoneTo = ""
		fmt.Println("phone alerts off.")
		return saveConfig(cfg)
	}
	if !handleRe.MatchString(args[0]) {
		return errors.New("use your iMessage phone number in international form (+60...) or your Apple ID email")
	}
	cfg.PhoneTo = args[0]
	if err := saveConfig(cfg); err != nil {
		return err
	}
	fmt.Println("saved. Run `argo phone test` (macOS will ask once to let it control Messages).")
	return nil
}
