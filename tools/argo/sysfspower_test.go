package main

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The fixtures under testdata/power_supply imitate /sys/class/power_supply (hand-written, not
// recorded from a laptop: see the README there). They run on every OS, so the Linux reading is
// tested on the Mac too; a real Linux host is still UNVERIFIED.

func sysfsBattery(t *testing.T, name string) Battery {
	t.Helper()
	s := readSupplies(filepath.Join("testdata", "power_supply", name))
	if len(s) == 0 {
		t.Fatalf("fixture %s is missing", name)
	}
	return linuxBattery(s)
}

func TestLinuxBatteryDrainOnChargerAndChargeLimit(t *testing.T) {
	for _, c := range []struct {
		name string
		want Battery
	}{
		{"weak-charger", Battery{Present: true, Pct: 41, OnAC: true, Cycles: 310, HealthPct: 76, DrainOnAC: true, DrainW: 12.3}},
		{"charge-limit", Battery{Present: true, Pct: 80, OnAC: true, HealthPct: 90, ChargeLimitPct: 80}},
		{"on-battery", Battery{Present: true, Pct: 62, DrainW: 9, ChargeLimitPct: 100}},
		{"idle-at-full", Battery{Present: true, Pct: 100, OnAC: true}}, // "Discharging" with a zero rate is not a drain
		{"current-only", Battery{Present: true, Pct: 55, OnAC: true, HealthPct: 80, DrainOnAC: true, DrainW: 11.4}},
		{"no-rate", Battery{Present: true, Pct: 47, OnAC: true, DrainOnAC: true}}, // the kernel's word alone; watts unknown
	} {
		if got := sysfsBattery(t, c.name); got != c.want {
			t.Errorf("%s:\n got %+v\nwant %+v", c.name, got, c.want)
		}
	}
	// Out-of-range limits are ignored, never trusted.
	for _, v := range []string{"0", "101", "-5", "80%", ""} {
		b := linuxBattery(map[string]map[string]string{"BAT0": {"type": "Battery", "capacity": "50", "charge_control_end_threshold": v}})
		if b.ChargeLimitPct != 0 {
			t.Errorf("limit %q read as %d", v, b.ChargeLimitPct)
		}
	}
	// An absurd rate (over 500 W) is a bad reading, not a figure to print.
	b := linuxBattery(map[string]map[string]string{"AC": {"type": "Mains", "online": "1"},
		"BAT0": {"type": "Battery", "capacity": "50", "status": "Discharging", "power_now": "900000000000"}})
	if !b.DrainOnAC || b.DrainW != 0 {
		t.Errorf("absurd rate: %+v", b)
	}
}

func TestAssessDrainOnCharger(t *testing.T) {
	at := func(name string, pct int) Assessment {
		s := calm()
		b := sysfsBattery(t, name)
		if pct > 0 {
			b.Pct = pct
		}
		s.Batt = &b
		return assess(nil, s)
	}
	for _, c := range []struct {
		name  string
		pct   int
		level Level
		code  string
	}{
		{"weak-charger", 0, LevelWatch, "charger-weak"},               // 41%: light work, RAM not capped
		{"weak-charger", shedPct, LevelRisk, "charger-weak"},          // running jobs are shed here, so none start
		{"weak-charger", batteryFloorPct, LevelBlock, "charger-weak"}, // the floor
		{"charge-limit", 0, LevelOK, ""},                              // held at its limit: not a weak charger
		{"idle-at-full", 0, LevelOK, ""},
		{"on-battery", 0, LevelWatch, "on-battery"}, // unchanged: eclipse rules
	} {
		a := at(c.name, c.pct)
		if a.Level != c.level || codes(a) != c.code {
			t.Errorf("%s at %d%%: level %s codes %q, want %s %q", c.name, c.pct, a.Level, codes(a), c.level, c.code)
		}
	}
	a := at("weak-charger", 0)
	if txt := a.Findings[0].Text; !strings.Contains(txt, "plugged in") || !strings.Contains(txt, "12.3 W") {
		t.Errorf("finding text %q", txt)
	}
	if watchLimitsRAM(a) {
		t.Error("a weak charger at watch must not cap RAM (as charger-weak on macOS)")
	}
	if a := at("no-rate", 0); !strings.Contains(a.Findings[0].Text, "plugged in") || strings.Contains(a.Findings[0].Text, " W") {
		t.Errorf("no rate must print no watts: %q", a.Findings[0].Text)
	}
	// The measured drain (charger-behind) still wins when history shows one: one finding, not two.
	s := calm()
	b := sysfsBattery(t, "weak-charger")
	s.Batt = &b
	old := s
	old.At = s.At.Add(-20 * time.Minute)
	ob := b
	ob.Pct = b.Pct + 10
	old.Batt = &ob
	if a := assess([]Sample{old}, s); codes(a) != "charger-behind" {
		t.Errorf("measured drain should be the only charger finding: %q", codes(a))
	}
}

func TestBrownoutLeavesAChargeLimitAlone(t *testing.T) {
	s := calm()
	b := sysfsBattery(t, "charge-limit")
	s.Batt = &b
	if brownout(s, assess(nil, s), false) {
		t.Error("a battery held at its 80% limit must not shed jobs")
	}
	w := sysfsBattery(t, "weak-charger")
	w.Pct = shedPct
	s.Batt = &w
	if !brownout(s, assess(nil, s), false) {
		t.Error("discharging on a charger at the shed level must shed (existing rule)")
	}
}

func TestBatteryNoteAndStatus(t *testing.T) {
	weak := sysfsBattery(t, "weak-charger")
	limit := sysfsBattery(t, "charge-limit")
	onBatt := sysfsBattery(t, "on-battery")
	norate := sysfsBattery(t, "no-rate")
	for _, c := range []struct {
		name string
		b    *Battery
		want string
	}{
		{"weak", &weak, "plugged in but the battery is still draining (12.3 W): use a stronger charger"},
		{"no rate", &norate, "plugged in but the battery is still draining: use a stronger charger"},
		{"held", &limit, "held at its 80% charge limit"},
		{"limit not reached", &Battery{Present: true, Pct: 60, OnAC: true, Charging: true, ChargeLimitPct: 80}, ""},
		{"on battery", &onBatt, ""},
		{"no battery", nil, ""},
	} {
		if got := batteryNote(c.b); got != c.want {
			t.Errorf("note %s: %q, want %q", c.name, got, c.want)
		}
	}
	for _, c := range []struct {
		name string
		b    *Battery
		goos string
		want string
	}{
		{"set", &limit, "linux", "charges to 80% (charge limit)"},
		{"file at 100", &onBatt, "linux", "no charge limit set (this laptop offers one)"},
		{"no file on Linux", &Battery{Present: true, Pct: 60}, "linux", "this laptop offers no charge limit Argo can read"},
		{"macOS says nothing", &Battery{Present: true, Pct: 60}, "darwin", ""},
		{"no battery", nil, "linux", ""},
	} {
		if got := chargeLimitText(c.b, c.goos); got != c.want {
			t.Errorf("limit %s: %q, want %q", c.name, got, c.want)
		}
	}

	g := GuardState{Batt: &weak}
	g.Report.At, g.Report.Level = t0, "watch"
	if got := guardStatus(g, t0); got != " guard:watch (plugged in but the battery is still draining (12.3 W): use a stronger charger)" {
		t.Errorf("status %q", got)
	}
	g.Batt, g.Report.Level = &limit, "ok"
	if got := guardStatus(g, t0); got != " (held at its 80% charge limit)" {
		t.Errorf("status %q", got)
	}
	// Nothing new goes to Gauss: the battery block keeps its allowlisted keys.
	rep := map[string]any{}
	g.Batt = &weak
	addGuard(rep, g, t0)
	bat, _ := rep["battery"].(map[string]any)
	for k := range bat {
		switch k {
		case "level", "charging", "external", "lowPower", "power", "charger":
		default:
			t.Errorf("unexpected report field battery.%s", k)
		}
	}

	s := calm()
	s.Batt = &weak
	if txt := guardText(s, assess(nil, s), Scale{}, nil, nil); !strings.Contains(txt, "plugged in but the battery is still draining (12.3 W)") {
		t.Errorf("argo guard should say it:\n%s", txt)
	}
}
