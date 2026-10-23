package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The resource guard (GAU-195): measure memory, battery, disk and CPU on this
// host, keep a short local history, rate each resource ok/watch/risk/block,
// and turn that into an admission decision and a slot count for mesh work.
// Only the decision and coarse numbers leave the device; process names and
// the history stay here.

// Level orders how risky it is to start or keep running work on this host.
type Level int

const (
	LevelOK    Level = iota // take work
	LevelWatch              // light work only
	LevelRisk               // no new work; running work continues
	LevelBlock              // no work: guarded jobs are stopped
)

func (l Level) String() string {
	return [...]string{"ok", "watch", "risk", "block"}[l]
}

// Thresholds. Shared with scripts/ops/gauss-services.sh so the guard, balance
// and the awake guard agree, and with GAU-165 for the trend alerts.
const (
	batteryFloorPct = 10  // GAUSS_AWAKE_MIN_BATTERY: the mesh's critical-battery level
	batteryWarnPct  = 20  // GAUSS_AWAKE_WARN_BATTERY
	batteryPairPct  = 25  // GAU-165: low battery plus memory warn was the crash combination
	swapMaxGB       = 4.0 // GAUSS_SWAP_MAX_GB: balance sheds load from here
	diskMinGB       = 8.0 // GAUSS_DISK_MIN_GB
	// macOS keeps swap files on the boot volume; running it out of space ends
	// in a kernel panic ("low swap space"), so below this nothing may run.
	diskBlockGB   = 3.0
	diskWatchGB   = 20.0 // Gauss's "agents" verdict wants 20 GB free
	reserveGB     = 1.5  // mem-guard HEADROOM: file cache and free pages the OS needs
	sustainedWarn = 30 * time.Minute
	swapRiseGB    = 1.0 // GAU-165: +1 GB of swap within 60 min while at warn
	swapRiseOver  = 60 * time.Minute
	minToFloor    = 60 // minutes of battery left before the floor that still count as safe
	historyGap    = 15 * time.Minute
)

// Battery is one battery reading. Watts are positive into the battery.
type Battery struct {
	Present   bool    `json:"present"`
	Pct       int     `json:"pct"`
	OnAC      bool    `json:"ac"`
	Charging  bool    `json:"charging"`
	RemainMin int     `json:"remain,omitempty"`   // the OS estimate to empty (on battery) or full; 0 unknown
	AdapterW  float64 `json:"adapterW,omitempty"` // the charger's rating
	SystemW   float64 `json:"systemW,omitempty"`  // what the whole machine draws, when the controller reports it
	Cycles    int     `json:"cycles,omitempty"`
	HealthPct int     `json:"health,omitempty"`    // the OS's "maximum capacity" vs design
	Condition string  `json:"condition,omitempty"` // the OS's own words, e.g. "Normal", "Service Recommended"
	LowPower  bool    `json:"lowPower,omitempty"`
}

// Sample is one reading of the host. It is what the history keeps.
type Sample struct {
	At        time.Time `json:"at"`
	Pressure  string    `json:"p"`             // normal | warn | critical | "" unknown
	RAMGB     float64   `json:"ram"`           // installed
	InRAMGB   float64   `json:"inram"`         // held by work in RAM: wired + apps + the compressor's own pages
	DemandGB  float64   `json:"dem,omitempty"` // what work would hold uncompressed (macOS), for "how much RAM do I need"
	SwapGB    float64   `json:"swap"`
	DiskGB    float64   `json:"disk"`
	Load1     float64   `json:"load"`
	CPUs      int       `json:"cpus"`
	SpeedPct  int       `json:"speed,omitempty"` // the OS's CPU speed limit (100 = not throttled, 0 unknown)
	Batt      *Battery  `json:"bat,omitempty"`
	SwappedPc int       `json:"swapped,omitempty"` // share of compressed memory already pushed to disk (macOS)
}

// Finding is one reason behind a level.
type Finding struct {
	Resource string `json:"resource"` // memory | battery | disk | cpu
	Code     string `json:"code"`     // short, allowlisted on the Gauss side
	Level    Level  `json:"level"`
	Text     string `json:"text"`
}

