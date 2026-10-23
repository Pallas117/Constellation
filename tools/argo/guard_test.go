package main

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// ---- parsers ----

func TestParsePmsetBatt(t *testing.T) {
	cases := []struct {
		name, out string
		want      Battery
	}{
		{"charging on AC", "Now drawing from 'AC Power'\n -InternalBattery-0 (id=23855203)\t70%; charging; 1:59 remaining present: true\n",
			Battery{Present: true, Pct: 70, OnAC: true, Charging: true, RemainMin: 119}},
		{"on battery", "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t43%; discharging; 3:05 remaining present: true\n",
			Battery{Present: true, Pct: 43, RemainMin: 185}},
		{"no estimate yet", "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t9%; discharging; (no estimate) present: true\n",
			Battery{Present: true, Pct: 9}},
		{"held at 80% by optimised charging", "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; AC attached; not charging present: true\n",
			Battery{Present: true, Pct: 80, OnAC: true}},
		{"desktop Mac", "Now drawing from 'AC Power'\n", Battery{}},
	}
	for _, c := range cases {
		if got := parsePmsetBatt(c.out); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestBatteryControllerReadings(t *testing.T) {
	if w := parsePmsetAC(" Wattage = 8W\n Current = 1500mA\n Voltage = 5000mV\n"); w != 8 {
		t.Errorf("adapter %v W, want 8", w)
	}
	// Negative currents print as 64-bit unsigned; dictionary entries have no spaces.
	ioreg := `  |   "CycleCount" = 358
  |   "InstantAmperage" = 18446744073709550616
  |   "BatteryData" = {"DesignCapacity"=4382,"NominalChargeCapacity"=2558}
  |   "PowerTelemetryData" = {"SystemLoad"=3908,"SystemPowerIn"=7423}`
	if v, ok := ioregInt(ioreg, "InstantAmperage"); !ok || v != -1000 {
		t.Errorf("amperage %d %v, want -1000", v, ok)
	}
	if v, ok := ioregInt(ioreg, "DesignCapacity"); !ok || v != 4382 {
		t.Errorf("design capacity %d %v", v, ok)
	}
	var b Battery
	applyIoreg(&b, ioreg)
	applyProfiler(&b, "      Health Information:\n          Cycle Count: 358\n          Condition: Service Recommended\n          Maximum Capacity: 71%\n")
	if b.Cycles != 358 || b.SystemW != 3.9 || b.HealthPct != 71 || b.Condition != "Service Recommended" {
		t.Errorf("battery details %+v", b)
	}
}

func TestParseThermAndLoad(t *testing.T) {
	if v := parseTherm("Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\n"); v != 100 {
		t.Errorf("no warning: %d, want 100", v)
	}
	if v := parseTherm("CPU Power notify\n\tCPU_Scheduler_Limit \t= 100\n\tCPU_Available_CPUs \t= 8\n\tCPU_Speed_Limit \t= 70\n"); v != 70 {
		t.Errorf("throttled: %d, want 70", v)
	}
	if v := parseTherm(""); v != 0 {
		t.Errorf("unknown: %d, want 0", v)
	}
	for in, want := range map[string]float64{"{ 1.52 1.61 1.75 }\n": 1.52, "0.52 0.61 0.75 1/234 5678\n": 0.52, "": 0} {
		if got := parseLoad(in); got != want {
			t.Errorf("load %q = %v, want %v", in, got, want)
		}
	}
}

func TestMacMemory(t *testing.T) {
	vm := `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                     4896.
Pages wired down:                              68046.
File-backed pages:                            110939.
Anonymous pages:                              189301.
Pages stored in compressor:                   239744.
Pages occupied by compressor:                 115480.
"Translation faults":                       56642452.
`
	inRAM, demand := macMemory(vm)
	// (68046+189301+115480) pages × 16 KiB = 5.7 GB in RAM; with 239744 logical compressed pages, 7.6 GB.
	if inRAM != 5.7 || demand != 7.6 {
		t.Errorf("in RAM %v, demand %v; want 5.7, 7.6", inRAM, demand)
	}
}

func TestLinuxPressureAndBattery(t *testing.T) {
	psi := "some avg10=0.00 avg60=12.50 avg300=3.10 total=123\nfull avg10=0.00 avg60=1.00 avg300=0.20 total=45\n"
	some, full, ok := parsePSI(psi)
	if !ok || some != 12.5 || full != 1 {
		t.Fatalf("psi %v %v %v", some, full, ok)
	}
	for _, c := range []struct {
		some, full float64
		want       string
	}{{0, 0, "normal"}, {12.5, 1, "warn"}, {45, 0, "critical"}, {20, 10, "critical"}} {
		if got := psiPressure(c.some, c.full); got != c.want {
			t.Errorf("psi %v/%v = %s, want %s", c.some, c.full, got, c.want)
		}
	}
	if worse("normal", "warn") != "warn" || worse("critical", "warn") != "critical" || worse("", "normal") != "normal" {
		t.Error("worse ranks pressure words wrongly")
	}

	root := t.TempDir()
	write := func(dev, k, v string) {
		_ = os.MkdirAll(filepath.Join(root, dev), 0o755)
		_ = os.WriteFile(filepath.Join(root, dev, k), []byte(v+"\n"), 0o644)
	}
	write("AC", "type", "Mains")
	write("AC", "online", "0")
	write("BAT0", "type", "Battery")
	write("BAT0", "present", "1")
	write("BAT0", "capacity", "37")
	write("BAT0", "status", "Discharging")
	write("BAT0", "cycle_count", "412")
	write("BAT0", "energy_full", "41000000")
	write("BAT0", "energy_full_design", "50000000")
	write("hidpp_battery_0", "type", "Battery") // a wireless mouse
	write("hidpp_battery_0", "scope", "Device")
	write("hidpp_battery_0", "capacity", "5")
	b := linuxBattery(readSupplies(root))
	if want := (Battery{Present: true, Pct: 37, Cycles: 412, HealthPct: 82}); b != want {
		t.Errorf("laptop battery %+v, want %+v", b, want)
	}
	write("AC", "online", "1")
	if b := linuxBattery(readSupplies(root)); !b.OnAC {
		t.Error("mains online should count as AC")
	}
	if b := linuxBattery(map[string]map[string]string{"AC": {"type": "Mains", "online": "1"}}); b.Present {
		t.Error("a server with mains only has no battery")
	}
}

func TestMemoryGroups(t *testing.T) {
	ps := ` 415648 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)
 333760 /Users/x/Library/Application Support/Claude/claude-code/2.1.308/a93/claude.app/Contents/MacOS/claude
 261648 /opt/homebrew/bin/node
 2097152 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
 190048 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.WebContent.xpc/Contents/MacOS/com.apple.WebKit.WebContent
 52944 /usr/libexec/logd
 12000 chrome
bogus line
`
	gs := parsePSGroups(ps)
	got := map[string]float64{}
	for _, g := range gs {
		got[g.Name] = g.GB
	}
	if got["browser"] != 2.2 || got["claude app"] != 0.4 || got["claude code"] != 0.3 || got["dev tools"] != 0.2 {
		t.Errorf("groups %v", gs)
	}
	if gs[0].Name != "browser" {
		t.Errorf("biggest first: %v", gs)
	}
	if s := topGroups(gs, 2); s != "browser 2.2 GB, claude app 0.4 GB" {
		t.Errorf("top groups %q", s)
	}
	if gb := groupRSSGB("  501 1048576\n  501 524288\n  777 999999\n", 501); gb != 1.5 {
		t.Errorf("job RSS %v GB, want 1.5", gb)
	}
}

// ---- risk model ----

var t0 = time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC)

func calm() Sample {
	return Sample{At: t0, Pressure: "normal", RAMGB: 32, InRAMGB: 10, SwapGB: 0, DiskGB: 200, Load1: 2, CPUs: 10, SpeedPct: 100}
}

func codes(a Assessment) string {
	var c []string
	for _, f := range a.Findings {
		c = append(c, f.Code)
	}
	return strings.Join(c, ",")
}

func TestAssessLevels(t *testing.T) {
	battery := func(pct int, ac bool) *Battery { return &Battery{Present: true, Pct: pct, OnAC: ac} }
	cases := []struct {
		name  string
		edit  func(*Sample)
		level Level
		code  string
	}{
		{"healthy", func(*Sample) {}, LevelOK, ""},
		{"pressure critical", func(s *Sample) { s.Pressure = "critical" }, LevelBlock, "mem-critical"},
		{"pressure warn, just started", func(s *Sample) { s.Pressure = "warn" }, LevelWatch, "mem-warn"},
		{"pressure unknown", func(s *Sample) { s.Pressure = "" }, LevelWatch, "pressure-unknown"},
		{"swap at the balance limit", func(s *Sample) { s.SwapGB = 4.2 }, LevelRisk, "swap-high"},
		{"no headroom is information, not risk", func(s *Sample) { s.RAMGB, s.InRAMGB = 8, 7.5 }, LevelOK, "no-headroom"},
		{"battery at the floor", func(s *Sample) { s.Batt = battery(9, false) }, LevelBlock, "battery-floor"},
		{"battery low", func(s *Sample) { s.Batt = battery(18, false) }, LevelRisk, "battery-low"},
		{"battery fine but on battery", func(s *Sample) { s.Batt = battery(80, false) }, LevelWatch, "on-battery"},
		{"low battery with memory warn", func(s *Sample) { s.Batt, s.Pressure = battery(24, false), "warn" }, LevelRisk, "battery-low-pressure"},
		{"OS estimate says under an hour to the floor", func(s *Sample) { b := battery(30, false); b.RemainMin = 60; s.Batt = b }, LevelRisk, "battery-draining"},
		{"on AC, 8 W charger, 12 W draw", func(s *Sample) { b := battery(70, true); b.AdapterW, b.SystemW = 8, 12; s.Batt = b }, LevelWatch, "charger-weak"},
		{"plugged in, no battery figures", func(s *Sample) { s.Batt = battery(100, true) }, LevelOK, ""},
		{"disk nearly full", func(s *Sample) { s.DiskGB = 2 }, LevelBlock, "disk-critical"},
		{"disk low", func(s *Sample) { s.DiskGB = 6 }, LevelRisk, "disk-low"},
		{"disk tight", func(s *Sample) { s.DiskGB = 15 }, LevelWatch, "disk-tight"},
		{"throttled", func(s *Sample) { s.SpeedPct = 60 }, LevelRisk, "cpu-throttled"},
		{"run queue twice the cores", func(s *Sample) { s.Load1 = 21 }, LevelRisk, "cpu-saturated"},
		{"busy", func(s *Sample) { s.Load1 = 11 }, LevelWatch, "cpu-busy"},
	}
	for _, c := range cases {
		s := calm()
		c.edit(&s)
		a := assess(nil, s)
		if a.Level != c.level || !strings.Contains(codes(a), c.code) {
			t.Errorf("%s: %s [%s], want %s with %q", c.name, a.Level, codes(a), c.level, c.code)
		}
	}
}

func TestAssessTrends(t *testing.T) {
	// 40 min at warn with swap climbing from 2.0 to 3.2 GB, one reading a minute.
	var hist []Sample
	for i := 40; i > 0; i-- {
		s := calm()
		s.At, s.Pressure, s.SwapGB = t0.Add(-time.Duration(i)*time.Minute), "warn", 3.2-float64(i)*0.03
		hist = append(hist, s)
	}
	cur := calm()
	cur.Pressure, cur.SwapGB = "warn", 3.2
	a := assess(hist, cur)
	if a.Level != LevelRisk || !strings.Contains(codes(a), "mem-warn-sustained") || !strings.Contains(codes(a), "swap-rising") {
		t.Errorf("sustained warn: %s [%s] warn %d min swap +%v", a.Level, codes(a), a.WarnMin, a.SwapRiseGB)
	}
	if a.WarnMin != 40 || a.SwapRiseGB != 1.2 {
		t.Errorf("warn %d min, swap +%v GB; want 40, 1.2", a.WarnMin, a.SwapRiseGB)
	}

	// A 20 min gap (lid shut, Argo off) is not time at warn.
	gap := []Sample{hist[0]}
	gap[0].At = t0.Add(-20 * time.Minute)
	if a := assess(gap, cur); a.WarnMin != 0 {
		t.Errorf("a gap counted as %d min at warn", a.WarnMin)
	}

	// On battery, 60% to 50% in 20 min: 30%/h, so 80 min to the 10% floor.
	var drainHist []Sample
	for i := 0; i <= 20; i += 5 {
		s := calm()
		s.At, s.Batt = t0.Add(-time.Duration(20-i)*time.Minute), &Battery{Present: true, Pct: 60 - i/2}
		drainHist = append(drainHist, s)
	}
	cur = calm()
	cur.Batt = &Battery{Present: true, Pct: 50}
	a = assess(drainHist[:len(drainHist)-1], cur)
	if a.DrainPctH != 30 || a.MinToFloor != 80 || a.Level != LevelWatch {
		t.Errorf("drain %v%%/h, %d min to floor, %s; want 30, 80, watch", a.DrainPctH, a.MinToFloor, a.Level)
	}

	// Plugged in but still losing charge: the charger can't keep up.
	for i := range drainHist {
		drainHist[i].Batt.OnAC = true
	}
	cur.Batt = &Battery{Present: true, Pct: 50, OnAC: true}
	if a := assess(drainHist[:len(drainHist)-1], cur); !a.ChargerBehind || a.Level != LevelRisk {
		t.Errorf("charger behind: %+v", a)
	}
}

// ---- autoscaler ----

func TestAutoscaleHysteresis(t *testing.T) {
	cur := calm() // 32 GB, 10 in RAM, 1.5 reserve: 20.5 GB free → 10 slots of 2 GB, capped at 9 by cores
	a := assess(nil, cur)
	target := targetSlots(cur, a, 2)
	if target != 9 {
		t.Fatalf("target %d, want 9", target)
	}
	var sc Scale
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	sc = autoscale(sc, a, target, at(0))
	if sc.Slots != 0 || sc.Admission != "open" {
		t.Fatalf("a new host takes no work at once: %+v", sc)
	}
	for m := 1; m < 10; m++ {
		sc = autoscale(sc, a, target, at(m))
	}
	if sc.Slots != 0 {
		t.Fatalf("scaled up before the 10 min cool-down: %+v", sc)
	}
	sc = autoscale(sc, a, target, at(10))
	if sc.Slots != 1 {
		t.Fatalf("after 10 calm min: %d slots, want 1", sc.Slots)
	}
	for m := 11; m < 15; m++ {
		sc = autoscale(sc, a, target, at(m))
	}
	if sc.Slots != 1 {
		t.Fatalf("added a slot before the 5 min step: %d", sc.Slots)
	}
	sc = autoscale(sc, a, target, at(15))
	if sc.Slots != 2 {
		t.Fatalf("at 15 min: %d slots, want 2", sc.Slots)
	}

	// Watch caps at one slot at once; risk drops to zero at once and restarts the cool-down.
	w := cur
	w.Batt = &Battery{Present: true, Pct: 80}
	aw := assess(nil, w)
	sc = autoscale(sc, aw, targetSlots(w, aw, 2), at(16))
	if sc.Slots != 1 || sc.Admission != "limited" {
		t.Fatalf("on battery: %+v", sc)
	}
	r := cur
	r.SwapGB = 5
	ar := assess(nil, r)
	sc = autoscale(sc, ar, targetSlots(r, ar, 2), at(17))
	if sc.Slots != 0 || sc.Admission != "closed" || !sc.CalmSince.IsZero() {
		t.Fatalf("at risk: %+v", sc)
	}
	sc = autoscale(sc, a, target, at(18))
	sc = autoscale(sc, a, target, at(25))
	if sc.Slots != 0 {
		t.Fatalf("scaled up 7 min after risk: %+v", sc)
	}
	sc = autoscale(sc, a, target, at(28))
	if sc.Slots != 1 {
		t.Fatalf("10 min after risk cleared: %+v", sc)
	}

	// An 8 GB laptop with nothing spare is healthy but full.
	small := calm()
	small.RAMGB, small.InRAMGB, small.CPUs = 8, 7, 8
	as := assess(nil, small)
	if sc := autoscale(Scale{}, as, targetSlots(small, as, 2), t0); sc.Admission != "full" {
		t.Errorf("8 GB host with 0.0 GB free: %+v", sc)
	}
}

func TestAdmit(t *testing.T) {
	ok := assess(nil, calm())
	if yes, why := admit(ok, 4); !yes {
		t.Errorf("healthy host refused 4 GB: %s", why)
	}
	if yes, _ := admit(ok, 30); yes {
		t.Error("admitted 30 GB with 20.5 GB free")
	}
	w := calm()
	w.Batt = &Battery{Present: true, Pct: 80}
	watch := assess(nil, w)
	if yes, _ := admit(watch, 1); !yes {
		t.Error("watch should still admit light work")
	}
	if yes, why := admit(watch, 2); yes || !strings.Contains(why, "light work only") {
		t.Errorf("watch admitted 2 GB: %s", why)
	}
	r := calm()
	r.Pressure = "critical"
	if yes, why := admit(assess(nil, r), 0); yes || !strings.Contains(why, "block") {
		t.Errorf("critical host admitted a job: %s", why)
	}
}

// ---- GAU-165 replay ----

// TestGAU165Replay drives the recorded evening before the 2026-10-21 hard
// reset through the guard. Done-when from GAU-165: a sustained-warn alert by
// about 21:35, and before swap crossed 5 GB.
func TestGAU165Replay(t *testing.T) {
	f, err := os.Open("testdata/gau165-replay.tsv")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	myt := time.FixedZone("MYT", 8*3600)
	store, cfg := Store{Dir: t.TempDir()}, Config{}
	first := map[string]time.Time{}
	var over5, firstRow time.Time
	var firstAdmission string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "#") {
			continue
		}
		col := strings.Split(sc.Text(), "\t")
		at, err := time.ParseInLocation("2006-01-02 15:04:05", col[0], myt)
		if err != nil {
			t.Fatal(err)
		}
		lvl, _ := strconv.Atoi(col[1])
		swap, _ := strconv.ParseFloat(col[2], 64)
		ram, _ := strconv.ParseFloat(col[3], 64)
		disk, _ := strconv.ParseFloat(col[4], 64)
		cur := Sample{At: at, Pressure: pressureName(lvl), SwapGB: swap, RAMGB: ram, InRAMGB: ram, DiskGB: disk, CPUs: 8, Load1: 2}
		a, g := guardStep(store, cfg, cur)
		if firstRow.IsZero() {
			firstRow, firstAdmission = at, g.Scale.Admission
		}
		for _, al := range guardAlerts(a, cur, func() []Group { return nil }) {
			if first[al.key].IsZero() {
				first[al.key] = at
			}
		}
		if swap > 5 && over5.IsZero() {
			over5 = at
		}
	}
	if firstAdmission != "closed" {
		t.Errorf("swap was already 4.2 GB at %s: admission %q, want closed", firstRow.Format("15:04"), firstAdmission)
	}
	mem := first["guard-memory"]
	if got := mem.Format("15:04"); got != "21:35" {
		t.Errorf("sustained-warn alert at %s, want 21:35", got)
	}
	if !mem.Before(over5) {
		t.Errorf("alert %s is not before swap crossed 5 GB at %s", mem.Format("15:04"), over5.Format("15:04"))
	}
	if got := first["guard-swap"].Format("15:04"); got != "22:36" {
		t.Errorf("swap-climbing alert at %s, want 22:36 (3.9 to 5.0 GB within the hour)", got)
	}
	if hist := store.guardHistory(); len(hist) != 20 {
		t.Errorf("history kept %d readings, want 20", len(hist))
	}
}

