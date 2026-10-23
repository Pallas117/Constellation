package main

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Network scores (GAU-170): privacy, speed and signal for the phone texts and
// Gauss's /mesh page. Honest by construction: every score is built only from
// what this probe measured, every privacy point lost names its reason, and
// anything not measured says "not measured" instead of a guess.
//
//   Privacy  100 minus deductions for what others on this network can see or
//            reach: TLS interception, open or weak Wi-Fi, this Mac's sharing
//            services, auto-proxy, a captive portal. A Tailscale exit node
//            tunnels traffic past the local network, so it softens Wi-Fi only.
//   Speed    TCP connect time to api.anthropic.com on the probe Argo already
//            makes: one network round trip, no extra traffic. Not throughput.
//   Signal   Wi-Fi signal-to-noise ratio from system_profiler (no sudo).

const notMeasured = "not measured"

// WiFiSignal is the current network's received signal and noise floor in dBm.
type WiFiSignal struct {
	RSSI  int    `json:"rssi"`
	Noise int    `json:"noise"`
	Radio *Radio `json:"radio,omitempty"` // band, channel, congestion (radio.go); same source and cache
}

// NetScore is what a text or Gauss shows about the network right now.
type NetScore struct {
	Privacy    int          `json:"privacy"` // 0-100; -1 not measured (offline)
	PrivacyWhy []string     `json:"privacy_why,omitempty"`
	RTTMs      int          `json:"rtt_ms"` // -1 not measured
	Speed      string       `json:"speed"`
	RSSI       int          `json:"rssi,omitempty"`
	Noise      int          `json:"noise,omitempty"`
	Signal     string       `json:"signal"` // a grade, "n/a" off Wi-Fi, or notMeasured
	Radio      *Radio       `json:"radio,omitempty"`
	Link       *LinkQuality `json:"link,omitempty"`
	Advice     []string     `json:"advice,omitempty"` // RadioAdvice: what to change, most useful first
}

func ScoreNet(s Snapshot) NetScore {
	n := NetScore{Privacy: -1, RTTMs: -1, Speed: notMeasured, Signal: notMeasured}
	if !s.Online {
		return n
	}
	n.Privacy = 100
	lose := func(points int, why string) {
		n.Privacy -= points
		n.PrivacyWhy = append(n.PrivacyWhy, fmt.Sprintf("%s -%d", why, points))
	}
	if s.API.Err == ErrTLSUntrusted {
		lose(50, "network intercepts TLS")
	}
	tunnel := s.Tailscale.ExitNode != ""
	sec := strings.ToUpper(strings.TrimSpace(s.WiFiSec))
	switch {
	case sec == "NONE" || sec == "OPEN":
		if tunnel {
			lose(10, "open Wi-Fi (tunnelled via exit node)")
		} else {
			lose(40, "open Wi-Fi")
		}
	case weakWiFi(sec):
		if tunnel {
			lose(10, "weak Wi-Fi encryption (tunnelled via exit node)")
		} else {
			lose(30, "weak Wi-Fi encryption")
		}
	}
	for i, svc := range s.Exposed {
		if i == 3 {
			break // at most -30 for sharing services
		}
		lose(10, svc+" reachable on this network")
	}
	if s.WPAD || s.PAC {
		lose(15, "auto-proxy (WPAD/PAC) on")
	}
	if s.Captive.Err == ErrPortal {
		lose(10, "captive portal")
	}
	if n.Privacy < 0 {
		n.Privacy = 0
	}

	if s.API.OK && s.API.ConnectMs > 0 {
		n.RTTMs, n.Speed = s.API.ConnectMs, speedGrade(s.API.ConnectMs)
	}
	switch {
	case s.WiFiSec == "":
		n.Signal = "n/a"
	case s.Signal != nil:
		n.RSSI, n.Noise, n.Signal = s.Signal.RSSI, s.Signal.Noise, signalGrade(s.Signal.RSSI-s.Signal.Noise)
		n.Radio = s.Signal.Radio
	}
	n.Link, n.Advice = s.Link, RadioAdvice(s)
	return n
}

// speedGrade bands one round trip. Interactive work (Claude Code, video calls)
// starts to feel slow past ~150 ms; past 300 ms every request visibly lags.
func speedGrade(ms int) string {
	switch {
	case ms <= 60:
		return "excellent"
	case ms <= 150:
		return "good"
	case ms <= 300:
		return "fair"
	}
	return "poor"
}

