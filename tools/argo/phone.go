package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
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

// iMessage passes the handle and text as argv items; they are never
// interpolated into the script.
func iMessage(to, text string) error {
	out, err := exec.Command("osascript",
		"-e", "on run argv",
		"-e", `tell application "Messages"`,
		"-e", "set svc to 1st account whose service type = iMessage",
		"-e", "send (item 2 of argv) to participant (item 1 of argv) of svc",
		"-e", "end tell",
		"-e", "end run",
		to, text).CombinedOutput()
	if err != nil {
		return fmt.Errorf("Messages: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// Send delivers any queued alerts first, then this one; failures are queued.
func (p *Phone) Send(title, msg string, at time.Time) {
	text := fmt.Sprintf("%s on %s (%s)\n%s", Mask(title), p.Device, at.Local().Format("15:04"), Mask(msg))
	p.deliver(append(p.readQueue(), text))
}

// Flush retries queued alerts; called every tick so offline alerts arrive once back online.
func (p *Phone) Flush() {
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
		p := newPhone(cfg.PhoneTo, cfg.Device)
		if p == nil {
			return errors.New("no phone configured; run `argo phone <your number or Apple ID email>`")
		}
		if err := p.send(p.To, fmt.Sprintf("Argo test from %s: phone alerts are working.", p.Device)); err != nil {
			return err
		}
		fmt.Println("sent an iMessage to", p.To)
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
