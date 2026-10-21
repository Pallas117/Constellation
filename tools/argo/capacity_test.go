package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestPressureName(t *testing.T) {
	for lvl, want := range map[int]string{1: "normal", 2: "warn", 4: "critical", 0: "", 3: ""} {
		if got := pressureName(lvl); got != want {
			t.Errorf("level %d: %q, want %q", lvl, got, want)
		}
	}
}

func TestPlatformName(t *testing.T) {
	for goos, want := range map[string]string{"darwin": "macos", "linux": "linux", "windows": "windows", "freebsd": "", "ios": ""} {
		if got := platformName(goos); got != want {
			t.Errorf("%s: %q, want %q", goos, got, want)
		}
	}
}

func TestParseSwapUsage(t *testing.T) {
	cases := map[string]float64{
		"total = 4096.00M  used = 2994.94M  free = 1101.06M  (encrypted)": 2.9,
		"total = 8.00G  used = 1.50G  free = 6.50G":                       1.5,
		"total = 0.00M  used = 0.00M  free = 0.00M":                       0,
		"garbage": 0,
	}
	for in, want := range cases {
		if got := parseSwapUsage(in); got != want {
			t.Errorf("%q: %v, want %v", in, got, want)
		}
	}
}

func TestParseMeminfoAndLinuxPressure(t *testing.T) {
	mi := "MemTotal:       16303844 kB\nMemFree:  1000 kB\nMemAvailable:    2400000 kB\nSwapTotal:  2097148 kB\nSwapFree:   1048574 kB\n"
	total, avail, swap := parseMeminfo(mi)
	if total != 15.5 || avail != 2.3 || swap != 1 {
		t.Fatalf("total %v avail %v swap %v", total, avail, swap)
	}
	if got := linuxPressure(total, avail); got != "warn" { // 2.3/15.5 = 15%
		t.Errorf("pressure %q", got)
	}
	if linuxPressure(16, 1) != "critical" || linuxPressure(16, 8) != "normal" || linuxPressure(0, 0) != "" {
		t.Error("thresholds")
	}
}

func TestHostCapacityOnThisMachine(t *testing.T) {
	c := hostCapacity(context.Background())
	if c.CPUs < 1 || c.OS == "" || c.RAMGB <= 0 || c.DiskFreeGB <= 0 {
		t.Fatalf("implausible capacity: %+v", c)
	}
	b, _ := json.Marshal(c)
	for _, k := range []string{`"ramGB"`, `"pressure"`, `"swapUsedGB"`, `"diskFreeGB"`, `"cpus"`, `"os"`} {
		if !strings.Contains(string(b), k) {
			t.Errorf("JSON missing %s: %s", k, b)
		}
	}
}