// Assessment is the guard's verdict on one sample plus its history.
type Assessment struct {
	Level         Level     `json:"level"`
	Findings      []Finding `json:"findings"`
	HeadroomGB    float64   `json:"headroomGB"` // RAM left for new work after the reserve
	WarnMin       int       `json:"warnMin"`    // minutes of the last hour memory spent at warn or worse
	SwapRiseGB    float64   `json:"swapRiseGB"` // swap growth over the last hour
	DrainPctH     float64   `json:"drainPctH"`  // battery points lost per hour on battery (or on a charger that can't keep up)
	MinToFloor    int       `json:"minToFloor"` // minutes until the battery floor at the current drain; -1 unknown
	ChargerBehind bool      `json:"chargerBehind"`
}

func (a *Assessment) add(res, code string, l Level, format string, args ...any) {
	a.Findings = append(a.Findings, Finding{Resource: res, Code: code, Level: l, Text: fmt.Sprintf(format, args...)})
	if l > a.Level {
		a.Level = l
	}
}

// recent returns the history samples within d before now, oldest first.
func recent(hist []Sample, now time.Time, d time.Duration) []Sample {
	var out []Sample
	for _, s := range hist {
		if !s.At.After(now) && now.Sub(s.At) <= d {
			out = append(out, s)
		}
	}
	return out
}

func atWarn(p string) bool { return p == "warn" || p == "critical" }

// warnWithin is how much of the last window memory spent at warn or worse:
// each reading at warn counts until the next reading. Pressure flaps (warn,
// normal for a few minutes, warn again), so a strictly continuous run misses
// the evening GAU-165 replays: 30 of 60 min alerts at 21:35, continuous only
// at 22:36. A gap over historyGap (asleep, Argo off) counts as unknown, not warn.
func warnWithin(hist []Sample, cur Sample, window time.Duration) time.Duration {
	pts := append(recent(hist, cur.At, window), cur)
	var d time.Duration
	for i := 0; i+1 < len(pts); i++ {
		gap := pts[i+1].At.Sub(pts[i].At)
		if gap > 0 && gap <= historyGap && atWarn(pts[i].Pressure) {
			d += gap
		}
	}
	return d
}

// swapRise is the swap growth from the lowest point in the last hour to now.
func swapRise(hist []Sample, cur Sample) float64 {
	lo := cur.SwapGB
	for _, s := range recent(hist, cur.At, swapRiseOver) {
		lo = math.Min(lo, s.SwapGB)
	}
	return round1(cur.SwapGB - lo)
}

// drain is battery points lost per hour over the last 30 min of readings with
// the same power source as now. On battery that is the discharge rate; on AC
// a positive drain means the charger can't keep up.
func drain(hist []Sample, cur Sample) float64 {
	if cur.Batt == nil || !cur.Batt.Present {
		return 0
	}
	var first *Sample
	for _, s := range recent(hist, cur.At, 30*time.Minute) {
		if s.Batt != nil && s.Batt.OnAC == cur.Batt.OnAC {
			s := s
			first = &s
			break
		}
	}
	if first == nil || cur.At.Sub(first.At) < 10*time.Minute {
		return 0
	}
	return round1(float64(first.Batt.Pct-cur.Batt.Pct) / cur.At.Sub(first.At).Hours())
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }

