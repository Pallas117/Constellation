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
	// sendRelay is for alerts sent while this Mac has no network (GAU-233): SMS first, so Messages
	// hands it to the iPhone over Continuity instead of holding an iMessage it can't deliver.
	sendRelay func(to, text string) error
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
	if p != nil {
		p.sendRelay = smsFirst
	}
	if p != nil && strings.EqualFold(cfg.PhoneService, "sms") && strings.HasPrefix(p.To, "+") {
		p.send = smsFirst
	}
	return p
}

// smsFirst sends an SMS (via the iPhone's Text Message Forwarding), which
// shows a banner even when it comes from your own number, then falls back to
// iMessage. Messages accepts an SMS before the iPhone has sent it, so a text
// the iPhone then fails (a red "Not Delivered" on 2 Nov) looked sent and was
// never retried: the outcome is now read back (smsOutcome) and a failed SMS
// goes out again over iMessage.
func smsFirst(to, text string) error {
	at := time.Now()
	if err := sendVia("SMS", to, text); err == nil && !smsFailed(to, at) {
		return nil
	}
	return sendVia("iMessage", to, text)
}

// sendVia and smsStatus are the host calls, replaced in tests.
var (
	sendVia   = messagesSend
	smsStatus = chatDBStatus
)

// smsState is what Messages has recorded for the SMS just sent.
type smsState int

const (
	smsUnreadable  smsState = iota // Argo can't read Messages' records (no Full Disk Access), or not macOS
	smsPending                     // not recorded yet, or the iPhone hasn't confirmed it
	smsSent                        // the iPhone sent it
	smsFailedState                 // Messages marked it "Not Delivered"
)

const (
	smsCheckFor   = 20 * time.Second // the iPhone usually confirms within a few seconds
	smsCheckEvery = 2 * time.Second
)

// smsFailed waits briefly for the iPhone's verdict on an SMS sent at `at`.
// Only a recorded failure counts: no access, or no verdict in time, keeps the
// old behaviour (treated as sent), so a missing permission never doubles texts.
func smsFailed(to string, at time.Time) bool {
	deadline := time.Now().Add(smsCheckFor)
	for {
		switch smsStatus(to, at) {
		case smsFailedState:
			return true
		case smsSent, smsUnreadable:
			return false
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(smsCheckEvery)
	}
}

// smsOutcome reads one row of Messages' records as sqlite3 -json prints it:
// the error code and sent/delivered flags of the oldest SMS to the handle
// since the send. No message text is read.
func smsOutcome(out []byte) smsState {
	var rows []struct {
		Error       int `json:"error"`
		IsSent      int `json:"is_sent"`
		IsDelivered int `json:"is_delivered"`
	}
	if json.Unmarshal(bytes.TrimSpace(out), &rows) != nil || len(rows) == 0 {
		return smsPending
	}
	switch r := rows[0]; {
	case r.Error != 0:
		return smsFailedState
	case r.IsSent != 0 || r.IsDelivered != 0:
		return smsSent
	}
	return smsPending
}

// iMessage sends over iMessage, then falls back to SMS (the iPhone's Text
// Message Forwarding) for a phone-number handle, so one broken service
// doesn't silence alerts. Handle and text are argv items, never
// interpolated into the script.
func iMessage(to, text string) error {
	err := sendVia("iMessage", to, text)
	if err != nil && strings.HasPrefix(to, "+") {
		if smsErr := sendVia("SMS", to, text); smsErr == nil {
			return nil
		}
	}
	return err
}

// A send that macOS hasn't authorised (or Messages that hangs) times out
// instead of holding the tick for the ~2 min AppleEvent default.
const sendTimeout = 30 * time.Second

// Send delivers any queued alerts first, then this one; failures are queued.
func (p *Phone) Send(title, msg string, at time.Time) {
	text := fmt.Sprintf("%s on %s (%s)\n%s", Mask(title), p.Device, at.Local().Format("15:04"), Mask(msg))
	if unlock, err := p.queueLock(); err == nil {
		defer unlock()
	} // still best-effort deliver if the lock is stuck
	p.deliver(append(p.readQueue(), text))
}

// SendRelay sends one alert while this Mac is offline and reports whether Messages accepted it.
// A failure is queued like any other alert, so it still arrives once the Mac is back online.
func (p *Phone) SendRelay(title, msg string, at time.Time) bool {
	text := fmt.Sprintf("%s on %s (%s)\n%s", Mask(title), p.Device, at.Local().Format("15:04"), Mask(msg))
	send := p.send
	if p.sendRelay != nil && strings.HasPrefix(p.To, "+") {
		send = p.sendRelay
	}
	if unlock, err := p.queueLock(); err == nil {
		defer unlock()
	}
	if err := send(p.To, text); err != nil {
		p.writeQueue(append(p.readQueue(), text))
		return false
	}
	return true
}

// Flush retries queued alerts; called every tick so offline alerts arrive once back online.
func (p *Phone) Flush() {
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
		if strings.EqualFold(cfg.PhoneService, "sms") {
			if chatDBReadable() {
				fmt.Println("delivery check: on (an SMS the iPhone fails is resent over iMessage)")
			} else {
				fmt.Println("delivery check: off. Argo can't see whether the iPhone sent the SMS, so a red \"Not Delivered\" text is not resent.")
				fmt.Println("  To turn it on: System Settings > Privacy & Security > Full Disk Access > + > ~/.local/bin/argo")
			}
		}
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
