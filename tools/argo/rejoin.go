package main

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Rejoin (2026-11-02, Josh: "we need to remain always connected without my intervention"). The
// hotspot link dropped at 11:45 and the Mac stayed with no route for 94 minutes while Argo's only
// OFFLINE step was "wait". With no route at all a reset can't make things worse, so Argo now:
//   - turns Wi-Fi on when it is off;
//   - after offlineRejoinAfter, power-cycles Wi-Fi so macOS auto-join picks a known network or the
//     hotspot again (macOS hides the network name from Argo without Location Services, and 358 saved
//     networks make rejoining by name a guess, so auto-join chooses).
// Attempts follow the loop's backoff and circuit breaker (4 tries, then every 30 minutes), each one
// verified by a re-probe, and what worked is remembered per network like every other fix.

const (
	offlineRejoinAfter = 90 * time.Second // a network switch looks offline for a few seconds; don't reset during one
	wifiCycleGap       = 3 * time.Second
	wifiRejoinSettle   = 20 * time.Second
	offlineTellAfter   = 5 * time.Minute // GAU-233: long enough not to text for a network switch
)

var (
	reWiFiPort  = regexp.MustCompile(`Hardware Port: (?:Wi-Fi|AirPort)\s*\nDevice: (\S+)`)
	reWiFiPower = regexp.MustCompile(`Wi-Fi Power \(\S+\): (On|Off)`)
)

// parseWiFiDevice reads `networksetup -listallhardwareports`.
func parseWiFiDevice(out string) string {
	if m := reWiFiPort.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	return ""
}

// parseWiFiPower reads `networksetup -getairportpower <dev>`: "On", "Off" or "".
func parseWiFiPower(out string) string {
	if m := reWiFiPower.FindStringSubmatch(out); m != nil {
		return m[1]
	}
	return ""
}

// probeOfflineWiFi records the Wi-Fi radio's state when there is no route, so an outage leaves
// evidence of whether the radio was off, on but not joined, or joined to a dead network.
func probeOfflineWiFi(ctx context.Context, s *Snapshot) {
	s.WiFiDevice = parseWiFiDevice(run(ctx, "networksetup", "-listallhardwareports"))
	if s.WiFiDevice != "" {
		s.WiFiPower = parseWiFiPower(run(ctx, "networksetup", "-getairportpower", s.WiFiDevice))
	}
	if s.WiFiPower == "On" {
		s.JoinCandidates = joinCandidates(ctx, s.WiFiDevice)
	}
	s.InCall = liveCall(ctx) != ""
}

// offlinePlan is the OFFLINE ladder.
func offlinePlan(s Snapshot) []Action {
	switch {
	case s.WiFiDevice != "" && s.WiFiPower == "Off":
		return []Action{{ID: "wifi-on", Say: "No network and Wi-Fi is off: turning Wi-Fi on.", Command: "networksetup -setairportpower " + s.WiFiDevice + " on", Auto: true}}
	case s.WiFiDevice != "" && len(s.JoinCandidates) > 0: // GAU-234: join the best saved network in range, or restart Wi-Fi
		c := s.JoinCandidates[0]
		return []Action{
			{ID: "wifi-join", Say: fmt.Sprintf("No network: joining the strongest saved network in range (%d dBm).", c.RSSI), Command: "networksetup -setairportnetwork " + s.WiFiDevice, Arg: c.SSID, Auto: true},
			{ID: "wifi-rejoin", Say: "No network: restarting Wi-Fi so macOS rejoins a known network or the hotspot.", Command: "networksetup -setairportpower " + s.WiFiDevice + " off+on", Auto: true},
		}
	case s.WiFiDevice != "":
		return []Action{{ID: "wifi-rejoin", Say: "No network: restarting Wi-Fi so macOS rejoins a known network or the hotspot.", Command: "networksetup -setairportpower " + s.WiFiDevice + " off+on", Auto: true}}
	}
	return []Action{{ID: "wait", Say: "No network. Join Wi-Fi or enable the hotspot; mesh-heal will reconnect Tailscale."}}
}

// runAuto runs one automatic step: open a page, or one of the Wi-Fi commands above.
func (l Loop) runAuto(a Action) error {
	if strings.HasPrefix(a.Command, "open ") {
		return l.Fx.Open(strings.TrimPrefix(a.Command, "open "))
	}
	f := strings.Fields(a.Command)
	if a.ID == "wifi-join" && len(f) == 3 && f[0] == "networksetup" && f[1] == "-setairportnetwork" && a.Arg != "" && !strings.ContainsRune(a.Arg, 0) {
		return l.Fx.Run("networksetup", "-setairportnetwork", f[2], a.Arg)
	}
	if len(f) != 4 || f[0] != "networksetup" || f[1] != "-setairportpower" {
		return nil // nothing else runs by itself
	}
	if f[3] == "off+on" {
		if err := l.Fx.Run("networksetup", "-setairportpower", f[2], "off"); err != nil {
			return err
		}
		l.Fx.Sleep(wifiCycleGap)
		return l.Fx.Run("networksetup", "-setairportpower", f[2], "on")
	}
	return l.Fx.Run("networksetup", "-setairportpower", f[2], f[3])
}

func hasAction(plan []Action, id string) bool {
	for _, a := range plan {
		if a.ID == id {
			return true
		}
	}
	return false
}