func TestGuardAlertsOnlyForGaps(t *testing.T) {
	s := calm()
	s.Pressure = "critical" // gauss-services.sh already texts critical pressure
	if al := guardAlerts(assess(nil, s), s, func() []Group { t.Error("listed memory users without a memory alert"); return nil }); len(al) != 0 {
		t.Errorf("duplicated an existing alert: %+v", al)
	}
	s = calm()
	s.Pressure, s.Batt = "warn", &Battery{Present: true, Pct: 22}
	al := guardAlerts(assess(nil, s), s, func() []Group { return nil })
	if len(al) != 1 || al[0].key != "guard-battery-memory" || !strings.Contains(al[0].msg, "Battery 22%") {
		t.Errorf("battery + memory alert: %+v", al)
	}
	if len([]rune(al[0].msg)) > maxNotifyLen {
		t.Error("alert longer than a phone text should be")
	}
}

// ---- history, report, Gauss block ----

func TestGuardHistoryTrim(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	var hist []Sample
	for i := 0; i <= 2*24*60; i++ { // two days, one a minute
		x := calm()
		x.At = t0.Add(time.Duration(i-2*24*60) * time.Minute)
		hist = append(hist, x)
	}
	if err := s.appendGuard(calm(), hist); err != nil {
		t.Fatal(err)
	}
	got := s.guardHistory()
	if len(got) < 24*60 || len(got) > 24*60+2 {
		t.Errorf("kept %d readings, want about a day (1440)", len(got))
	}
	if fi, _ := os.Stat(s.path("guard.jsonl")); fi.Mode().Perm() != 0o600 {
		t.Errorf("history mode %v, want 0600", fi.Mode().Perm())
	}
}

