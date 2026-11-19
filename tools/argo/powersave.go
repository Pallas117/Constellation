package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ---- power-save mode ----
//
// Josh 17 Nov 2026: make adjustments to settings as needed, on every device Argo runs on. A
// spacecraft in eclipse sheds loads in a fixed order (non-essential first) and restores them in
// sunlight; Argo does the same for a laptop whose power budget is negative (power.go): on battery,
// on a charger that cannot keep up, or on plain 5 V USB (charger.go).
//
// Entering is immediate. Leaving needs the budget to be healthy for powerSaveExitAfter, so a
// charger that flaps does not flap the mode. While on, Argo:
//   - holds heavy work (the guard's "power-save" finding, with the charger advice);
//   - stretches its own timers by powerSaveFactor (probes, guard sampling, mesh report cadence);
//   - quits allowlisted menu-bar apps that are idle by their own state, and records what it quit so
//     leaving can relaunch it;
//   - texts once (warn, at most every 6 h).
// Everything above needs no admin rights and is reversible. Settings that do need admin (pmset,
// power profiles) are only ever suggested with the exact command, never run, and nothing is
// changed through UI scripting (it needs an Automation prompt that blocks an unattended run).

const (
	powerSaveFactor    = 3                // timers run this many times slower while on
	powerSaveExitAfter = 10 * time.Minute // a healthy budget this long ends it
	powerSaveTextEvery = 6 * time.Hour
	powerSaveMaxQuit   = 8 // cap on remembered apps
)

// Reasons (also the allowlist on the hub: backend/mesh/store.ts MESH_POWER_SAVE_REASONS).
const (
	PSBattery = "battery"       // on battery
	PSShort   = "charger-short" // plugged in, but the charger can't carry the load
	PSNoPD    = "no-pd"         // plain 5 V USB, no USB-C Power Delivery
	PSManual  = "manual"        // `argo power-save on`
)

// QuitApp is an app Argo quit and will relaunch.
type QuitApp struct {
	Name string    `json:"name"`
	App  string    `json:"app"` // .app bundle path from the allowlist, never from input
	At   time.Time `json:"at"`
}

// PowerSave is the mode's saved state (power-save.json, 0600).
type PowerSave struct {
	On      bool      `json:"on"`
	Since   time.Time `json:"since,omitempty"`
	Reason  string    `json:"reason,omitempty"`
	Forced  string    `json:"forced,omitempty"`  // "on" or "off" from the CLI; empty = automatic
	Healthy time.Time `json:"healthy,omitempty"` // since when the budget has been healthy (while on)
	Quit    []QuitApp `json:"quit,omitempty"`
}

func (s Store) loadPowerSave() PowerSave {
	var p PowerSave
	if b, err := os.ReadFile(s.path("power-save.json")); err == nil {
		_ = json.Unmarshal(b, &p)
	}
	if len(p.Quit) > powerSaveMaxQuit {
		p.Quit = p.Quit[:powerSaveMaxQuit]
	}
	return p
}

func (s Store) savePowerSave(p PowerSave) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(p)
	tmp := s.path("power-save.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path("power-save.json"))
}

// powerSaveWanted says whether the budget calls for power-save and why. Hosts with no battery or no
// reading never want it (unknown is never guessed).
func powerSaveWanted(b *Battery) (bool, string) {
	if b == nil || !b.Present {
		return false, ""
	}
	if !b.OnAC {
		return true, PSBattery
	}
	if chargerOf(b, defaultWorkerW).State == ChargerNoPD {
		return true, PSNoPD
	}
	if powerBudget(Sample{Batt: b}).Mode == PowerNegative {
		return true, PSShort
	}
	return false, ""
}

// powerSaveStep is the pure state machine. changed is "entered", "left" or "".
func powerSaveStep(p PowerSave, b *Battery, now time.Time) (next PowerSave, changed string) {
	want, reason := powerSaveWanted(b)
	switch p.Forced {
	case "on":
		want, reason = true, PSManual
	case "off":
		want = false
	}
	switch {
	case want && !p.On:
		return PowerSave{On: true, Since: now, Reason: reason, Forced: p.Forced, Quit: p.Quit}, "entered"
	case want:
		p.Reason, p.Healthy = reason, time.Time{} // the reason can change while on
		return p, ""
	case !p.On:
		return p, ""
	case p.Forced == "off":
		return PowerSave{Forced: p.Forced, Quit: p.Quit}, "left"
	case p.Healthy.IsZero():
		p.Healthy = now
		return p, ""
	case now.Sub(p.Healthy) >= powerSaveExitAfter:
		return PowerSave{Forced: p.Forced, Quit: p.Quit}, "left"
	}
	return p, ""
}

