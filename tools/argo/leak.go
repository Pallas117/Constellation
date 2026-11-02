package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// App data watch (2026-11-01, Josh: "do the same for 3rd party apps and data leakage").
// Passive: every 5 minutes it reads which apps on this Mac hold outbound TCP connections
// (lsof) and how much each has sent (nettop). For a week it only learns each app's usual
// destination networks, ports and upload size; after that it texts when
//   - an app it has never seen sends data to the internet,
//   - a known app suddenly reaches many networks it never used,
//   - an app (not Apple's) uses an unusual port,
//   - an app uploads far more than it normally does in 5 minutes.
// Destinations are kept as network prefixes (/24, /48), never full URLs or content.

const (
	leakEvery      = 5 * time.Minute
	leakLearn      = 7 * 24 * time.Hour
	leakNewDests   = 8              // new destination networks in one sample that count as a burst
	leakUploadMin  = 50 << 20       // an upload spike is at least 50 MB in 5 minutes...
	leakUploadX    = 10.0           // ...and 10x the app's usual
	leakMaxDests   = 200            // kept per app
	leakMaxApps    = 400            // kept in all
	leakRetell     = 24 * time.Hour // the same app's burst or spike is texted at most once a day
	leakUploadEWMA = 0.2            // weight of the newest 5-minute upload in the app's usual
)

// commonPorts are ordinary outbound ports; anything else from a non-Apple app is worth a look.
var commonPorts = map[int]bool{80: true, 443: true, 53: true, 853: true, 993: true, 995: true, 465: true, 587: true,
	5223: true, 5228: true, 3478: true, 3479: true, 3480: true, 3481: true, 41641: true, 22: true, 8443: true}

// Conn is one outbound connection of an app.
type Conn struct {
	PID  int
	App  string
	Dest string // network prefix: a.b.c.0/24 or the first 48 bits of IPv6
	Port int
}

// AppSeen is what the watch learned about one app.
type AppSeen struct {
	FirstSeen time.Time            `json:"first_seen"`
	Dests     map[string]time.Time `json:"dests,omitempty"`
	Ports     map[int]bool         `json:"ports,omitempty"`
	UpUsual   float64              `json:"up_usual,omitempty"` // EWMA of bytes sent per 5 minutes
	ToldAt    time.Time            `json:"told_at,omitempty"`
}

// Leak is the watch's own file (leak.json), kept apart from the loop's state.
type Leak struct {
	Since  time.Time          `json:"since"`
	LastAt time.Time          `json:"last_at"`
	Apps   map[string]AppSeen `json:"apps"`
	Sent   map[int]int64      `json:"sent,omitempty"` // bytes_out per PID at the last sample
}

// publicPrefix returns the destination network for a public address, or "" for local ones.
func publicPrefix(ip net.IP) string {
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsMulticast() || ip.IsUnspecified() || tailnet.Contains(ip) {
		return ""
	}
	if v4 := ip.To4(); v4 != nil {
		return fmt.Sprintf("%d.%d.%d.0/24", v4[0], v4[1], v4[2])
	}
	return (&net.IPNet{IP: ip.Mask(net.CIDRMask(48, 128)), Mask: net.CIDRMask(48, 128)}).String()
}

// parseLsof reads `lsof +c 0 -nP -iTCP -sTCP:ESTABLISHED -F pcn`.
func parseLsof(out string) []Conn {
	var conns []Conn
	pid, app := 0, ""
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(line[1:])
		case 'c':
			app = line[1:]
		case 'n':
			i := strings.Index(line, "->")
			if i < 0 {
				continue
			}
			host, port, err := net.SplitHostPort(line[i+2:])
			if err != nil {
				continue
			}
			p, _ := strconv.Atoi(port)
			dest := publicPrefix(net.ParseIP(strings.Trim(host, "[]")))
			if dest == "" {
				continue
			}
			k := fmt.Sprint(pid, dest, p)
			if !seen[k] {
				seen[k] = true
				conns = append(conns, Conn{PID: pid, App: app, Dest: dest, Port: p})
			}
		}
	}
	return conns
}

// parseNettop reads `nettop -P -L 1 -J bytes_out -x`: "name.pid,bytes," per process.
func parseNettop(out string) map[int]int64 {
	sent := map[int]int64{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(line, ",")
		if len(f) < 2 {
			continue
		}
		i := strings.LastIndex(f[0], ".")
		if i < 0 {
			continue
		}
		pid, err1 := strconv.Atoi(f[0][i+1:])
		b, err2 := strconv.ParseInt(f[1], 10, 64)
		if err1 == nil && err2 == nil {
			sent[pid] = b
		}
	}
	return sent
}

// appleApp: Apple's own daemons use their own ports (push, iCloud, FaceTime); don't flag those.
func appleApp(app string) bool {
	return strings.HasSuffix(app, "d") && !strings.Contains(app, " ") && strings.ToLower(app) == app || strings.HasPrefix(app, "com.apple.")
}

