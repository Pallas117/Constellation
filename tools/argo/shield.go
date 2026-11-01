package main

import (
	"context"
	"os"
	"regexp"
	"strings"
	"time"
)

// Wi-Fi shield (2026-11-01, Josh: "maintain network security and stability on insecure WiFi").
// On open or weakly encrypted Wi-Fi, Argo turns on the Cloudflare WARP tunnel when WARP is set to
// its full-tunnel mode, checks that the connection and Tailscale still work, and turns WARP off
// again once the Mac is back on a properly encrypted network, but only if Argo turned it on.
// If WARP breaks the connection, or you switch it off yourself, Argo leaves it off on that
// network. The only commands it runs are `warp-cli connect` and `warp-cli disconnect`.

// Warp is Cloudflare WARP's state, read from warp-cli.
type Warp struct {
	Installed bool   `json:"installed,omitempty"`
	Connected bool   `json:"connected,omitempty"`
	Mode      string `json:"mode,omitempty"` // warp-cli's Mode, e.g. Warp, WarpWithDnsOverHttps, WarpProxy, DnsOverHttps
}

// Tunnel is true when WARP's mode encrypts all traffic, not just a local proxy or DNS.
func (w Warp) Tunnel() bool {
	m := strings.ToLower(w.Mode)
	return w.Installed && strings.HasPrefix(m, "warp") && !strings.Contains(m, "proxy")
}

// warpCLIPaths: launchd's PATH has no /usr/local/bin, so look in the places the installer uses.
var warpCLIPaths = []string{"/usr/local/bin/warp-cli", "/opt/homebrew/bin/warp-cli", "/Applications/Cloudflare WARP.app/Contents/Resources/warp-cli"}

func warpCLI() string {
	for _, p := range warpCLIPaths {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			return p
		}
	}
	return ""
}

var reWarpMode = regexp.MustCompile(`(?m)Mode:\s*(\S+)`)

// parseWarp reads `warp-cli status` and `warp-cli settings`.
func parseWarp(status, settings string) Warp {
	w := Warp{Installed: true, Connected: strings.Contains(status, "Status update: Connected")}
	if m := reWarpMode.FindStringSubmatch(settings); m != nil {
		w.Mode = m[1]
	}
	return w
}

func probeWarp(ctx context.Context) Warp {
	cli := warpCLI()
	if cli == "" {
		return Warp{}
	}
	return parseWarp(run(ctx, cli, "--accept-tos", "status"), run(ctx, cli, "--accept-tos", "settings"))
}

const shieldSettle = 5 * time.Second

// shield runs every tick, before the class decides anything else.
func (l Loop) shield(ctx context.Context, st *State, snap Snapshot, fp string) {
	w, n := snap.Warp, st.Networks[fp]
	untrusted := weakWiFi(snap.WiFiSec)
	switch {
	case st.ShieldOn && !untrusted: // back on a protected network: undo only what Argo did
		if w.Connected {
			if err := l.Fx.Run("warp-cli", "--accept-tos", "disconnect"); err == nil {
				l.say("shield: protected network again; WARP tunnel off")
			}
		}
		st.ShieldOn = false
	case st.ShieldOn && !w.Connected: // switched off by hand on this network: respect it
		st.ShieldOn, n.NoShield = false, true
		l.say("shield: WARP was switched off here; leaving it off on this network")
	case untrusted && !st.ShieldOn && !n.NoShield && w.Tunnel() && !w.Connected:
		if err := l.Fx.Run("warp-cli", "--accept-tos", "connect"); err != nil {
			l.say("shield: could not start WARP: %v", err)
			break
		}
		l.Fx.Sleep(shieldSettle)
		after := l.Prober.Probe(ctx)
		if c, _ := Classify(after); c.Blocking() || (snap.Tailscale.Running && !after.Tailscale.Running) {
			_ = l.Fx.Run("warp-cli", "--accept-tos", "disconnect")
			n.NoShield = true
			l.Fx.Notify("Argo: WARP tunnel undone", "Turning on WARP on this open Wi-Fi broke the connection or Tailscale, so Argo switched it off again and won't retry on this network. Use the iPhone hotspot for anything sensitive.")
		} else {
			st.ShieldOn = true
			l.Fx.Notify("Argo: open Wi-Fi, tunnel on", "This Wi-Fi is "+snap.WiFiSec+", so anyone nearby could read unencrypted traffic. WARP now encrypts all of it. Argo turns WARP off again when you're back on a protected network.")
		}
	case untrusted && w.Installed && !w.Tunnel() && !n.ShieldAdvised:
		n.ShieldAdvised = true
		l.Fx.Notify("Argo: open Wi-Fi, no tunnel", "This Wi-Fi is "+snap.WiFiSec+". WARP is in "+w.Mode+" mode, which only covers apps set to use its proxy. In WARP's settings choose the WARP mode once; Argo will then turn it on by itself on open Wi-Fi.")
	}
	if fp != "" {
		st.Networks[fp] = n
	}
}