// stretch scales a timer while power-save is on.
func stretch(d time.Duration, on bool) time.Duration {
	if on {
		return d * powerSaveFactor
	}
	return d
}

// ---- allowlisted idle apps ----

// idleApp is a menu-bar app Argo may quit while saving power, and only when its own state says it
// is idle. Paths are pinned and absolute; nothing here comes from the network or a report.
type idleApp struct {
	Name   string
	App    string   // bundle to relaunch
	Exec   string   // its process, matched exactly against `ps` output
	State  []string // argv (absolute tool first) that prints its state
	IdleRe *regexp.Regexp
}

var idleApps = []idleApp{{
	Name:   "Cloudflare WARP",
	App:    "/Applications/Cloudflare WARP.app",
	Exec:   "/Applications/Cloudflare WARP.app/Contents/MacOS/Cloudflare WARP",
	State:  []string{"/usr/local/bin/warp-cli", "status"},
	IdleRe: regexp.MustCompile(`(?i)\bDisconnected\b`), // the daemon stays; only the menu-bar app quits
}}

// appFx is everything the app handling touches, so tests don't.
type appFx struct {
	Run    func(ctx context.Context, argv ...string) string // stdout of an absolute-path argv, no shell
	Exists func(path string) bool
	Kill   func(pid int) error // SIGTERM: the app's normal quit, no Automation permission needed
	Launch func(ctx context.Context, app string) error
}

func realAppFx() appFx {
	return appFx{
		Run: func(ctx context.Context, argv ...string) string {
			c, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			out, _ := exec.CommandContext(c, argv[0], argv[1:]...).Output()
			return string(out)
		},
		Exists: func(p string) bool { _, err := os.Stat(p); return err == nil },
		Kill: func(pid int) error {
			pr, err := os.FindProcess(pid)
			if err != nil {
				return err
			}
			return pr.Signal(syscall.SIGTERM)
		},
		Launch: func(ctx context.Context, app string) error {
			c, cancel := context.WithTimeout(ctx, 10*time.Second)
			defer cancel()
			return exec.CommandContext(c, "/usr/bin/open", "-g", app).Run() // -g: stays in the background
		},
	}
}

// pidsOf finds this user's processes whose executable is exactly path (ps -x lists only them).
func pidsOf(psOut, path string) []int {
	var pids []int
	for _, line := range strings.Split(psOut, "\n") {
		f := strings.TrimSpace(line)
		i := strings.IndexByte(f, ' ')
		if i < 0 {
			continue
		}
		pid, err := strconv.Atoi(f[:i])
		if err == nil && pid > 1 && strings.TrimSpace(f[i:]) == path {
			pids = append(pids, pid)
		}
	}
	return pids
}

// quitIdleApps quits each allowlisted app that is running and idle by its own state, and returns
// the ones it quit (for relaunch). An app whose state can't be read is left alone.
func quitIdleApps(ctx context.Context, fx appFx, already []QuitApp, now time.Time) []QuitApp {
	quit := append([]QuitApp(nil), already...)
	ps := ""
	for _, a := range idleApps {
		if len(quit) >= powerSaveMaxQuit || !fx.Exists(a.State[0]) {
			continue
		}
		if ps == "" {
			ps = fx.Run(ctx, "/bin/ps", "-axo", "pid=,comm=")
		}
		pids := pidsOf(ps, a.Exec)
		if len(pids) == 0 || !a.IdleRe.MatchString(fx.Run(ctx, a.State...)) {
			continue
		}
		done := false
		for _, pid := range pids {
			done = fx.Kill(pid) == nil || done
		}
		if done {
			quit = append(quit, QuitApp{Name: a.Name, App: a.App, At: now})
		}
	}
	return quit
}

