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
	switch w.Mode {
	case "Warp", "WarpWithDnsOverHttps", "WarpWithDnsOverTls", "TunnelOnly":
		return w.Installed
	}
	return false
}

// warpModeArg maps the Mode warp-cli settings shows to the argument `warp-cli mode` takes, so a
// mode Argo changed can be put back exactly. A mode not listed here is never changed.
var warpModeArg = map[string]string{
	"Warp": "warp", "WarpWithDnsOverHttps": "warp+doh", "WarpWithDnsOverTls": "warp+dot", "TunnelOnly": "tunnel_only",
	"WarpProxy": "proxy", "DnsOverHttps": "doh", "DnsOverTls": "dot",
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

// shield runs every tick, before the class decides anything else. Josh (1 Nov): switch
// automatically, so it changes WARP's mode itself and puts the old mode back afterwards.
// Since 5 Nov that automation is opt-in (Loop.ShieldWARP; see below).
func (l Loop) shield(ctx context.Context, st *State, snap Snapshot, fp string) {
	w, n := snap.Warp, st.Networks[fp]
	untrusted := weakWiFi(snap.WiFiSec) || n.suspect(l.Fx.Now()) // spoofing signs count as untrusted
	warp := func(args ...string) error { return l.Fx.Run("warp-cli", append([]string{"--accept-tos"}, args...)...) }
	restore := func() { // undo exactly what Argo did: the connection, then the mode
		if !st.ShieldWasConnected {
			_ = warp("disconnect")
		}
		if st.ShieldPrevMode != "" {
			_ = warp("mode", st.ShieldPrevMode)
		}
		st.ShieldOn, st.ShieldPrevMode, st.ShieldWasConnected = false, "", false
	}
	// Off by default since 2026-11-05 (security review finding 6): `warp-cli --accept-tos connect`
	// accepts Cloudflare's terms for the user and reroutes the Mac's egress by itself, and
	// Tailscale already encrypts the team's traffic. With "wifi_shield": "warp" in config.json
	// the automation below runs as before; otherwise Argo says once per network when WARP would
	// help and leaves the choice to the person.
	if !l.ShieldWARP {
		if st.ShieldOn { // turned on by an earlier Argo: put it back as it was
			restore()
			l.say("shield: automatic WARP is off; WARP put back as it was")
		}
		if untrusted && w.Installed && !w.Connected && !n.ShieldAdvised && !n.NoShield {
			n.ShieldAdvised = true
			l.Fx.Notify("Argo: open Wi-Fi", "This Wi-Fi is "+snap.WiFiSec+". Traffic to the team is already encrypted by Tailscale. "+
				"Cloudflare WARP would also hide the rest from this network. Argo no longer turns it on by itself: run `warp-cli connect`, "+
				"or set \"wifi_shield\": \"warp\" in ~/.config/argo/config.json to let Argo do it on networks like this one.")
		}
		if fp != "" {
			st.Networks[fp] = n
		}
		return
	}
	switch {
	case st.ShieldOn && !untrusted: // back on a protected network
		restore()
		l.say("shield: protected network again; WARP back as it was")
	case st.ShieldOn && !w.Connected: // switched off by hand on this network: respect it
		restore()
		n.NoShield = true
		l.say("shield: WARP was switched off here; leaving it off on this network")
	case untrusted && !st.ShieldOn && !n.NoShield && w.Installed && !(w.Connected && w.Tunnel()):
		prev := ""
		if !w.Tunnel() {
			if prev = warpModeArg[w.Mode]; prev == "" {
				if !n.ShieldAdvised {
					n.ShieldAdvised = true
					l.Fx.Notify("Argo: open Wi-Fi, no tunnel", "This Wi-Fi is "+snap.WiFiSec+" and WARP is in a mode Argo doesn't know ("+w.Mode+"), so it left WARP alone. Use the iPhone hotspot for anything sensitive.")
				}
				break
			}
			if err := warp("mode", "warp"); err != nil {
				l.say("shield: could not switch WARP to tunnel mode: %v", err)
				break
			}
		}
		st.ShieldOn, st.ShieldPrevMode, st.ShieldWasConnected = true, prev, w.Connected
		if !w.Connected {
			if err := warp("connect"); err != nil {
				l.say("shield: could not start WARP: %v", err)
				restore()
				break
			}
		}
		l.Fx.Sleep(shieldSettle)
		after := l.Prober.Probe(ctx)
		if c, _ := Classify(after); c.Blocking() || (snap.Tailscale.Running && !after.Tailscale.Running) {
			restore()
			n.NoShield = true
			l.Fx.Notify("Argo: WARP tunnel undone", "Turning on WARP on this open Wi-Fi broke the connection or Tailscale, so Argo put WARP back as it was and won't retry on this network. Use the iPhone hotspot for anything sensitive.")
		} else {
			l.Fx.Notify("Argo: open Wi-Fi, tunnel on", "This Wi-Fi is "+snap.WiFiSec+", so anyone nearby could read unencrypted traffic. WARP now encrypts all of it. Argo puts WARP back as it was when you're on a protected network again.")
		}
	}
	if fp != "" {
		st.Networks[fp] = n
	}
}
