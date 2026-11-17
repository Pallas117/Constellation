package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Argo and the gauss-awake guard watch each other (and mesh-heal): each
// writes a heartbeat file every run, and each restarts the other with
// `launchctl kickstart` when that heartbeat goes stale. Neither is then a
// single point of failure for the lid-closed, on-the-road setup.

type Peer struct {
	Label     string `json:"label"`     // LaunchAgent label in the user's gui domain
	Heartbeat string `json:"heartbeat"` // file the peer touches every run; ~ is expanded
	MaxAge    string `json:"max_age"`   // e.g. "5m"; older than this is stale
}

const maxKicksPerHour = 3 // then alert only: a peer that dies on start needs a human

func defaultPeers() []Peer {
	return []Peer{
		{Label: "uk.lightbound.gauss-awake", Heartbeat: "~/Library/Application Support/Gauss/guard.heartbeat", MaxAge: "5m"},
		{Label: "uk.lightbound.mesh-heal", Heartbeat: "~/.local/share/mesh-heal/state", MaxAge: "10m"},
	}
}

type watchFx struct {
	modTime func(path string) (time.Time, bool) // false: missing
	loaded  func(label string) bool
	running func(label string) bool // mid-run now: leave it be (nil: never)
	kick    func(label string) error
	notify  func(key, title, msg string)
}

func realWatchFx(phone *Phone, s Store) watchFx {
	domain := fmt.Sprintf("gui/%d", os.Getuid())
	return watchFx{
		modTime: func(p string) (time.Time, bool) {
			fi, err := os.Stat(p)
			if err != nil {
				return time.Time{}, false
			}
			return fi.ModTime(), true
		},
		loaded: func(l string) bool { return exec.Command("launchctl", "print", domain+"/"+l).Run() == nil },
		running: func(l string) bool {
			out, _ := exec.Command("launchctl", "print", domain+"/"+l).Output()
			return strings.Contains(string(out), "state = running")
		},
		// No -k: a stale heartbeat with the job not running only needs a start.
		// -k killed mesh-heal mid-heal (between Wi-Fi off and on) right after
		// wake, when every heartbeat is stale (watch.json 2026-10-28 11:14-11:17).
		kick: func(l string) error { return exec.Command("launchctl", "kickstart", domain+"/"+l).Run() },
		notify: func(key, title, msg string) {
			if phone != nil && shouldNotify(s, key, time.Hour, time.Now()) {
				phone.Send(title, msg, time.Now())
			}
		},
	}
}

func expandHome(p string) string {
	if len(p) > 1 && p[:2] == "~/" {
		return filepath.Join(home(), p[2:])
	}
	return p
}

// watchPeers restarts stale peers and returns what it did, one line each.
// Kicks are remembered in watch.json so a crash-looping peer isn't kicked
// more than maxKicksPerHour times.
func watchPeers(peers []Peer, s Store, fx watchFx, now time.Time) []string {
	path := s.path("watch.json")
	kicks := map[string][]time.Time{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &kicks)
	}
	var out []string
	for _, p := range peers {
		max, err := time.ParseDuration(p.MaxAge)
		if err != nil || p.Label == "" || !fx.loaded(p.Label) {
			continue // not installed (or misconfigured): nothing to keep alive
		}
		if fx.running != nil && fx.running(p.Label) {
			continue // a run in progress will write its heartbeat when it ends
		}
		mt, ok := fx.modTime(expandHome(p.Heartbeat))
		age := now.Sub(mt)
		if ok && age <= max {
			continue
		}
		stale := "no heartbeat yet"
		if ok {
			stale = fmt.Sprintf("no heartbeat for %d min", int(age.Minutes()))
		}
		var recent []time.Time
		for _, t := range kicks[p.Label] {
			if now.Sub(t) < time.Hour {
				recent = append(recent, t)
			}
		}
		if len(recent) >= maxKicksPerHour {
			out = append(out, p.Label+": "+stale+"; restart limit reached")
			fx.notify("watch-"+p.Label, "Argo: "+p.Label+" keeps failing",
				fmt.Sprintf("%s after %d restarts this hour. Check its log.", stale, len(recent)))
			kicks[p.Label] = recent
			continue
		}
		if err := fx.kick(p.Label); err != nil {
			out = append(out, p.Label+": "+stale+"; restart failed")
			fx.notify("watch-"+p.Label, "Argo: can't restart "+p.Label, stale+"; launchctl kickstart failed.")
		} else {
			out = append(out, p.Label+": "+stale+"; restarted")
		}
		kicks[p.Label] = append(recent, now)
	}
	b, _ := json.Marshal(kicks)
	_ = os.MkdirAll(s.Dir, 0o700)
	_ = os.WriteFile(path, b, 0o600)
	return out
}
