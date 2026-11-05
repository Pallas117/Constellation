package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Action is one rung of the remediation ladder. Only Auto actions run by
// themselves; everything else is shown to the user as a command to run.
// Admin actions are never automatic.
type Action struct {
	ID      string `json:"id"`
	Say     string `json:"say"`
	Command string `json:"command,omitempty"`
	Auto    bool   `json:"auto,omitempty"`
	Admin   bool   `json:"admin,omitempty"`
	Arg     string `json:"-"` // a network name for wifi-join (GAU-234): its own argv item, never stored
}

// Plan returns the ladder for a class, least invasive first. Tailscale is
// left to mesh-heal: Argo only recommends exit nodes, never switches them,
// because mesh-heal's bare `tailscale up` fails once non-default prefs exist.
func Plan(c Class, s Snapshot, remembered string) []Action {
	var a []Action
	switch c {
	case Offline:
		a = append(a, offlinePlan(s)...)
	case Captive:
		a = append(a, Action{ID: "open-portal", Say: "Wi-Fi login page detected; opening it.", Command: "open http://captive.apple.com", Auto: true})
	case DNS:
		if s.DNSDirectOK && s.Tailscale.Running { // the network answers; Tailscale's resolver doesn't
			a = append(a, Action{ID: "check-magicdns", Say: "Tailscale's DNS is stuck while the network's DNS works. Toggle Tailscale off and on, or for now:", Command: "tailscale set --accept-dns=false"})
		}
		a = append(a, Action{ID: "flush-dns", Say: "DNS is failing. Flush the resolver cache:", Command: "sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder", Admin: true})
		if s.Tailscale.Running && !s.DNSDirectOK {
			a = append(a, Action{ID: "check-magicdns", Say: "If it persists, MagicDNS may be stuck:", Command: "tailscale set --accept-dns=false"})
		}
	case DeadProxy:
		for _, p := range s.Proxies {
			if p.Alive {
				continue
			}
			if strings.HasPrefix(p.Source, "env:") {
				a = append(a, Action{ID: "strip-env-proxy", Say: "A dead proxy is set in this shell. Launch Claude without it:", Command: "argo run -- claude"})
			} else {
				a = append(a, Action{ID: "system-proxy-off", Say: "The macOS system proxy is dead. Turn it off:", Command: `sudo networksetup -setsecurewebproxystate "Wi-Fi" off; sudo networksetup -setwebproxystate "Wi-Fi" off`, Admin: true})
			}
		}
	case StaleDaemon:
		a = append(a, Action{ID: "restart-daemon", Say: "A background Claude daemon is stuck on a dead proxy. Restart it (ends background sessions):", Command: "claude daemon stop --any"})
	case TLSIntercept:
		a = append(a, Action{ID: "leave-network", Say: "This network is intercepting TLS. Do not trust it: switch network or use a MY/SG exit node. Never disable certificate checks."})
	case PortBlock, Region:
		if len(s.Tailscale.ExitCandidates) > 0 {
			n := s.Tailscale.ExitCandidates[0]
			a = append(a, Action{ID: "exit-node", Say: "Route via the allow-listed exit node " + n + ":", Command: "tailscale set --exit-node=" + n + " --exit-node-allow-lan-access"})
		}
		a = append(a, Action{ID: "switch-network", Say: switchAdvice(c, s)})
	case WiFiRisk:
		if weakWiFi(s.WiFiSec) {
			a = append(a, Action{ID: "avoid-weak-wifi", Say: "This Wi-Fi is not properly encrypted. Use your iPhone hotspot instead, or keep Tailscale on so traffic to the team stays encrypted."})
		}
		if len(s.Exposed) > 0 {
			a = append(a, Action{ID: "sharing-off", Say: sharingAdvice + " (" + strings.Join(s.Exposed, ", ") + "). Argo never changes these itself."})
		}
	case WPADRisk:
		a = append(a, Action{ID: "wpad-off", Say: "Automatic proxy discovery is on. Turn it off:", Command: `sudo networksetup -setproxyautodiscovery "Wi-Fi" off; sudo networksetup -setautoproxystate "Wi-Fi" off`, Admin: true})
	}
	// A fix that worked on this exact network before goes first.
	for i, x := range a {
		if x.ID == remembered && i > 0 {
			a = append([]Action{x}, append(a[:i:i], a[i+1:]...)...)
			break
		}
	}
	return a
}

