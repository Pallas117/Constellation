package main

import (
	"context"
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
}

// Plan returns the ladder for a class, least invasive first. Tailscale is
// left to mesh-heal: Argo only recommends exit nodes, never switches them,
// because mesh-heal's bare `tailscale up` fails once non-default prefs exist.
func Plan(c Class, s Snapshot, remembered string) []Action {
	var a []Action
	switch c {
	case Offline:
		a = append(a, Action{ID: "wait", Say: "No network. Join Wi-Fi or enable the hotspot; mesh-heal will reconnect Tailscale."})
	case Captive:
		a = append(a, Action{ID: "open-portal", Say: "Wi-Fi login page detected; opening it.", Command: "open http://captive.apple.com", Auto: true})
	case DNS:
		a = append(a, Action{ID: "flush-dns", Say: "DNS is failing. Flush the resolver cache:", Command: "sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder", Admin: true})
		if s.Tailscale.Running {
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
		a = append(a, Action{ID: "switch-network", Say: "Switch to a Malaysian SIM or local Wi-Fi (Hong Kong eSIMs exit in HK, which Anthropic does not serve)."})
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

// Effects are the side effects the loop may cause; tests replace them.
type Effects interface {
	Notify(title, msg string)
	Open(url string) error
	Sleep(d time.Duration)
	Now() time.Time
}

type realEffects struct{}

func (realEffects) Notify(title, msg string) {
	// Message is passed as an argv item, never interpolated into AppleScript.
	_ = exec.Command("osascript",
		"-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run",
		title, msg).Run()
}
func (realEffects) Open(u string) error   { return exec.Command("open", u).Run() }
func (realEffects) Sleep(d time.Duration) { time.Sleep(d) }
func (realEffects) Now() time.Time        { return time.Now() }

// Loop runs probe → classify → remediate → verify → remember once.
type Loop struct {
	Prober  Prober
	Store   Store
	Fx      Effects
	Out     func(string) // foreground output; nil in the LaunchAgent
	Pushers []func(State)
}

func (l Loop) say(format string, args ...any) {
	if l.Out != nil {
		l.Out(fmt.Sprintf(format, args...))
	}
}

func (l Loop) Tick(ctx context.Context) State {
	st := l.Store.Load()
	snap := l.Prober.Probe(ctx)
	class, reason := Classify(snap)
	now := l.Fx.Now()
	fp := Fingerprint(snap.GatewayMAC, snap.PublicIP)
	if fp != "" {
		if _, ok := st.Networks[fp]; !ok {
			st.Networks[fp] = Net{FirstSeen: now, Fixes: map[Class]string{}}
		}
	}
	prev := st.Class
	st.Fingerprint, st.Loc, st.CheckedAt, st.Tailscale = fp, snap.Loc, now, snap.Tailscale
	l.say("%s  %s", class, reason)

	if !class.Blocking() {
		if prev.Blocking() {
			l.resolve(&st, prev, now, "")
		}
		if class != prev && !prev.Blocking() && prev != "" { // recoveries are notified by resolve
			l.Fx.Notify("Argo: "+string(class), reason)
		}
		st.Class, st.Reason = class, reason
		l.finish(st)
		return st
	}

	if class != prev {
		if prev.Blocking() { // one failure turned into another: close the old incident
			_ = l.Store.Append(Incident{Time: now, Event: "superseded", Class: prev, Fingerprint: fp})
		}
		st.IncidentAt, st.Attempts, st.LastFix = now, 0, ""
		_ = l.Store.Append(Incident{Time: now, Event: "open", Class: class, Fingerprint: fp, Detail: reason})
		l.Fx.Notify("Argo: "+string(class), reason) // rate limit: only on class change
	}
	st.Class, st.Reason = class, reason

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
	var ran []string
	for _, a := range plan {
		line := a.Say
		if a.Command != "" {
			line += "\n    " + a.Command
		}
		l.say("→ %s", line)
		if a.Auto {
			if err := l.Fx.Open(strings.TrimPrefix(a.Command, "open ")); err == nil {
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
		l.Fx.Sleep(5 * time.Second)
		if c2, _ := Classify(l.Prober.Probe(ctx)); !c2.Blocking() {
			l.resolve(&st, class, l.Fx.Now(), st.LastFix)
			st.Class, st.Reason = c2, "recovered"
			l.finish(st)
			return st
		}
	}
	if st.Attempts >= maxAttempts {
		st.BreakerUntil = now.Add(breakerCooldwn)
		msg := fmt.Sprintf("%s persists after %d attempts. %s", class, st.Attempts, firstSay(plan))
		l.Fx.Notify("Argo needs you", msg)
		_ = l.Store.Append(Incident{Time: now, Event: "escalated", Class: class, Fingerprint: fp, Detail: msg})
	}
	l.finish(st)
	return st
}

func (l Loop) resolve(st *State, c Class, now time.Time, fix string) {
	if fix == "" {
		fix = st.LastFix
	}
	if fix != "" && st.Fingerprint != "" {
		n := st.Networks[st.Fingerprint]
		if n.Fixes == nil {
			n.Fixes = map[Class]string{}
		}
		n.Fixes[c] = fix
		st.Networks[st.Fingerprint] = n
	}
	_ = l.Store.Append(Incident{Time: now, Event: "resolved", Class: c, Fingerprint: st.Fingerprint, Fix: fix})
	l.Fx.Notify("Argo: recovered", fmt.Sprintf("%s resolved", c))
	st.Attempts, st.BreakerUntil, st.LastFixAt, st.LastFix = 0, time.Time{}, time.Time{}, ""
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