// assess rates the current sample in the light of its history.
func assess(hist []Sample, cur Sample) Assessment {
	a := Assessment{MinToFloor: -1}
	a.HeadroomGB = round1(math.Max(0, cur.RAMGB-cur.InRAMGB-reserveGB))
	a.WarnMin = int(warnWithin(hist, cur, time.Hour).Minutes())
	a.SwapRiseGB = swapRise(hist, cur)

	// Memory: the kernel's own level first, then how long and how fast.
	switch {
	case cur.Pressure == "critical":
		a.add("memory", "mem-critical", LevelBlock, "memory pressure is critical: the OS is compressing, swapping and killing apps")
	case a.WarnMin >= int(sustainedWarn.Minutes()):
		a.add("memory", "mem-warn-sustained", LevelRisk, "memory was at warn for %d of the last 60 min (alert at 30)", a.WarnMin)
	case cur.Pressure == "warn":
		a.add("memory", "mem-warn", LevelWatch, "memory pressure is at warn (%d of the last 60 min)", a.WarnMin)
	case cur.Pressure == "":
		a.add("memory", "pressure-unknown", LevelWatch, "memory pressure is unknown on this host")
	}
	if atWarn(cur.Pressure) && a.SwapRiseGB >= swapRiseGB {
		a.add("memory", "swap-rising", LevelRisk, "swap grew %.1f GB in the last hour while at warn", a.SwapRiseGB)
	}
	if cur.SwapGB >= swapMaxGB {
		a.add("memory", "swap-high", LevelRisk, "%.1f GB of swap in use (limit %.0f GB)", cur.SwapGB, swapMaxGB)
	}
	if cur.RAMGB > 0 && a.HeadroomGB == 0 && cur.Pressure == "normal" {
		a.add("memory", "no-headroom", LevelOK, "no spare RAM after the %.1f GB reserve (%.1f of %.0f GB held by work)", reserveGB, cur.InRAMGB, cur.RAMGB)
	}

	// Battery: only hosts that have one.
	if b := cur.Batt; b != nil && b.Present {
		a.DrainPctH = drain(hist, cur)
		if !b.OnAC {
			if a.DrainPctH > 0 {
				a.MinToFloor = int(float64(b.Pct-batteryFloorPct) / a.DrainPctH * 60)
			} else if b.RemainMin > 0 && b.Pct > 0 {
				a.MinToFloor = b.RemainMin * (b.Pct - batteryFloorPct) / b.Pct
			}
			if a.MinToFloor < 0 && b.Pct <= batteryFloorPct {
				a.MinToFloor = 0
			}
		}
		switch {
		case !b.OnAC && b.Pct <= batteryFloorPct:
			a.add("battery", "battery-floor", LevelBlock, "battery %d%% on battery power: at the %d%% floor", b.Pct, batteryFloorPct)
		case !b.OnAC && b.Pct <= batteryWarnPct:
			a.add("battery", "battery-low", LevelRisk, "battery %d%% on battery power", b.Pct)
		case !b.OnAC && a.MinToFloor >= 0 && a.MinToFloor < minToFloor:
			a.add("battery", "battery-draining", LevelRisk, "about %d min to the %d%% floor at the current drain", a.MinToFloor, batteryFloorPct)
		case !b.OnAC && atWarn(cur.Pressure) && b.Pct <= batteryPairPct:
			a.add("battery", "battery-low-pressure", LevelRisk, "battery %d%% with memory at warn: plug in or close the browser", b.Pct)
		case !b.OnAC:
			a.add("battery", "on-battery", LevelWatch, "on battery power (%d%%): light work only", b.Pct)
		}
		if b.OnAC && a.DrainPctH >= 3 && b.Pct < 100 {
			a.ChargerBehind = true
			lvl := LevelRisk
			if b.Pct <= batteryFloorPct {
				lvl = LevelBlock
			}
			a.add("battery", "charger-behind", lvl, "plugged in but losing %.0f%%/h: the charger can't keep up%s", a.DrainPctH, adapterNote(b))
		} else if b.OnAC && b.AdapterW > 0 && b.SystemW > b.AdapterW {
			a.add("battery", "charger-weak", LevelWatch, "the machine draws %.1f W from a %.0f W charger", b.SystemW, b.AdapterW)
		}
	}

	// Disk: swap lives on the boot volume.
	switch {
	case cur.DiskGB <= 0:
	case cur.DiskGB < diskBlockGB:
		a.add("disk", "disk-critical", LevelBlock, "%.1f GB free: too little for swap", cur.DiskGB)
	case cur.DiskGB < diskMinGB:
		a.add("disk", "disk-low", LevelRisk, "%.1f GB free (keep %.0f GB)", cur.DiskGB, diskMinGB)
	case cur.DiskGB < diskWatchGB:
		a.add("disk", "disk-tight", LevelWatch, "%.1f GB free", cur.DiskGB)
	}

	// CPU: the OS's throttle signal, then the run queue per core.
	if cur.SpeedPct > 0 && cur.SpeedPct < 100 {
		a.add("cpu", "cpu-throttled", LevelRisk, "the OS has limited CPU speed to %d%% (heat or power)", cur.SpeedPct)
	}
	if cur.CPUs > 0 {
		switch perCore := cur.Load1 / float64(cur.CPUs); {
		case perCore >= 2:
			a.add("cpu", "cpu-saturated", LevelRisk, "load %.1f on %d cores", cur.Load1, cur.CPUs)
		case perCore >= 1:
			a.add("cpu", "cpu-busy", LevelWatch, "load %.1f on %d cores", cur.Load1, cur.CPUs)
		}
	}
	return a
}

