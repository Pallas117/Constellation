package main

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

var psT0 = time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)

func psBatt(ac bool, adapter *Adapter, adapterW, systemW float64) *Battery {
	b := chBatt(70, ac)
	b.Adapter, b.AdapterW, b.SystemW = adapter, adapterW, systemW
	return b
}

func TestPowerSaveEntersAndLeaves(t *testing.T) {
	for _, c := range []struct {
		name   string
		b      *Battery
		want   bool
		reason string
	}{
		{"on battery", psBatt(false, nil, 0, 8), true, PSBattery},
		{"plain 5 V USB (judith, 17 Nov)", psBatt(true, &Adapter{Volts: 5, Amps: 1.5, Watts: 8}, 8, 6), true, PSNoPD},
		{"PD charger that can't keep up", psBatt(true, &Adapter{Volts: 20, Watts: 18}, 18, 25), true, PSShort},
		{"PD charger with margin", psBatt(true, &Adapter{Volts: 20, Watts: 60}, 60, 20), false, ""},
		{"no draw reading is not guessed", psBatt(true, nil, 0, 0), false, ""},
		{"no battery (desktop, container)", nil, false, ""},
		{"battery absent", &Battery{}, false, ""},
	} {
		got, reason := powerSaveWanted(c.b)
		if got != c.want || reason != c.reason {
			t.Errorf("%s: %v %q, want %v %q", c.name, got, reason, c.want, c.reason)
		}
	}

	bad, good := psBatt(false, nil, 0, 8), psBatt(true, &Adapter{Volts: 20, Watts: 60}, 60, 20)
	p, ch := powerSaveStep(PowerSave{}, bad, psT0)
	if ch != "entered" || !p.On || p.Reason != PSBattery || !p.Since.Equal(psT0) {
		t.Fatalf("enter: %+v %q", p, ch)
	}
	// Recovery needs 10 calm minutes: a charger that flaps does not flap the mode.
	p, ch = powerSaveStep(p, good, psT0.Add(time.Minute))
	if ch != "" || !p.On {
		t.Fatalf("one good reading left it: %+v %q", p, ch)
	}
	p, _ = powerSaveStep(p, bad, psT0.Add(5*time.Minute)) // flap: the clock restarts
	p, _ = powerSaveStep(p, good, psT0.Add(6*time.Minute))
	if p, ch = powerSaveStep(p, good, psT0.Add(15*time.Minute)); ch != "" || !p.On {
		t.Fatalf("left 9 min after the flap: %+v %q", p, ch)
	}
	if p, ch = powerSaveStep(p, good, psT0.Add(16*time.Minute)); ch != "left" || p.On {
		t.Fatalf("still on 10 min after the flap: %+v %q", p, ch)
	}
	// The reason follows the budget while on.
	p, _ = powerSaveStep(PowerSave{}, bad, psT0)
	if p, _ = powerSaveStep(p, psBatt(true, &Adapter{Volts: 5, Watts: 8}, 8, 6), psT0.Add(time.Minute)); p.Reason != PSNoPD || !p.Since.Equal(psT0) {
		t.Errorf("reason did not follow: %+v", p)
	}
}

func TestPowerSaveForced(t *testing.T) {
	good := psBatt(true, &Adapter{Volts: 20, Watts: 60}, 60, 20)
	p, ch := powerSaveStep(PowerSave{Forced: "on"}, good, psT0)
	if ch != "entered" || p.Reason != PSManual {
		t.Fatalf("forced on: %+v %q", p, ch)
	}
	if p, ch = powerSaveStep(p, good, psT0.Add(time.Hour)); ch != "" || !p.On {
		t.Fatalf("forced on ended by itself: %+v %q", p, ch)
	}
	// Forced off leaves at once, even on battery, and stays off until `auto`.
	bad := psBatt(false, nil, 0, 8)
	p.Forced = "off"
	if p, ch = powerSaveStep(p, bad, psT0.Add(2*time.Hour)); ch != "left" || p.On {
		t.Fatalf("forced off: %+v %q", p, ch)
	}
	if p, ch = powerSaveStep(p, bad, psT0.Add(3*time.Hour)); ch != "" || p.On {
		t.Fatalf("forced off re-entered: %+v %q", p, ch)
	}
	p.Forced = ""
	if _, ch = powerSaveStep(p, bad, psT0.Add(4*time.Hour)); ch != "entered" {
		t.Errorf("auto did not resume: %q", ch)
	}
}