func TestGuardReportForGauss(t *testing.T) {
	s := calm()
	s.SwapGB, s.DiskGB, s.Load1 = 5, 6, 30
	s.Batt = &Battery{Present: true, Pct: 15}
	a := assess(nil, s)
	sc := autoscale(Scale{}, a, targetSlots(s, a, 2), s.At)
	r := guardReport(a, sc, s.At)
	if r.Level != "risk" || r.Admission != "closed" || r.Slots != 0 || len(r.Reasons) == 0 || len(r.Reasons) > 6 {
		t.Errorf("report %+v", r)
	}
	g := GuardState{Report: r, Batt: s.Batt}
	m := map[string]any{}
	addGuard(m, g, s.At.Add(time.Minute))
	if m["guard"] == nil || m["battery"].(map[string]any)["level"] != 15 {
		t.Errorf("fresh guard not added: %v", m)
	}
	m = map[string]any{}
	addGuard(m, g, s.At.Add(11*time.Minute))
	if len(m) != 0 {
		t.Errorf("stale guard sent: %v", m)
	}
	if guardStatus(g, s.At) != " guard:risk" || guardStatus(GuardState{}, s.At) != "" {
		t.Error("status suffix")
	}
}

func TestGuardText(t *testing.T) {
	s := calm()
	s.Batt = &Battery{Present: true, Pct: 72, OnAC: true, Charging: true, AdapterW: 8, SystemW: 12, Cycles: 358, HealthPct: 71, Condition: "Service Recommended"}
	s.DemandGB = 14
	a := assess([]Sample{calm()}, s)
	out := guardText(s, a, Scale{Admission: "limited", Slots: 1}, []Sample{calm(), s}, []Group{{"browser", 2.2}})
	for _, want := range []string{"WATCH", "adapter 8 W", "machine draws 12.0 W", "71% of its design capacity (Service Recommended)",
		"charger-weak", "browser 2.2 GB", "stronger charger"} {
		if !strings.Contains(out, want) && !strings.Contains(codes(a), want) {
			t.Errorf("report lacks %q:\n%s", want, out)
		}
	}
}