func adapterNote(b *Battery) string {
	if b.AdapterW > 0 {
		return fmt.Sprintf(" (%.0f W adapter)", b.AdapterW)
	}
	return ""
}

// ---- autoscaler ----

// slotGB is the RAM one mesh agent slot reserves. Override with
// "guard_slot_gb" in config.json once real agents are measured.
const defaultSlotGB = 2.0

// scaleCooldown is how long a host must stay calm (ok or watch) before it
// adds a slot, and scaleStep the minimum time between two additions.
const (
	scaleCooldown = 10 * time.Minute
	scaleStep     = 5 * time.Minute
)

// Scale is the autoscaler's state and output: how many agent slots this host
// offers the mesh, and whether it admits new work at all.
type Scale struct {
	Slots     int       `json:"slots"`
	Admission string    `json:"admission"` // open | full | limited | closed
	ChangedAt time.Time `json:"changed_at"`
	CalmSince time.Time `json:"calm_since"`
}

// targetSlots is what memory and cores allow right now, before hysteresis.
// One core stays free for the OS and the person using the machine.
func targetSlots(cur Sample, a Assessment, slotGB float64) int {
	if slotGB <= 0 {
		slotGB = defaultSlotGB
	}
	n := int(a.HeadroomGB / slotGB)
	if cur.CPUs > 1 && n > cur.CPUs-1 {
		n = cur.CPUs - 1
	}
	if a.Level == LevelWatch && n > 1 {
		n = 1 // light work only
	}
	if n < 0 {
		n = 0
	}
	return n
}

// autoscale scales down at once and up slowly: one slot at a time, only after
// scaleCooldown without risk, and at most every scaleStep. A new host
// therefore takes no mesh work until it has been calm for ten minutes.
func autoscale(prev Scale, a Assessment, target int, now time.Time) Scale {
	next := prev
	if a.Level >= LevelRisk {
		next.CalmSince = time.Time{}
		target = 0
	} else if next.CalmSince.IsZero() {
		next.CalmSince = now
	}
	switch {
	case target < prev.Slots:
		next.Slots, next.ChangedAt = target, now
	case target > prev.Slots && !next.CalmSince.IsZero() && now.Sub(next.CalmSince) >= scaleCooldown && now.Sub(prev.ChangedAt) >= scaleStep:
		next.Slots, next.ChangedAt = prev.Slots+1, now
	}
	switch {
	case a.Level >= LevelRisk:
		next.Admission = "closed"
	case a.Level == LevelWatch:
		next.Admission = "limited"
	case next.Slots == 0 && a.HeadroomGB < reserveGB:
		next.Admission = "full"
	default:
		next.Admission = "open"
	}
	return next
}

// ---- local admission for one job ----

// lightJobGB is the most a job may ask for while the host is at watch.
const lightJobGB = 1.0

// admit decides whether a job that needs memGB may start now.
func admit(a Assessment, memGB float64) (bool, string) {
	switch {
	case a.Level >= LevelRisk:
		return false, "host at " + a.Level.String() + ": " + worst(a)
	case a.Level == LevelWatch && memGB > lightJobGB:
		return false, fmt.Sprintf("light work only (%s); this job asks for %.1f GB, the limit is %.1f GB", worst(a), memGB, lightJobGB)
	case memGB > a.HeadroomGB && memGB > 0:
		return false, fmt.Sprintf("needs %.1f GB, %.1f GB free after the %.1f GB reserve", memGB, a.HeadroomGB, reserveGB)
	}
	return true, "ok"
}

// worst is the text of the most severe finding.
func worst(a Assessment) string {
	best := -1
	for i, f := range a.Findings {
		if best < 0 || f.Level > a.Findings[best].Level {
			best = i
		}
	}
	if best < 0 {
		return "no findings"
	}
	return a.Findings[best].Text
}

// ---- history ----

const historyKeep = 24 * time.Hour