func TestPowerSaveStretchesTimers(t *testing.T) {
	if stretch(time.Minute, false) != time.Minute || stretch(time.Minute, true) != powerSaveFactor*time.Minute {
		t.Fatal("stretch")
	}
	now := time.Now()
	home := State{Class: OK, CheckedAt: now.Add(-6 * time.Minute), Gateway: "192.168.1.254", GatewayMAC: "aa"}
	if skipTickSaving(home, "192.168.1.254", "aa", now, false, false) {
		t.Error("6 min since the check, normal: should probe (every ~5 min)")
	}
	if !skipTickSaving(home, "192.168.1.254", "aa", now, false, true) {
		t.Error("6 min since the check, power-save: probe waits (every ~15 min)")
	}
	home.CheckedAt = now.Add(-16 * time.Minute)
	if skipTickSaving(home, "192.168.1.254", "aa", now, false, true) {
		t.Error("16 min: probe due")
	}
	hot := State{Class: OK, CheckedAt: now.Add(-4 * time.Minute), Gateway: "172.20.10.1"}
	if !skipTickSaving(hot, "172.20.10.1", "", now, false, true) || skipTickSaving(hot, "172.20.10.1", "", now, false, false) {
		t.Error("hotspot: power-save alone stretches the probe (7.5 min), AC at the normal pace probes every minute")
	}
	// A broken link or a new gateway still probes at once.
	if skipTickSaving(State{Class: Class("HOTSPOT-DOWN"), CheckedAt: now}, "192.168.1.254", "", now, true, true) {
		t.Error("blocking class skipped")
	}
	if skipTickSaving(home, "10.0.0.1", "aa", now.Add(-17*time.Minute), true, true) {
		t.Error("gateway change skipped")
	}
	last := psT0
	if !sampleDue(false, last, last.Add(time.Second)) || sampleDue(true, last, last.Add(time.Minute)) || !sampleDue(true, last, last.Add(176*time.Second)) || !sampleDue(true, time.Time{}, last) {
		t.Error("guard sampling cadence")
	}
	// Mesh report cadence.
	if reportGap(false, State{Class: OK}) != minReportGap || reportGap(true, State{Class: OK}) != 3*time.Minute {
		t.Error("report gap")
	}
	if reportGap(true, State{Class: Class("HOTSPOT-DOWN")}) != minReportGap {
		t.Error("a broken link must report at once")
	}
}

const (
	warpExec  = "/Applications/Cloudflare WARP.app/Contents/MacOS/Cloudflare WARP"
	psRunning = "  101 /usr/sbin/cfprefsd\n  4242 " + warpExec + "\n  4243 /Applications/Cloudflare WARP.app/Contents/Resources/other\n"
)

type fakeApps struct {
	status   string
	ps       string
	missing  bool
	killed   []int
	launched []string
	failOpen bool
	cmds     [][]string
}

func (f *fakeApps) fx() appFx {
	return appFx{
		Run: func(_ context.Context, argv ...string) string {
			f.cmds = append(f.cmds, argv)
			if argv[0] == "/bin/ps" {
				return f.ps
			}
			if argv[0] == "/usr/local/bin/warp-cli" {
				return f.status
			}
			return ""
		},
		Exists: func(string) bool { return !f.missing },
		Kill:   func(pid int) error { f.killed = append(f.killed, pid); return nil },
		Launch: func(_ context.Context, app string) error {
			if f.failOpen {
				return os.ErrNotExist
			}
			f.launched = append(f.launched, app)
			f.ps = "" // it is running again, but not under the pid list the test checks
			return nil
		},
	}
}

func TestPowerSaveQuitsOnlyIdleAllowlistedApps(t *testing.T) {
	ctx := context.Background()
	for _, c := range []struct {
		name string
		f    fakeApps
		want int
	}{
		{"disconnected and running: quit", fakeApps{status: "Status update: Disconnected\nReason: Manual Disconnection", ps: psRunning}, 1},
		{"connected: left alone", fakeApps{status: "Status update: Connected", ps: psRunning}, 0},
		{"state unreadable: left alone", fakeApps{status: "", ps: psRunning}, 0},
		{"not running", fakeApps{status: "Disconnected", ps: "  101 /usr/sbin/cfprefsd\n"}, 0},
		{"another process with a similar path is not ours", fakeApps{status: "Disconnected", ps: "  9 /Applications/Cloudflare WARP.app/Contents/Resources/other\n"}, 0},
		{"cli missing", fakeApps{status: "Disconnected", ps: psRunning, missing: true}, 0},
	} {
		f := c.f
		got := quitIdleApps(ctx, f.fx(), nil, psT0)
		if len(got) != c.want || len(f.killed) != c.want {
			t.Errorf("%s: quit %v killed %v", c.name, got, f.killed)
		}
		if c.want == 1 && (f.killed[0] != 4242 || got[0].Name != "Cloudflare WARP") {
			t.Errorf("%s: wrong target %v %v", c.name, f.killed, got)
		}
		for _, argv := range f.cmds { // pinned absolute paths, never a shell
			if !strings.HasPrefix(argv[0], "/") || argv[0] == "/bin/sh" || argv[0] == "/bin/bash" || argv[0] == "/bin/zsh" {
				t.Errorf("%s: unpinned or shell command %v", c.name, argv)
			}
		}
	}
}

