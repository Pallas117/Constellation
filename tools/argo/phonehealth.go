package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Phone health: texts can stop leaving this Mac without any error the owner
// sees. On 5 Nov 2026 a rebuilt binary lost its Messages permission and every
// alert queued silently for hours; the queue keeps only the newest maxQueued,
// so older alerts were lost. Argo now notices: `argo status` says texts are
// failing, a desktop banner says what to do at the Mac, and the first text
// after recovery says how many alerts were lost.

const phoneFailBanner = 10 * time.Minute // failing this long: say so on the desktop, once

type phoneHealth struct {
	FailSince time.Time `json:"fail_since,omitzero"`
	Queued    int       `json:"queued,omitempty"`
	Dropped   int       `json:"dropped,omitempty"` // alerts pushed out of the full queue
	Bannered  bool      `json:"bannered,omitempty"`
}

var desktopBanner = func(title, msg string) {
	if os.Getenv("ARGO_NO_DESKTOP") == "" {
		desktopNotify(title, msg)
	}
}

func phoneHealthPath(stateDir string) string { return filepath.Join(stateDir, "phone-health.json") }

func loadPhoneHealth(stateDir string) phoneHealth {
	var h phoneHealth
	if b, err := os.ReadFile(phoneHealthPath(stateDir)); err == nil {
		_ = json.Unmarshal(b, &h)
	}
	return h
}

// noteDelivery records the outcome of one delivery pass: failed is how many
// texts are still waiting, dropped how many of them no longer fit the queue.
// It returns a text to send when delivery has just recovered after losing alerts.
func (p *Phone) noteDelivery(failed, dropped int, now time.Time) string {
	dir := filepath.Dir(p.Queue)
	h := loadPhoneHealth(dir)
	if failed == 0 {
		if h.FailSince.IsZero() {
			return ""
		}
		os.Remove(phoneHealthPath(dir))
		if h.Dropped == 0 {
			return ""
		}
		return fmt.Sprintf("Argo: texts are working again on %s (%s)\n%d alerts were lost while texts could not be sent (from %s). Check `argo status` and the Gauss page for what happened.",
			p.Device, now.Local().Format("15:04"), h.Dropped, h.FailSince.Local().Format("15:04"))
	}
	if h.FailSince.IsZero() {
		h.FailSince = now
	}
	h.Queued, h.Dropped = failed-dropped, h.Dropped+dropped
	if !h.Bannered && now.Sub(h.FailSince) >= phoneFailBanner {
		h.Bannered = true
		desktopBanner("Argo: texts are not reaching your phone", "Run `argo phone test` at this Mac and click Allow if macOS asks.")
	}
	b, _ := json.Marshal(h)
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(phoneHealthPath(dir), b, 0o600)
	return ""
}

// phoneStatus is the part of `argo status` that says texts are failing; "" when they are fine.
func phoneStatus(stateDir string, now time.Time) string {
	h := loadPhoneHealth(stateDir)
	if h.FailSince.IsZero() {
		return ""
	}
	s := fmt.Sprintf("\n  texts NOT reaching the phone since %s (%d waiting", h.FailSince.Local().Format("Jan 2 15:04"), h.Queued)
	if h.Dropped > 0 {
		s += fmt.Sprintf(", %d lost", h.Dropped)
	}
	return s + "): run `argo phone test` at the Mac"
}