// relaunchApps reopens what Argo quit (only apps still on the allowlist, and not already running)
// and returns those it could not reopen so they stay recorded.
func relaunchApps(ctx context.Context, fx appFx, quit []QuitApp) []QuitApp {
	var left []QuitApp
	ps := fx.Run(ctx, "/bin/ps", "-axo", "pid=,comm=")
	for _, q := range quit {
		var a *idleApp
		for i := range idleApps {
			if idleApps[i].App == q.App {
				a = &idleApps[i]
			}
		}
		if a == nil || len(pidsOf(ps, a.Exec)) > 0 {
			continue // not ours any more, or the owner already reopened it
		}
		if fx.Launch(ctx, a.App) != nil {
			left = append(left, q)
		}
	}
	return left
}

// ---- the tick ----

// powerSaveTick runs inside guardTick with the fresh sample. It saves the state, logs each change
// and acts on it: quit apps and text once on entering, relaunch on leaving.
func powerSaveTick(ctx context.Context, s Store, fx appFx, phone *Phone, b *Battery, now time.Time, out io.Writer) PowerSave {
	p := s.loadPowerSave()
	next, changed := powerSaveStep(p, b, now)
	switch changed {
	case "entered":
		next.Quit = quitIdleApps(ctx, fx, next.Quit, now)
		fmt.Fprintf(out, "argo: power-save on (%s)\n", next.Reason)
		if phone != nil && shouldNotify(s, "power-save", powerSaveTextEvery, now) {
			phone.SendAlert(Alert{Level: AlertWarn, Key: "power-save", Title: "Gauss: power-save on", Msg: powerSaveText(next, b)}, now)
		}
	case "left":
		next.Quit = relaunchApps(ctx, fx, next.Quit)
		fmt.Fprintln(out, "argo: power-save off")
	case "":
		if next.On && len(next.Quit) < powerSaveMaxQuit { // an app that went idle later
			next.Quit = quitIdleApps(ctx, fx, next.Quit, now)
		}
	}
	if changed != "" || next.On != p.On || next.Reason != p.Reason || len(next.Quit) != len(p.Quit) || !next.Healthy.Equal(p.Healthy) {
		_ = s.savePowerSave(next)
	}
	return next
}

// powerSaveText is the one text: what changed and what to do about the power.
func powerSaveText(p PowerSave, b *Battery) string {
	why := map[string]string{
		PSBattery: "the Mac is on battery",
		PSShort:   "the charger can't carry the load",
		PSNoPD:    "the charger is plain USB",
		PSManual:  "it was switched on by hand",
	}[p.Reason]
	msg := "Argo is saving power because " + why + ": heavy jobs wait and checks run less often."
	if c := chargerWhy(chargerOf(b, defaultWorkerW)); c != "" {
		msg += " " + c + "."
	} else if p.Reason == PSBattery {
		msg += " Plug in to end it."
	}
	return msg
}

// powerSaveGuardText is the guard finding's text.
func powerSaveGuardText(p PowerSave, b *Battery) string {
	t := "power-save is on (" + p.Reason + "): heavy work waits"
	if c := chargerWhy(chargerOf(b, defaultWorkerW)); c != "" {
		t += ": " + c
	}
	return t
}

// ---- suggestions (never run) ----

var pmsetLineRe = regexp.MustCompile(`^\s*(powernap|displaysleep|lowpowermode)\s+(\d+)`)

// pmsetBatteryValues reads the Battery Power section of `pmset -g custom`.
func pmsetBatteryValues(out string) map[string]int {
	vals := map[string]int{}
	in := false
	for _, l := range strings.Split(out, "\n") {
		switch t := strings.TrimSpace(l); {
		case strings.HasPrefix(t, "Battery Power"):
			in = true
		case strings.HasSuffix(t, ":"):
			in = false
		case in:
			if m := pmsetLineRe.FindStringSubmatch(l); m != nil {
				vals[m[1]], _ = strconv.Atoi(m[2])
			}
		}
	}
	return vals
}