func TestPowerSaveRelaunchesWhatItQuit(t *testing.T) {
	ctx := context.Background()
	quit := []QuitApp{{Name: "Cloudflare WARP", App: "/Applications/Cloudflare WARP.app", At: psT0}}
	f := &fakeApps{ps: "  1 /sbin/launchd\n"}
	if left := relaunchApps(ctx, f.fx(), quit); len(left) != 0 || len(f.launched) != 1 || f.launched[0] != quit[0].App {
		t.Fatalf("relaunch: left %v launched %v", left, f.launched)
	}
	// The owner opened it already: not opened twice.
	f = &fakeApps{ps: psRunning}
	if left := relaunchApps(ctx, f.fx(), quit); len(left) != 0 || len(f.launched) != 0 {
		t.Errorf("relaunched a running app: %v %v", left, f.launched)
	}
	// A failed launch stays recorded for the next try.
	f = &fakeApps{ps: "", failOpen: true}
	if left := relaunchApps(ctx, f.fx(), quit); len(left) != 1 {
		t.Errorf("a failed relaunch was forgotten: %v", left)
	}
	// Records only ever name allowlisted bundles: a tampered state file launches nothing.
	f = &fakeApps{ps: ""}
	evil := []QuitApp{{Name: "x", App: "/tmp/evil.app"}}
	if left := relaunchApps(ctx, f.fx(), evil); len(left) != 0 || len(f.launched) != 0 {
		t.Errorf("launched a bundle off the allowlist: %v", f.launched)
	}
}

func TestPowerSaveTickActsOnceAndRestores(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	var texts []string
	phone := testPhone(t, func(_, text string) error { texts = append(texts, text); return nil })
	f := &fakeApps{status: "Disconnected", ps: psRunning}
	var log bytes.Buffer
	bad := psBatt(true, &Adapter{Volts: 5, Amps: 1.5, Watts: 8}, 8, 6)
	good := psBatt(true, &Adapter{Volts: 20, Watts: 60}, 60, 20)

	p := powerSaveTick(context.Background(), s, f.fx(), phone, bad, psT0, &log)
	if !p.On || len(p.Quit) != 1 || len(f.killed) != 1 {
		t.Fatalf("entering: %+v killed %v", p, f.killed)
	}
	if !strings.Contains(log.String(), "power-save on (no-pd)") {
		t.Errorf("not logged: %q", log.String())
	}
	if len(texts) != 1 || !strings.Contains(texts[0], "USB-C to USB-C") || strings.Contains(texts[0], "+60") {
		t.Fatalf("texts %q", texts)
	}
	if got := s.loadPowerSave(); !got.On || len(got.Quit) != 1 {
		t.Fatalf("not saved: %+v", got)
	}
	if fi, err := os.Stat(s.path("power-save.json")); err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("state file mode: %v %v", fi, err)
	}

	f.ps = "  1 /sbin/launchd\n" // the app is gone now
	// Leaves, re-enters within 6 h: the second entry texts nothing.
	p = powerSaveTick(context.Background(), s, f.fx(), phone, good, psT0.Add(time.Minute), &log)
	p = powerSaveTick(context.Background(), s, f.fx(), phone, good, psT0.Add(12*time.Minute), &log)
	if p.On || len(p.Quit) != 0 || len(f.launched) != 1 {
		t.Fatalf("leaving: %+v launched %v", p, f.launched)
	}
	f.ps, f.killed = psRunning, nil
	powerSaveTick(context.Background(), s, f.fx(), phone, bad, psT0.Add(30*time.Minute), &log)
	if len(texts) != 1 {
		t.Errorf("texted again within 6 h: %q", texts)
	}
	// Past 6 h it may text again.
	powerSaveTick(context.Background(), s, f.fx(), phone, good, psT0.Add(31*time.Minute), &log)
	powerSaveTick(context.Background(), s, f.fx(), phone, good, psT0.Add(45*time.Minute), &log)
	powerSaveTick(context.Background(), s, f.fx(), phone, bad, psT0.Add(7*time.Hour), &log)
	if len(texts) != 2 {
		t.Errorf("no text after 6 h: %q", texts)
	}
}