// ---- guarded run ----

func fakeRunner(t *testing.T, levels ...Assessment) guardRunner {
	i := 0
	return guardRunner{
		store: Store{Dir: filepath.Join(t.TempDir(), "not-yet-created")}, out: io.Discard, every: 20 * time.Millisecond, retry: 10 * time.Millisecond,
		grace: 2 * time.Second, strikes: 2,
		assess: func() (Sample, Assessment) {
			a := levels[min(i, len(levels)-1)]
			i++
			return calm(), a
		},
		jobGB: func(int) float64 { return 0.1 },
	}
}

func TestGuardRun(t *testing.T) {
	ok := assess(nil, calm())
	crit := calm()
	crit.Pressure = "critical"
	block := assess(nil, crit)

	// Healthy: the command's own exit code comes back.
	if code, err := fakeRunner(t, ok).run(0, 0, 0, []string{"sh", "-c", "exit 3"}); err != nil || code != 3 {
		t.Errorf("exit code %d %v, want 3", code, err)
	}

	// Refused: never started.
	marker := filepath.Join(t.TempDir(), "ran")
	if code, _ := fakeRunner(t, block).run(0, 0, 0, []string{"touch", marker}); code != exitTempFail {
		t.Errorf("refused job exit %d, want 75", code)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Error("a refused job ran")
	}

	// The host reaches block mid-run: the whole process group is stopped.
	start := time.Now()
	r := fakeRunner(t, ok, ok, block)
	if code, _ := r.run(0, 0, 0, []string{"sh", "-c", "sleep 30 & sleep 30; wait"}); code != exitTempFail {
		t.Errorf("stopped job exit %d, want 75", code)
	}
	if time.Since(start) > 5*time.Second {
		t.Errorf("stopping took %s", time.Since(start))
	}
	if log, _ := os.ReadFile(r.store.path("guard.log")); !strings.Contains(string(log), "sh stopped: host at block") {
		t.Errorf("guard.log: %q", log)
	}

	// The job outgrows its cap.
	r = fakeRunner(t, ok)
	r.jobGB = func(int) float64 { return 3 }
	if code, _ := r.run(0, 2, 0, []string{"sleep", "30"}); code != exitTempFail {
		t.Errorf("over-cap job exit %d, want 75", code)
	}

	// One bad reading is a blip, not a stop.
	r = fakeRunner(t, ok, block, ok)
	if code, _ := r.run(0, 0, 0, []string{"sh", "-c", "sleep 0.2"}); code != 0 {
		t.Errorf("a single blip stopped the job (exit %d)", code)
	}

	// Waiting: refused at first, admitted once the host recovers.
	if yes, why := fakeRunner(t, block, block, ok).waitAdmit(0, time.Second); !yes {
		t.Errorf("waitAdmit gave up: %s", why)
	}
}