func (s Store) guardHistory() []Sample {
	f, err := os.Open(s.path("guard.jsonl"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []Sample
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var x Sample
		if json.Unmarshal(sc.Bytes(), &x) == nil && !x.At.IsZero() {
			out = append(out, x)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out
}

// appendGuard adds one sample and, once a day's worth has doubled, rewrites
// the file with only the last day (one sample a minute ≈ 400 KB a day).
func (s Store) appendGuard(x Sample, hist []Sample) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(x)
	if len(hist) > 2*24*60 {
		keep := recent(hist, x.At, historyKeep)
		var buf strings.Builder
		for _, h := range keep {
			hb, _ := json.Marshal(h)
			buf.Write(hb)
			buf.WriteByte('\n')
		}
		buf.Write(b)
		buf.WriteByte('\n')
		tmp := s.path("guard.jsonl.tmp")
		if err := os.WriteFile(tmp, []byte(buf.String()), 0o600); err != nil {
			return err
		}
		return os.Rename(tmp, s.path("guard.jsonl"))
	}
	f, err := os.OpenFile(s.path("guard.jsonl"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(append(b, '\n'))
	return err
}

// ---- parsers (platform-neutral so both hosts' fixtures test everywhere) ----

var vmStatRe = regexp.MustCompile(`^(.+?):\s+(\d+)\.?$`)

// parseVMStat reads macOS `vm_stat`: page size from the header, then counts.
func parseVMStat(out string) (pageSize float64, pages map[string]float64) {
	pages = map[string]float64{}
	pageSize = 16384
	if m := regexp.MustCompile(`page size of (\d+) bytes`).FindStringSubmatch(out); m != nil {
		pageSize, _ = strconv.ParseFloat(m[1], 64)
	}
	for _, line := range strings.Split(out, "\n") {
		if m := vmStatRe.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
			v, _ := strconv.ParseFloat(m[2], 64)
			pages[strings.Trim(m[1], `"`)] = v
		}
	}
	return pageSize, pages
}

// macMemory turns vm_stat into what work holds in RAM and what it would hold
// uncompressed (mem-guard's "demand").
func macMemory(vmstat string) (inRAM, demand float64) {
	ps, p := parseVMStat(vmstat)
	g := func(n float64) float64 { return n * ps / (1 << 30) }
	wired, anon := p["Pages wired down"], p["Anonymous pages"]
	return round1(g(wired + anon + p["Pages occupied by compressor"])), round1(g(wired + anon + p["Pages stored in compressor"]))
}

var (
	battPctRe    = regexp.MustCompile(`(\d+)%;\s*([^;]+);`)
	battRemainRe = regexp.MustCompile(`(\d+):(\d+) remaining`)
)

// parsePmsetBatt reads `pmset -g batt`:
//
//	Now drawing from 'AC Power'
//	 -InternalBattery-0 (id=…)	70%; charging; 1:59 remaining present: true
func parsePmsetBatt(out string) Battery {
	var b Battery
	m := battPctRe.FindStringSubmatch(out)
	if m == nil || !strings.Contains(out, "InternalBattery") {
		return b
	}
	b.Present = true
	b.Pct, _ = strconv.Atoi(m[1])
	b.OnAC = strings.Contains(out, "'AC Power'")
	state := strings.TrimSpace(m[2])
	b.Charging = state == "charging" || state == "finishing charge"
	if r := battRemainRe.FindStringSubmatch(out); r != nil {
		h, _ := strconv.Atoi(r[1])
		mm, _ := strconv.Atoi(r[2])
		b.RemainMin = h*60 + mm
	}
	return b
}

var wattRe = regexp.MustCompile(`(?m)^\s*Wattage\s*=\s*(\d+)W`)

// parsePmsetAC reads the charger's rating from `pmset -g ac` ("Wattage = 8W").
func parsePmsetAC(out string) float64 {
	if m := wattRe.FindStringSubmatch(out); m != nil {
		v, _ := strconv.ParseFloat(m[1], 64)
		return v
	}
	return 0
}

// ioregInt finds `"Key" = 123` or `"Key"=123` (inside a dictionary) in
// `ioreg -rn AppleSmartBattery`. Negative currents print as 64-bit unsigned.
func ioregInt(out, key string) (int64, bool) {
	m := regexp.MustCompile(`"` + regexp.QuoteMeta(key) + `"\s*=\s*(\d+)`).FindStringSubmatch(out)
	if m == nil {
		return 0, false
	}
	u, err := strconv.ParseUint(m[1], 10, 64)
	if err != nil {
		return 0, false
	}
	return int64(u), true
}

// applyIoreg adds cycle count and system draw from the battery controller.
// SystemLoad (mW) is not documented by Apple; it is shown, not decided on,
// except against the charger's own rating.
func applyIoreg(b *Battery, out string) {
	if v, ok := ioregInt(out, "CycleCount"); ok {
		b.Cycles = int(v)
	}
	if v, ok := ioregInt(out, "SystemLoad"); ok && v > 0 && v < 500_000 {
		b.SystemW = round1(float64(v) / 1000)
	}
}

var (
	profCapRe  = regexp.MustCompile(`Maximum Capacity:\s*(\d+)%`)
	profCondRe = regexp.MustCompile(`Condition:\s*(.+)`)
	profCycRe  = regexp.MustCompile(`Cycle Count:\s*(\d+)`)
)

// applyProfiler takes battery health in the OS's own terms from
// `system_profiler SPPowerDataType` (slow, so only for the deep report).
func applyProfiler(b *Battery, out string) {
	if m := profCapRe.FindStringSubmatch(out); m != nil {
		b.HealthPct, _ = strconv.Atoi(m[1])
	}
	if m := profCondRe.FindStringSubmatch(out); m != nil {
		b.Condition = strings.TrimSpace(m[1])
	}
	if m := profCycRe.FindStringSubmatch(out); m != nil && b.Cycles == 0 {
		b.Cycles, _ = strconv.Atoi(m[1])
	}
}

var speedRe = regexp.MustCompile(`CPU_Speed_Limit\s*=\s*(\d+)`)

// parseTherm reads `pmset -g therm`; no limit recorded means full speed.
func parseTherm(out string) int {
	if m := speedRe.FindStringSubmatch(out); m != nil {
		v, _ := strconv.Atoi(m[1])
		return v
	}
	if strings.Contains(out, "No thermal warning") || strings.Contains(out, "No CPU power status") {
		return 100
	}
	return 0
}

// parseLoad reads `sysctl -n vm.loadavg` ("{ 1.52 1.61 1.75 }") or
// /proc/loadavg ("0.52 0.61 0.75 1/234 5678"): the 1-minute figure.
func parseLoad(s string) float64 {
	for _, f := range strings.Fields(strings.Trim(strings.TrimSpace(s), "{}")) {
		if v, err := strconv.ParseFloat(f, 64); err == nil {
			return v
		}
	}
	return 0
}

// parsePSI reads /proc/pressure/memory: the 60 s "some" and "full" averages.
func parsePSI(text string) (some, full float64, ok bool) {
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 3 {
			continue
		}
		for _, kv := range f[1:] {
			if v, found := strings.CutPrefix(kv, "avg60="); found {
				x, err := strconv.ParseFloat(v, 64)
				if err != nil {
					continue
				}
				ok = true
				if f[0] == "some" {
					some = x
				} else if f[0] == "full" {
					full = x
				}
			}
		}
	}
	return some, full, ok
}

// psiPressure maps PSI to the macOS words. Our heuristic, not a kernel level:
// "full" means every task was stalled on memory, so 10% of a minute is severe.
func psiPressure(some, full float64) string {
	switch {
	case full >= 10 || some >= 40:
		return "critical"
	case some >= 10:
		return "warn"
	}
	return "normal"
}

// worse returns the more severe of two pressure words.
func worse(a, b string) string {
	rank := map[string]int{"": 0, "normal": 1, "warn": 2, "critical": 3}
	if rank[b] > rank[a] {
		return b
	}
	return a
}

// linuxBattery reads one /sys/class/power_supply directory's files, given as
// name → content, for every supply on the host.
func linuxBattery(supplies map[string]map[string]string) Battery {
	var b Battery
	for _, f := range supplies {
		v := func(k string) string { return strings.TrimSpace(f[k]) }
		switch v("type") {
		case "Mains", "USB":
			if v("online") == "1" {
				b.OnAC = true
			}
		case "Battery":
			if v("present") == "0" || v("scope") == "Device" { // a mouse's battery is not ours
				continue
			}
			b.Present = true
			b.Pct, _ = strconv.Atoi(v("capacity"))
			st := v("status")
			b.Charging = st == "Charging"
			if st == "Charging" || st == "Full" || st == "Not charging" {
				b.OnAC = true
			}
			b.Cycles, _ = strconv.Atoi(v("cycle_count"))
			full, design := v("energy_full"), v("energy_full_design")
			if full == "" {
				full, design = v("charge_full"), v("charge_full_design")
			}
			fv, _ := strconv.ParseFloat(full, 64)
			dv, _ := strconv.ParseFloat(design, 64)
			if fv > 0 && dv > 0 {
				b.HealthPct = int(math.Round(fv / dv * 100))
			}
		}
	}
	if !b.Present {
		return Battery{}
	}
	return b
}

// readSupplies reads the files linuxBattery needs for every supply under
// root (/sys/class/power_supply; its entries are symlinks to device dirs).
func readSupplies(root string) map[string]map[string]string {
	out := map[string]map[string]string{}
	ents, _ := os.ReadDir(root)
	for _, e := range ents {
		f := map[string]string{}
		for _, k := range []string{"type", "online", "present", "scope", "capacity", "status", "cycle_count",
			"energy_full", "energy_full_design", "charge_full", "charge_full_design"} {
			if b, err := os.ReadFile(filepath.Join(root, e.Name(), k)); err == nil {
				f[k] = string(b)
			}
		}
		out[e.Name()] = f
	}
	return out
}

// ---- who uses the memory (stays on this device) ----

// memGroup buckets a process by its executable path, the same owners
// mem-guard and memory.tsv use where the path alone can tell.
func memGroup(comm string) string {
	c := strings.ToLower(comm)
	switch {
	case strings.Contains(c, "virtualization.virtualmachine") || strings.Contains(c, "qemu") || strings.Contains(c, "podman") || strings.Contains(c, "docker"):
		return "vm"
	case strings.Contains(c, "/claude-code/") || strings.Contains(c, "/.local/share/claude/") || strings.HasSuffix(c, "/bin/claude") || c == "claude":
		return "claude code" // before the app: the desktop app's Claude Code is its own claude.app
	case strings.Contains(c, "/claude.app/"):
		return "claude app"
	case strings.Contains(c, "chrome") || strings.Contains(c, "safari") || strings.Contains(c, "webkit") || strings.Contains(c, "firefox") || strings.Contains(c, "arc.app") || strings.Contains(c, "brave") || strings.Contains(c, "edge"):
		return "browser"
	case strings.Contains(c, "mlx") || strings.Contains(c, "ollama") || strings.Contains(c, "llama"):
		return "local models"
	case strings.HasSuffix(c, "/node") || c == "node" || strings.Contains(c, "esbuild") || strings.HasSuffix(c, "/go") || strings.Contains(c, "gopls") || strings.Contains(c, "python") || strings.Contains(c, "cargo") || strings.Contains(c, "rustc"):
		return "dev tools"
	case strings.Contains(c, "whatsapp") || strings.Contains(c, "slack") || strings.Contains(c, "discord") || strings.Contains(c, "teams") || strings.Contains(c, "zoom"):
		return "chat"
	case strings.HasPrefix(c, "/system/") || strings.HasPrefix(c, "/usr/") || strings.HasPrefix(c, "/sbin/") || strings.HasPrefix(c, "/library/apple/") || c == "kernel_task" || strings.HasPrefix(c, "/lib/systemd"):
		return "os"
	}
	return "other apps"
}

// Group is a memory owner and its resident size.
type Group struct {
	Name string
	GB   float64
}

// parsePSGroups sums `ps -axo rss=,comm=` (KB) per group, biggest first.
// Resident size double-counts shared pages and misses compressed ones, so it
// ranks owners; it does not add up to the totals above.
func parsePSGroups(out string) []Group {
	sum := map[string]float64{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		sp := strings.IndexAny(line, " \t")
		if sp < 0 {
			continue
		}
		kb, err := strconv.ParseFloat(line[:sp], 64)
		if err != nil {
			continue
		}
		sum[memGroup(strings.TrimSpace(line[sp:]))] += kb / (1 << 20)
	}
	var gs []Group
	for n, v := range sum {
		gs = append(gs, Group{n, round1(v)})
	}
	sort.Slice(gs, func(i, j int) bool {
		if gs[i].GB != gs[j].GB {
			return gs[i].GB > gs[j].GB
		}
		return gs[i].Name < gs[j].Name
	})
	return gs
}

func topGroups(gs []Group, n int) string {
	var parts []string
	for _, g := range gs {
		if g.Name == "os" || g.GB < 0.1 {
			continue
		}
		parts = append(parts, fmt.Sprintf("%s %.1f GB", g.Name, g.GB))
		if len(parts) == n {
			break
		}
	}
	return strings.Join(parts, ", ")
}