func TestPowerSaveHoldsHeavyWorkWithChargerAdvice(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	cur := calm()
	cur.Batt = psBatt(true, &Adapter{Volts: 5, Amps: 1.5, Watts: 8}, 8, 6)
	if a, _ := guardStep(s, Config{}, cur); strings.Contains(codes(a), "power-save") {
		t.Fatal("power-save finding with the mode off")
	}
	_ = s.savePowerSave(PowerSave{On: true, Since: psT0, Reason: PSNoPD})
	a, g := guardStep(s, Config{}, cur)
	var f *Finding
	for i := range a.Findings {
		if a.Findings[i].Code == "power-save" {
			f = &a.Findings[i]
		}
	}
	if f == nil || f.Level < LevelWatch || !strings.Contains(f.Text, "USB-C to USB-C cable with a fast charger") {
		t.Fatalf("finding %+v", f)
	}
	if !strings.Contains(strings.Join(g.Report.Reasons, ","), "power-save") || g.Report.Admission == "open" {
		t.Errorf("report %+v: power-save must be a reason and hold heavy work", g.Report)
	}
}

func TestPowerSaveSuggestsAdminSettingsNeverRuns(t *testing.T) {
	pm := "Battery Power:\n sleep 1\n displaysleep 10\n powernap 1\n lowpowermode 0\nAC Power:\n displaysleep 10\n powernap 1\n lowpowermode 0\n"
	got := powerSaveSuggestions("darwin", func(string) bool { return false }, pm)
	want := []string{"sudo pmset -b powernap 0", "sudo pmset -b displaysleep 2", "sudo pmset -a lowpowermode 1"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("darwin %v", got)
	}
	// Already set: nothing to suggest. Unreadable: nothing guessed.
	done := "Battery Power:\n displaysleep 2\n powernap 0\n lowpowermode 1\n"
	if got := powerSaveSuggestions("darwin", nil, done); len(got) != 0 {
		t.Errorf("suggested set values: %v", got)
	}
	if got := powerSaveSuggestions("darwin", nil, ""); len(got) != 0 {
		t.Errorf("guessed with no reading: %v", got)
	}
	has := func(p string) bool { return p == "/usr/bin/powerprofilesctl" }
	if got := powerSaveSuggestions("linux", has, ""); len(got) != 1 || got[0] != "powerprofilesctl set power-saver" {
		t.Errorf("linux %v", got)
	}
	if got := powerSaveSuggestions("linux", func(string) bool { return false }, ""); len(got) != 0 {
		t.Errorf("linux without tools %v", got)
	}
	// Shown, never executed: the commands only appear in text, and no suggestion runs through the app fx.
	f := &fakeApps{}
	text := powerSaveStatusText(PowerSave{On: true, Since: psT0, Reason: PSBattery}, psT0, want)
	if !strings.Contains(text, "sudo pmset -b powernap 0") || len(f.cmds) != 0 {
		t.Errorf("status text %q", text)
	}
}

func TestPowerSaveReportStatusAndCLI(t *testing.T) {
	rep := map[string]any{}
	addPowerSave(rep, PowerSave{})
	if m := rep["powerSave"].(map[string]any); m["on"] != false || m["since"] != nil || m["reason"] != nil {
		t.Errorf("off report %v", m)
	}
	addPowerSave(rep, PowerSave{On: true, Since: psT0, Reason: PSNoPD})
	if m := rep["powerSave"].(map[string]any); m["on"] != true || m["since"] != "2026-11-17T12:00:00Z" || m["reason"] != PSNoPD {
		t.Errorf("on report %v", m)
	}
	if powerSaveStatus(PowerSave{}) != "" || powerSaveStatus(PowerSave{On: true, Reason: PSBattery}) != " power-save:battery" {
		t.Error("status suffix")
	}

	s := Store{Dir: t.TempDir()}
	f := &fakeApps{status: "Disconnected", ps: psRunning}
	good := psBatt(true, &Adapter{Volts: 20, Watts: 60}, 60, 20)
	run := func(args ...string) string {
		var out bytes.Buffer
		if err := powerSaveCmd(context.Background(), args, s, f.fx(), good, "linux", psT0, &out); err != nil {
			t.Fatal(err)
		}
		return out.String()
	}
	if out := run(); !strings.Contains(out, "power-save: off") {
		t.Errorf("status: %q", out)
	}
	if out := run("on"); !strings.Contains(out, "on since") || !strings.Contains(out, "manual") || !strings.Contains(out, "Cloudflare WARP") {
		t.Errorf("on: %q", out)
	}
	f.ps = ""
	if out := run("off"); !strings.Contains(out, "power-save: off") || !strings.Contains(out, "forced off") || len(f.launched) != 1 {
		t.Errorf("off: %q launched %v", out, f.launched)
	}
	if out := run("auto"); strings.Contains(out, "forced") {
		t.Errorf("auto: %q", out)
	}
	if err := powerSaveCmd(context.Background(), []string{"bogus"}, s, f.fx(), good, "linux", psT0, &bytes.Buffer{}); err == nil {
		t.Error("bad subcommand accepted")
	}
}