// switchAdvice fits the advice to what failed. A Hong Kong eSIM shows up as
// REGION (403 or an HK exit); a PORT_BLOCK in Malaysia is the network itself.
func switchAdvice(c Class, s Snapshot) string {
	switch {
	case c == Region:
		return "Switch to a Malaysian SIM or local Wi-Fi (Hong Kong eSIMs exit in HK, which Anthropic does not serve)."
	case isIPhoneHotspot(s.Gateway):
		return "The iPhone's mobile data is stalling. On the phone, turn Airplane mode on for 5 seconds and off again, " +
			"or connect it by USB cable, which holds better than the Wi-Fi hotspot."
	case uplinkStalled(s):
		return "This Wi-Fi is connected but nothing gets through (Apple's check fails too), so it is the network, not a block on Claude. " +
			"Shared Wi-Fi often does this when busy: switch to the iPhone hotspot."
	}
	return "This network lets other sites through but drops connections to Claude. Switch to the iPhone hotspot."
}

const settleDelay = 10 * time.Second

// Effects are the side effects the loop may cause; tests replace them.
type Effects interface {
	Notify(title, msg string)
	Open(url string) error
	Run(name string, args ...string) error // only the Wi-Fi shield's warp-cli connect/disconnect
	// NotifyOffline texts while this Mac has no network, through the iPhone's SMS relay (GAU-233);
	// true when Messages accepted it.
	NotifyOffline(title, msg string) bool
	Sleep(d time.Duration)
	Now() time.Time
}

type realEffects struct{ phone *Phone }

