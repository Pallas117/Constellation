package main

// Range alerts (Josh, 18 Nov 2026: "we probably need network range notifications
// too"). Two gaps are closed here, and both reuse a detector Argo already has:
//
//   - "Wi-Fi is fading": the low-signal detector (lowsignal.go, 3 bad probes in,
//     10 good plus 15 min out) says the link is bad AND the Wi-Fi signal Argo
//     measured is weak. One text per network at most every 2 h, before the link
//     drops. Never on a wired link, never when the signal was not measured, and
//     never while OFFLINE (a Mac with no network cannot send; the text would
//     arrive stale). Leaving the low state clears it with one status line, no text.
//   - "laptop out of reach": the watched-device check (devices.go) now also
//     covers this user's computers, at 10 min instead of the phones' 30, with one
//     text per outage.
//
// Nothing here fixes anything, so no fix is ever credited: the incident log
// records when the fading began and ended, tied to the network.

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"
)

const (
	fadeAfter       = 2 * time.Minute  // in the low state this long before a text: one more probe has agreed
	fadeRemindEvery = 2 * time.Hour    // README "Alerts stay quiet on purpose": at most every 2 h
	fadeClearedShow = 30 * time.Minute // how long `argo status` says "back to normal"
	fadeWeakSNR     = 25               // dB; below this signalGrade is "fair" (drops likely) or "poor"
	fadeWeakRSSI    = -75              // dBm; the detector's own "not good" edge (isGoodSample)

	laptopOfflineAfter = 10 * time.Minute
	laptopRemindEvery  = 2 * time.Hour  // a laptop flapping at the edge of range still texts at most this often
	laptopFreshFor     = 24 * time.Hour // a computer nobody named that has been gone longer is not "just out of range"
	laptopStatusFresh  = 30 * time.Minute
	maxRangeDevices    = 64
)

// FadeAlert is the persisted state of the fading alert (State.Fade).
type FadeAlert struct {
	Active    bool      `json:"active,omitempty"` // true while the conditions held at the last check
	Since     time.Time `json:"since,omitempty"`  // when this low-signal episode first met them
	SNR       int       `json:"snr,omitempty"`    // dB, as last measured
	RSSI      int       `json:"rssi,omitempty"`   // dBm, as last measured
	FP        string    `json:"fp,omitempty"`     // the network it belongs to
	ClearedAt time.Time `json:"cleared_at,omitempty"`
}

// weakWiFiSignal says whether a measured signal is weak, and its SNR. A nil
// signal (not on Wi-Fi, or not measured) is never weak: Argo does not guess.
func weakWiFiSignal(sig *WiFiSignal) (snr int, weak bool) {
	if sig == nil {
		return 0, false
	}
	snr = sig.RSSI - sig.Noise
	return snr, snr < fadeWeakSNR || sig.RSSI <= fadeWeakRSSI
}

func wiredVia(via string) bool { return via == "usb" || via == "ethernet" }

func fadeMessage(snr, rssi int, st State) string {
	msg := fmt.Sprintf("Wi-Fi signal is %s (SNR %d dB, %d dBm) and the link is already slow or losing checks, so it may drop soon. "+
		"Move closer to the router or hotspot, or switch network.", signalGrade(snr), snr, rssi)
	if st.Advice != "" {
		return msg + adviceSuffix(st)
	}
	return msg + " A phone on a USB cable holds better than its Wi-Fi hotspot."
}

// fadeWatch runs once per probe, after the low-signal detector and the link
// check. It never adds a second detector: st.Low decides when the episode
// starts and ends; this only decides whether the cause is a weak Wi-Fi signal
// worth one text.
func (l Loop) fadeWatch(st *State, snap Snapshot, class Class, fp string, now time.Time) {
	f := &st.Fade
	if !st.Low.On {
		if !f.Since.IsZero() { // the detector left the low state: clear quietly, credit nothing
			_ = l.Store.Append(Incident{Time: now, Event: "fading-cleared", Class: class, Fingerprint: f.FP,
				Detail: "low-signal mode ended after " + now.Sub(f.Since).Round(time.Minute).String()})
			l.say("Wi-Fi signal back to normal")
			*f = FadeAlert{ClearedAt: now}
		}
		return
	}
	snr, weak := weakWiFiSignal(snap.Signal)
	f.Active = weak && snap.Online && class != Offline && !wiredVia(st.Via) && now.Sub(st.Low.Since) >= fadeAfter
	if !f.Active {
		return
	}
	first := f.Since.IsZero()
	if first {
		f.Since, f.ClearedAt = now, time.Time{}
	}
	f.SNR, f.RSSI, f.FP = snr, snap.Signal.RSSI, fp
	if l.NoFadeAlert {
		return
	}
	key := "wifi-fading"
	if len(fp) >= 12 {
		key += "-" + fp[:12] // per network: an incident belongs to the network the Mac was on
	}
	if !shouldNotify(l.Store, key, fadeRemindEvery, now) {
		return
	}
	_ = l.Store.Append(Incident{Time: now, Event: "fading", Class: class, Fingerprint: fp,
		Detail: fmt.Sprintf("SNR %d dB, RSSI %d dBm", snr, snap.Signal.RSSI)})
	l.Fx.Notify("Argo: Wi-Fi is fading", fadeMessage(snr, snap.Signal.RSSI, *st))
}