// powerSaveSuggestions lists admin settings that would save more power and are not set yet, each
// with its exact command. They are advice for the owner; Argo never runs them. exists and pmset
// are injected for tests; an unknown setting is not suggested.
func powerSaveSuggestions(goos string, exists func(string) bool, pmset string) []string {
	var out []string
	switch goos {
	case "darwin":
		v := pmsetBatteryValues(pmset)
		if x, ok := v["powernap"]; ok && x != 0 {
			out = append(out, "sudo pmset -b powernap 0")
		}
		if x, ok := v["displaysleep"]; ok && x > 2 {
			out = append(out, "sudo pmset -b displaysleep 2")
		}
		if x, ok := v["lowpowermode"]; ok && x != 1 {
			out = append(out, "sudo pmset -a lowpowermode 1")
		}
	case "linux":
		if exists("/usr/bin/powerprofilesctl") {
			out = append(out, "powerprofilesctl set power-saver")
		}
		if exists("/usr/sbin/tlp") || exists("/usr/bin/tlp") {
			out = append(out, "sudo tlp bat")
		}
	}
	return out
}

// ---- CLI and display ----

func powerSaveStatusText(p PowerSave, now time.Time, suggestions []string) string {
	var b strings.Builder
	if p.On {
		fmt.Fprintf(&b, "power-save: on since %s (%s)", p.Since.Local().Format("15:04"), p.Reason)
	} else {
		b.WriteString("power-save: off")
	}
	if p.Forced != "" {
		fmt.Fprintf(&b, ", forced %s (`argo power-save auto` hands it back)", p.Forced)
	}
	b.WriteString("\n")
	for _, q := range p.Quit {
		fmt.Fprintf(&b, "  quit while saving: %s (comes back when it ends)\n", q.Name)
	}
	if len(suggestions) > 0 {
		b.WriteString("  more savings need admin rights, so Argo only suggests them:\n")
		for _, s := range suggestions {
			fmt.Fprintf(&b, "    %s\n", s)
		}
	}
	return b.String()
}

func realSuggestions(ctx context.Context, fx appFx, goos string) []string {
	pmset := ""
	if goos == "darwin" {
		pmset = fx.Run(ctx, "/usr/bin/pmset", "-g", "custom")
	}
	return powerSaveSuggestions(goos, fx.Exists, pmset)
}

// powerSaveCmd is `argo power-save [on|off|auto|status]`.
func powerSaveCmd(ctx context.Context, args []string, s Store, fx appFx, battery *Battery, goos string, now time.Time, out io.Writer) error {
	sub := "status"
	if len(args) > 0 {
		sub = args[0]
	}
	p := s.loadPowerSave()
	switch sub {
	case "status":
	case "on", "off", "auto":
		p.Forced = map[string]string{"on": "on", "off": "off", "auto": ""}[sub]
		next, changed := powerSaveStep(p, battery, now)
		if changed == "entered" {
			next.Quit = quitIdleApps(ctx, fx, next.Quit, now)
		}
		if changed == "left" {
			next.Quit = relaunchApps(ctx, fx, next.Quit)
		}
		if sub == "off" && changed != "left" {
			next.Quit = relaunchApps(ctx, fx, next.Quit)
		}
		if err := s.savePowerSave(next); err != nil {
			return err
		}
		p = next
	default:
		return fmt.Errorf("usage: argo power-save [on|off|auto|status]")
	}
	_, err := io.WriteString(out, powerSaveStatusText(p, now, realSuggestions(ctx, fx, goos)))
	return err
}

// addPowerSave adds the mode to a Gauss report: on or off, since when and why. Older Gauss
// versions drop fields they don't know; the hub range-checks it (parseReport).
func addPowerSave(report map[string]any, p PowerSave) {
	ps := map[string]any{"on": p.On}
	if p.On {
		ps["since"] = p.Since.UTC().Format(time.RFC3339)
		ps["reason"] = p.Reason
	}
	report["powerSave"] = ps
}

// powerSaveStatus is the suffix for `argo status`.
func powerSaveStatus(p PowerSave) string {
	if !p.On {
		return ""
	}
	return " power-save:" + p.Reason
}

// doctorPowerSave prints the mode and the admin settings Argo suggests (never runs).
func doctorPowerSave(ctx context.Context, s Store, out io.Writer) {
	p := s.loadPowerSave()
	fmt.Fprint(out, "\n"+powerSaveStatusText(p, time.Now(), realSuggestions(ctx, realAppFx(), runtime.GOOS)))
}