func (f realEffects) Notify(title, msg string) {
	desktopNotify(title, msg)
	if f.phone != nil {
		f.phone.Send(title, msg, time.Now())
	}
}
func (realEffects) Open(u string) error { return openURL(u) }
func (realEffects) Run(name string, args ...string) error {
	if name == "warp-cli" {
		if name = warpCLI(); name == "" {
			return errors.New("warp-cli not found")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).Run()
}
func (f realEffects) NotifyOffline(title, msg string) bool {
	desktopNotify(title, msg)
	return f.phone != nil && f.phone.SendRelay(title, msg, time.Now())
}
func (realEffects) Sleep(d time.Duration) { time.Sleep(d) }
func (realEffects) Now() time.Time        { return time.Now() }

// Loop runs probe → classify → remediate → verify → remember once.
type Loop struct {
	Prober  Prober
	Store   Store
	Fx      Effects
	Out     func(string) // foreground output; nil in the LaunchAgent
	Pushers []func(State)
	// AppWatch turns on the app data watch (leak.go); only the real agent sets it, so tests
	// never run lsof or nettop.
	AppWatch bool
}

func (l Loop) say(format string, args ...any) {
	if l.Out != nil {
		l.Out(fmt.Sprintf(format, args...))
	}
}

func (l Loop) Tick(ctx context.Context) State {
	if l.AppWatch {
		l.leakWatch(ctx)
	}
	st := l.Store.Load()
	snap := l.Prober.Probe(ctx)
	class, reason := Classify(snap)
	// A network switch leaves a few seconds with no route or DNS. Confirm a
	// new failure once before alerting, so every switch isn't an incident.
	if class.Blocking() && class != st.Class {
		l.Fx.Sleep(settleDelay)
		snap = l.Prober.Probe(ctx)
		class, reason = Classify(snap)
	}
	now := l.Fx.Now()
	fp := netFingerprint(snap)
	// With the link down (or the internet unreachable) there is no public IP and
	// often no gateway: that is still the network we were on, so the incident
	// and what Argo learns from it belong to it, not to an empty fingerprint.
	if snap.PublicIP == "" && st.Fingerprint != "" && (snap.GatewayMAC == "" || snap.GatewayMAC == st.GatewayMAC) {
		fp = st.Fingerprint
	}
	if fp != "" {
		if _, ok := st.Networks[fp]; !ok {
			st.Networks[fp] = Net{FirstSeen: now, Fixes: map[Class]string{}}
		}
	}
	prev, prevPublicIP := st.Class, st.PublicIP
	st.Fingerprint, st.Loc, st.CheckedAt, st.Tailscale = fp, snap.Loc, now, snap.Tailscale
	if fp != "" {
		l.watchNeighbours(&st, snap, fp, prevPublicIP) // before Gateway/GatewayMAC move on
	}
	st.Gateway, st.GatewayMAC, st.PublicIP = snap.Gateway, snap.GatewayMAC, snap.PublicIP
	st.Net = ScoreNet(snap)
	if fp != "" {
		l.shield(ctx, &st, snap, fp)
	}
	l.say("%s  %s", class, reason)

	if !class.Blocking() {
		if prev.Blocking() {
			l.resolve(&st, prev, now, "", fp)
		}
		if class != prev && !prev.Blocking() && prev != "" { // recoveries are notified by resolve
			l.Fx.Notify("Argo: "+string(class), reason+"\n"+st.Net.Line())
		}
		st.Class, st.Reason = class, reason
		l.finish(st)
		return st
	}

	if class != prev {
		flip := prev.Blocking() // one failure turned into another: the log closes the old class
		if flip {
			_ = l.Store.Append(Incident{Time: now, Event: "superseded", Class: prev, Fingerprint: fp})
		}
		_ = l.Store.Append(Incident{Time: now, Event: "open", Class: class, Fingerprint: fp, Detail: reason})
		// A slow hotspot flips between DNS and PORT_BLOCK (2026-10-27 19:53-19:59). That is
		// one outage: keep its start, attempts and backoff, and don't text again for it.
		if !flip {
			st.IncidentAt, st.Attempts, st.LastFix, st.IncidentFP = now, 0, "", fp
			st.OfflineTold, st.WiFiSteps = false, 0
			st.Notified, st.NotifyDue = false, time.Time{}
		}
		switch quiet := st.Networks[fp].quietFor(class); {
		case flip && (st.Notified || !st.NotifyDue.IsZero()): // already told, or already scheduled
		case class == Offline: // a Mac with no network can't send it; it would arrive stale
		case quiet > 0: // this network usually clears it by itself: say so only if it lasts longer
			st.NotifyDue = now.Add(quiet)
		default: // rate limit: only on class change
			l.Fx.Notify("Argo: "+string(class), reason+"\n"+st.Net.Line()+fixHint(Plan(class, snap, st.Networks[fp].Fixes[class])))
			st.Notified = true
		}
	}
	st.Class, st.Reason = class, reason
	if !st.Notified && !st.NotifyDue.IsZero() && !now.Before(st.NotifyDue) {
		p50, _, _ := st.Networks[st.IncidentFP].usualRecovery(class)
		l.Fx.Notify("Argo: "+string(class), fmt.Sprintf("%s for %s, longer than usual on this network (it usually clears in %s).\n%s",
			reason, now.Sub(st.IncidentAt).Round(time.Minute), p50.Round(time.Second), st.Net.Line()))
		st.Notified = true
	}

	// GAU-233: an outage lasting offlineTellAfter is texted once through the iPhone's SMS relay
	// (Continuity), which needs no internet on the Mac, only the phone's own cellular.
	if class == Offline && !st.OfflineTold && now.Sub(st.IncidentAt) >= offlineTellAfter {
		st.OfflineTold = true
		ok := l.Fx.NotifyOffline("Argo: Mac offline", fmt.Sprintf("No network since %s (%s). Argo is retrying Wi-Fi by itself; you'll get a text when it's back. If the hotspot is off, turn it on.",
			st.IncidentAt.Local().Format("15:04"), now.Sub(st.IncidentAt).Round(time.Minute)))
		detail := "queued (relay not accepted)"
		if ok {
			detail = "sent through the iPhone relay"
		}
		_ = l.Store.Append(Incident{Time: now, Event: "relay", Class: class, Fingerprint: fp, Detail: detail})
		l.say("offline alert: %s", detail)
	}

	if now.Before(st.BreakerUntil) {
		l.say("circuit breaker open until %s; not remediating", st.BreakerUntil.Format(time.Kitchen))
		l.finish(st)
		return st
	}
	if wait := backoff(st.Attempts); !st.LastFixAt.IsZero() && now.Sub(st.LastFixAt) < wait {
		l.say("backing off; next attempt in %s", (wait - now.Sub(st.LastFixAt)).Round(time.Second))
		l.finish(st)
		return st
	}

	plan := Plan(class, snap, st.Networks[fp].Fixes[class])
	// A blip this network always has: say that first, instead of advice that won't help.
	if p50, p90, k := st.Networks[fp].usualRecovery(class); k >= minRecoverSamples && now.Sub(st.IncidentAt) < p90 {
		plan = append([]Action{{ID: "usual-blip", Say: fmt.Sprintf("This network usually recovers from %s by itself (median %s, 9 in 10 within %s, over the last %d times). Nothing to do yet.",
			class, p50.Round(time.Second), p90.Round(time.Second), k)}}, plan...)
	}
	var ran []string
	wifiTurn := st.WiFiSteps // fixed for this tick: one Wi-Fi step per attempt
	for _, a := range plan {
		line := a.Say
		if a.Command != "" {
			line += "\n    " + a.Command
		}
		l.say("→ %s", line)
		if a.Auto && class == Offline && now.Sub(st.IncidentAt) < offlineRejoinAfter {
			continue // a network switch: give it time before resetting Wi-Fi
		}
		// GAU-234: with a saved network in range, attempts alternate between joining it and a Wi-Fi
		// restart, so one step per attempt (a restart right after a join would undo it).
		if hasAction(plan, "wifi-join") && ((a.ID == "wifi-join" && wifiTurn%2 == 1) || (a.ID == "wifi-rejoin" && wifiTurn%2 == 0)) {
			continue
		}
		if a.Auto {
			if strings.HasPrefix(a.ID, "wifi-") {
				st.WiFiSteps++ // counted when tried, so join and restart alternate even when one fails
			}
			if err := l.runAuto(a); err == nil {
				ran = append(ran, a.ID)
			}
		}
	}
	st.Attempts++
	st.LastFixAt = now
	if len(ran) > 0 {
		st.LastFix = ran[0]
	} else if len(plan) > 0 {
		st.LastFix = plan[0].ID // user-run suggestion; credited if the next check is OK
	}
	_ = l.Store.Append(Incident{Time: now, Event: "attempt", Class: class, Fingerprint: fp, Actions: ids(plan)})

	// Verify: re-probe once after auto actions; user-run fixes are verified next tick.
	if len(ran) > 0 {
		settle := 5 * time.Second
		if strings.HasPrefix(ran[0], "wifi-") {
			settle = wifiRejoinSettle // joining a network and getting an address takes longer than a page opening
		}
		l.Fx.Sleep(settle)
		if c2, _ := Classify(l.Prober.Probe(ctx)); !c2.Blocking() {
			l.resolve(&st, class, l.Fx.Now(), st.LastFix, fp)
			st.Class, st.Reason = c2, "recovered"
			l.finish(st)
			return st
		}
	}
	if st.Attempts >= maxAttempts && now.Sub(st.IncidentAt) >= st.Networks[st.IncidentFP].quietFor(class) {
		st.BreakerUntil = now.Add(breakerCooldwn)
		msg := fmt.Sprintf("%s persists after %d attempts. %s", class, st.Attempts, firstSay(plan))
		// One text when the breaker first opens, then at most every escalateEvery: the breaker
		// reopens every 30 min, which sent 71 texts in one week. None for OFFLINE (see above).
		remind := shouldNotify(l.Store, "escalated-"+string(class), escalateEvery, now)
		if class != Offline && (st.Attempts == maxAttempts || remind) {
			l.Fx.Notify("Argo needs you", msg)
		}
		_ = l.Store.Append(Incident{Time: now, Event: "escalated", Class: class, Fingerprint: fp, Detail: msg})
	}
	l.finish(st)
	return st
}

const escalateEvery = 2 * time.Hour

// longOutage is how long an unannounced incident (OFFLINE, or a usual blip)
// must last before its recovery is worth a notification.
const longOutage = 15 * time.Minute

// resolve closes an incident and learns from it honestly. A fix is credited
// only if it ran and was verified, or there is evidence the person did it:
// "switch network" only when the network changed, "exit node" only when one
// is in use, and a local-settings fix (proxy, daemon) because those never
// clear by themselves. "Wait" and unverifiable DNS advice never are: that
// incident cleared by itself, and its duration teaches Argo this network's
// usual recovery time.
func (l Loop) resolve(st *State, c Class, now time.Time, fix, fpNow string) {
	netFP := st.IncidentFP
	if netFP == "" {
		netFP = fpNow
	}
	if fix == "" {
		switch st.LastFix {
		case "", "wait", "usual-blip", "flush-dns", "check-magicdns": // nothing to show they were done
		case "switch-network", "leave-network", "avoid-weak-wifi":
			if fpNow != "" && fpNow != netFP {
				fix = st.LastFix
			}
		case "exit-node":
			if st.Tailscale.ExitNode != "" {
				fix = st.LastFix
			}
		default: // local settings (proxy, daemon, WPAD) never clear by themselves: the person fixed it
			fix = st.LastFix
		}
	}
	if netFP != "" {
		n := st.Networks[netFP]
		if fix != "" {
			if n.Fixes == nil {
				n.Fixes = map[Class]string{}
			}
			n.Fixes[c] = fix
		} else if !st.IncidentAt.IsZero() && now.After(st.IncidentAt) {
			if n.Recover == nil {
				n.Recover = map[Class][]int{}
			}
			n.Recover[c] = append(n.Recover[c], int(now.Sub(st.IncidentAt)/time.Second))
			if k := len(n.Recover[c]); k > keepRecoveries {
				n.Recover[c] = n.Recover[c][k-keepRecoveries:]
			}
		}
		st.Networks[netFP] = n
	}
	detail := ""
	if fix == "" {
		detail = "cleared by itself"
	}
	_ = l.Store.Append(Incident{Time: now, Event: "resolved", Class: c, Fingerprint: netFP, Fix: fix, Detail: detail})
	if st.Notified || (!st.IncidentAt.IsZero() && now.Sub(st.IncidentAt) >= longOutage) {
		l.Fx.Notify("Argo: recovered", fmt.Sprintf("%s resolved after %s\n%s", c, now.Sub(st.IncidentAt).Round(time.Minute), st.Net.Line()))
	}
	st.Attempts, st.BreakerUntil, st.LastFixAt, st.LastFix = 0, time.Time{}, time.Time{}, ""
	st.IncidentFP, st.Notified, st.NotifyDue = "", false, time.Time{}
}

func (l Loop) finish(st State) {
	_ = l.Store.Save(st)
	for _, p := range l.Pushers {
		p(st)
	}
}

func ids(a []Action) []string {
	out := make([]string, len(a))
	for i, x := range a {
		out[i] = x.ID
	}
	return out
}

func firstSay(a []Action) string {
	if len(a) == 0 {
		return ""
	}
	return a[0].Say
}