// leakFinding is one thing worth texting.
type leakFinding struct{ App, Title, Msg string }

// leakCheck folds one sample into what was learned and returns what to text. Pure, for tests.
func leakCheck(l *Leak, conns []Conn, sent map[int]int64, now time.Time) []leakFinding {
	if l.Apps == nil {
		l.Apps = map[string]AppSeen{}
	}
	if l.Since.IsZero() {
		l.Since = now
	}
	learning := now.Sub(l.Since) < leakLearn
	byApp := map[string][]Conn{}
	for _, c := range conns {
		byApp[c.App] = append(byApp[c.App], c)
	}
	// Bytes sent per app since the last sample (nettop counts per PID since it started).
	up := map[string]int64{}
	pidApp := map[int]string{}
	for _, c := range conns {
		pidApp[c.PID] = c.App
	}
	for pid, b := range sent {
		if prev, ok := l.Sent[pid]; ok && b >= prev && pidApp[pid] != "" {
			up[pidApp[pid]] += b - prev
		}
	}
	var out []leakFinding
	apps := make([]string, 0, len(byApp))
	for a := range byApp {
		apps = append(apps, a)
	}
	sort.Strings(apps)
	for _, app := range apps {
		cs := byApp[app]
		a, known := l.Apps[app]
		if !known {
			if len(l.Apps) >= leakMaxApps {
				continue
			}
			a = AppSeen{FirstSeen: now, Dests: map[string]time.Time{}, Ports: map[int]bool{}}
			if !learning {
				out = append(out, leakFinding{app, "Argo: new app sending data", fmt.Sprintf("%s started sending data to the internet (%d connection%s, e.g. %s port %d). If you didn't install or open it, check it.", app, len(cs), plural(len(cs)), cs[0].Dest, cs[0].Port)})
			}
		}
		newDests := 0
		var oddPorts []int
		for _, c := range cs {
			if _, ok := a.Dests[c.Dest]; !ok {
				newDests++
				if len(a.Dests) < leakMaxDests {
					a.Dests[c.Dest] = now
				}
			} else {
				a.Dests[c.Dest] = now
			}
			if !a.Ports[c.Port] && !commonPorts[c.Port] && !appleApp(app) {
				oddPorts = append(oddPorts, c.Port)
			}
			a.Ports[c.Port] = true
		}
		retell := now.Sub(a.ToldAt) >= leakRetell
		if !learning && known && retell {
			switch {
			case newDests >= leakNewDests:
				out = append(out, leakFinding{app, "Argo: app reaching many new places", fmt.Sprintf("%s just connected to %d networks it never used before. That can be an update or a new feature, or data going somewhere it shouldn't.", app, newDests)})
				a.ToldAt = now
			case len(oddPorts) > 0:
				out = append(out, leakFinding{app, "Argo: app on an unusual port", fmt.Sprintf("%s is sending on port %d, which ordinary apps rarely use.", app, oddPorts[0])})
				a.ToldAt = now
			}
		}
		if b := up[app]; b > 0 {
			if !learning && known && retell && a.ToldAt != now && float64(b) >= leakUploadMin && float64(b) >= leakUploadX*a.UpUsual {
				out = append(out, leakFinding{app, "Argo: large upload", fmt.Sprintf("%s sent %d MB in the last 5 minutes, about %.0fx what it usually sends.", app, b>>20, float64(b)/max(a.UpUsual, 1))})
				a.ToldAt = now
			}
			a.UpUsual = a.UpUsual*(1-leakUploadEWMA) + float64(b)*leakUploadEWMA
		}
		l.Apps[app] = a
	}
	l.Sent, l.LastAt = sent, now
	return out
}

func (s Store) loadLeak() Leak {
	var l Leak
	if b, err := os.ReadFile(s.path("leak.json")); err == nil {
		_ = json.Unmarshal(b, &l)
	}
	return l
}

func (s Store) saveLeak(l Leak) error {
	b, err := json.Marshal(l)
	if err != nil {
		return err
	}
	tmp := s.path("leak.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path("leak.json"))
}

// leakWatch runs from the tick; it samples at most every leakEvery.
func (l Loop) leakWatch(ctx context.Context) {
	lk := l.Store.loadLeak()
	now := l.Fx.Now()
	if !lk.LastAt.IsZero() && now.Sub(lk.LastAt) < leakEvery {
		return
	}
	conns := parseLsof(run(ctx, "lsof", "+c", "0", "-nP", "-iTCP", "-sTCP:ESTABLISHED", "-F", "pcn"))
	sent := parseNettop(run(ctx, "nettop", "-P", "-L", "1", "-J", "bytes_out", "-x"))
	for _, f := range leakCheck(&lk, conns, sent, now) {
		l.Fx.Notify(f.Title, f.Msg)
		l.say("app watch: %s", f.Msg)
	}
	_ = l.Store.saveLeak(lk)
}
