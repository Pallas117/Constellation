package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// Argo heals this Mac, but the team's phones leave the tailnet silently: iOS
// drops the VPN after a SIM switch, a hotspot drop or a restart unless
// Connect On Demand is on. On 2026-10-18 the iPhone had been offline for 6
// days before anyone noticed. watchDevices texts the owner when one of their
// phones (or a device named in config "devices") has been off the tailnet for
// deviceOfflineAfter. The text goes by SMS/iMessage over the phone's own
// cellular link, so it arrives even though the phone is off the tailnet.

const (
	deviceOfflineAfter = 30 * time.Minute
	deviceRemindEvery  = 6 * time.Hour
)

type tailnetDevice struct {
	HostName string    `json:"HostName"`
	DNSName  string    `json:"DNSName"` // "iphone-13.tailnet.ts.net."; iOS reports HostName "localhost"
	OS       string    `json:"OS"`
	Online   bool      `json:"Online"`
	LastSeen time.Time `json:"LastSeen"`
	UserID   int64     `json:"UserID"`
}

type tailnetStatus struct {
	Self tailnetDevice            `json:"Self"`
	Peer map[string]tailnetDevice `json:"Peer"`
}

type deviceAlert struct {
	Host    string
	Offline time.Duration // 0: never seen
}

// offlineDevices returns the watched devices that have been offline for at
// least deviceOfflineAfter, sorted by name. Watched = the hostnames in names,
// or (names empty) the phones owned by this Mac's tailnet user. Nothing is
// judged while this Mac is itself off the tailnet.
func offlineDevices(raw []byte, names []string, now time.Time) []deviceAlert {
	var st tailnetStatus
	if json.Unmarshal(raw, &st) != nil || !st.Self.Online {
		return nil
	}
	want := map[string]bool{}
	for _, n := range names {
		want[strings.ToLower(n)] = true
	}
	var out []deviceAlert
	for _, p := range st.Peer {
		name := deviceName(p)
		host := strings.ToLower(name)
		phone := p.UserID == st.Self.UserID && (strings.EqualFold(p.OS, "iOS") || strings.EqualFold(p.OS, "android"))
		if (len(want) > 0 && !want[host]) || (len(want) == 0 && !phone) || p.Online {
			continue
		}
		var off time.Duration
		if !p.LastSeen.IsZero() {
			off = now.Sub(p.LastSeen)
			if off < deviceOfflineAfter {
				continue
			}
		}
		out = append(out, deviceAlert{Host: name, Offline: off})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Host < out[j].Host })
	return out
}

// deviceName is the tailnet name (first label of DNSName), which is what the
// admin console and `tailscale status` show; HostName is "localhost" on iOS.
func deviceName(p tailnetDevice) string {
	if n, _, _ := strings.Cut(p.DNSName, "."); n != "" {
		return n
	}
	return p.HostName
}

func roughly(d time.Duration) string {
	switch {
	case d <= 0:
		return "a long time"
	case d < 2*time.Hour:
		return fmt.Sprintf("%d min", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d h", int(d.Hours()))
	default:
		return fmt.Sprintf("%d days", int(d.Hours()/24))
	}
}

func deviceMessage(a deviceAlert) string {
	return fmt.Sprintf("%s has been off the tailnet for %s. Open Tailscale and connect, then turn on Connect On Demand "+
		"(iPhone: Settings > VPN > Tailscale; Android: Always-on VPN) so it reconnects by itself.", a.Host, roughly(a.Offline))
}

// watchDevices checks once and texts at most every deviceRemindEvery per device.
// It returns one line per offline device for `argo devices`.
func watchDevices(ctx context.Context, names []string, s Store, phone *Phone, now time.Time) []string {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(ctx, tailscaleCLI(), "status", "--json").Output()
	if err != nil {
		return nil
	}
	var out []string
	for _, a := range offlineDevices(raw, names, now) {
		msg := deviceMessage(a)
		out = append(out, msg)
		if phone != nil && shouldNotify(s, "device-offline-"+strings.ToLower(a.Host), deviceRemindEvery, now) {
			phone.Send("Argo: "+a.Host+" offline", msg, now)
		}
	}
	return out
}