// signalGrade bands Wi-Fi SNR in dB, as commonly used in Wi-Fi site surveys:
// 40+ excellent, 25-40 good (fine for calls), 15-25 fair (drops likely), below 15 poor.
func signalGrade(snr int) string {
	switch {
	case snr >= 40:
		return "excellent"
	case snr >= 25:
		return "good"
	case snr >= 15:
		return "fair"
	}
	return "poor"
}

// Line is the one-line summary added to phone texts.
func (n NetScore) Line() string {
	privacy := "Privacy " + notMeasured
	if n.Privacy >= 0 {
		privacy = fmt.Sprintf("Privacy %d/100", n.Privacy)
		if len(n.PrivacyWhy) > 0 {
			privacy += " (" + strings.Join(n.PrivacyWhy, ", ") + ")"
		}
	}
	speed := "Speed " + n.Speed
	if n.RTTMs >= 0 {
		speed += fmt.Sprintf(" (%d ms)", n.RTTMs)
	}
	signal := "Signal " + n.Signal
	if n.Signal != "n/a" && n.Signal != notMeasured {
		signal += fmt.Sprintf(" (SNR %d dB)", n.RSSI-n.Noise)
	}
	line := privacy + " · " + speed + " · " + signal
	if r := radioLine(n.Radio, n.Link); r != "" {
		line += " · " + r
	}
	return line
}

var reSignal = regexp.MustCompile(`Signal / Noise:\s*(-?\d+) dBm / (-?\d+) dBm`)

// parseSignal reads the current network's "Signal / Noise" from
// `system_profiler SPAirPortDataType`. Only the Current Network block is read:
// nearby networks (and every network name) are ignored.
func parseSignal(out string) *WiFiSignal {
	i := strings.Index(out, "Current Network Information:")
	if i < 0 {
		return nil
	}
	block := out[i:]
	if j := strings.Index(block, "Other Local Wi-Fi Networks:"); j >= 0 {
		block = block[:j]
	}
	m := reSignal.FindStringSubmatch(block)
	if m == nil {
		return nil
	}
	rssi, _ := strconv.Atoi(m[1])
	noise, _ := strconv.Atoi(m[2])
	if rssi < -120 || rssi > 0 || noise < -120 || noise > 0 {
		return nil
	}
	return &WiFiSignal{RSSI: rssi, Noise: noise, Radio: parseRadio(out)}
}

const signalEvery = 5 * time.Minute // system_profiler takes ~5 s; signal is re-read on a new network at once

type signalCache struct {
	At      time.Time  `json:"at"`
	Gateway string     `json:"gateway"` // gateway MAC: a new network invalidates the reading
	Signal  WiFiSignal `json:"signal"`
}

// cachedSignal returns a reading at most signalEvery old for this gateway,
// calling read only when it has to. An empty path disables the cache.
func cachedSignal(path, gateway string, now time.Time, read func() *WiFiSignal) *WiFiSignal {
	var c signalCache
	if path != "" {
		if b, err := os.ReadFile(path); err == nil && json.Unmarshal(b, &c) == nil &&
			c.Gateway == gateway && now.Sub(c.At) >= 0 && now.Sub(c.At) < signalEvery {
			sig := c.Signal
			return &sig
		}
	}
	sig := read()
	if sig != nil && path != "" {
		if b, err := json.Marshal(signalCache{At: now, Gateway: gateway, Signal: *sig}); err == nil {
			_ = os.WriteFile(path, b, 0o600)
		}
	}
	return sig
}

// netReport is the "net" block of a Gauss report (backend/mesh/store.ts parseNet).
func netReport(n NetScore) map[string]any {
	r := map[string]any{"privacy": n.Privacy, "privacyWhy": n.PrivacyWhy, "rttMs": n.RTTMs, "speed": n.Speed, "signal": n.Signal}
	if n.Signal != "n/a" && n.Signal != notMeasured {
		r["rssi"], r["noise"] = n.RSSI, n.Noise
	}
	if radio := radioReport(n.Radio, n.Link); radio != nil {
		r["radio"] = radio
	}
	return r
}