// fadeStatus is the `argo status` line: one while fading, one for a while after it cleared.
func fadeStatus(st State, now time.Time) string {
	f := st.Fade
	switch {
	case f.Active && st.Low.On:
		return fmt.Sprintf("\n  Wi-Fi is fading since %s (SNR %d dB): move closer or switch network", f.Since.Local().Format("15:04"), f.SNR)
	case !f.ClearedAt.IsZero() && now.Sub(f.ClearedAt) >= 0 && now.Sub(f.ClearedAt) < fadeClearedShow:
		return "\n  Wi-Fi signal back to normal since " + f.ClearedAt.Local().Format("15:04")
	}
	return ""
}

// ---- laptops and servers off the tailnet ----

func isPhoneOS(os string) bool {
	return strings.EqualFold(os, "iOS") || strings.EqualFold(os, "android")
}

func isComputerOS(os string) bool {
	return strings.EqualFold(os, "macOS") || strings.EqualFold(os, "linux") || strings.EqualFold(os, "windows")
}

// cleanHost keeps a tailnet name to hostname characters, so a peer's name can
// never carry anything else into a text or a state file.
func cleanHost(h string) string {
	h = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			return r
		}
		return -1
	}, h)
	if len(h) > 63 {
		h = h[:63]
	}
	return h
}

func laptopMessage(a deviceAlert, now time.Time) string {
	since := "It has not been seen on the tailnet."
	if a.Offline > 0 {
		at := now.Add(-a.Offline).Local()
		format := "15:04"
		if a.Offline >= 20*time.Hour {
			format = "Jan 2 15:04"
		}
		since = fmt.Sprintf("Off the tailnet since %s (%s).", at.Format(format), roughly(a.Offline))
	}
	return a.Host + ": " + since + " It may be out of Wi-Fi range, asleep or shut down. " +
		"Nothing to do if you closed it; otherwise bring it back into range or wake it. One text per outage."
}

type rangeEntry struct {
	Since time.Time `json:"since,omitempty"` // last seen on the tailnet
	Told  time.Time `json:"told,omitempty"`  // when this outage was texted; zero = not yet
}

// rangeState is devices-range.json: the computers off the tailnet at the last check.
type rangeState struct {
	Checked time.Time             `json:"checked"`
	Off     map[string]rangeEntry `json:"off,omitempty"`
}

func loadRange(s Store) rangeState {
	var r rangeState
	if b, err := os.ReadFile(s.path("devices-range.json")); err == nil {
		_ = json.Unmarshal(b, &r)
	}
	return r
}

func saveRange(s Store, r rangeState) {
	b, _ := json.Marshal(r)
	_ = os.MkdirAll(s.Dir, 0o700)
	_ = os.WriteFile(s.path("devices-range.json"), b, 0o600) // if this fails, the 2 h key limit still holds
}

// rangeRound texts once per outage for each computer in alerts and remembers
// which outages were told. A device that is back (no longer in alerts) is
// forgotten, so its next outage texts again, but never sooner than
// laptopRemindEvery after the last text for it. send nil only lists.
func rangeRound(alerts []deviceAlert, s Store, send func(title, msg string), now time.Time) {
	if send == nil {
		return
	}
	old := loadRange(s)
	next := rangeState{Checked: now, Off: map[string]rangeEntry{}}
	for _, a := range alerts {
		if !a.Laptop || len(next.Off) >= maxRangeDevices {
			continue
		}
		host := strings.ToLower(a.Host)
		e := old.Off[host]
		if a.Offline > 0 {
			e.Since = now.Add(-a.Offline)
		}
		if e.Told.IsZero() && shouldNotify(s, "device-range-"+host, laptopRemindEvery, now) {
			send("Argo: "+a.Host+" is out of reach", laptopMessage(a, now))
			e.Told = now
		}
		next.Off[host] = e
	}
	saveRange(s, next)
}

// rangeStatus is the `argo status` line for computers off the tailnet at the
// last check. It only reads Argo's own file and says nothing once that is stale.
func rangeStatus(s Store, now time.Time) string {
	r := loadRange(s)
	if len(r.Off) == 0 || now.Sub(r.Checked) > laptopStatusFresh || now.Before(r.Checked) {
		return ""
	}
	hosts := make([]string, 0, len(r.Off))
	for h := range r.Off {
		hosts = append(hosts, h)
	}
	sort.Strings(hosts)
	var b strings.Builder
	for _, h := range hosts {
		if e := r.Off[h]; e.Since.IsZero() {
			fmt.Fprintf(&b, "\n  %s is off the tailnet", h)
		} else {
			fmt.Fprintf(&b, "\n  %s is off the tailnet (%s): out of range, asleep or off", h, roughly(now.Sub(e.Since)))
		}
	}
	return b.String()
}
