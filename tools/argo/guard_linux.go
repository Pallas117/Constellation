//go:build linux

package main

import (
	"context"
	"time"
)

// sampleHost reads a Linux host from /proc and /sys only: no commands, so it
// works in the distroless container too.
func sampleHost(ctx context.Context, _ bool) Sample {
	c := hostCapacity(ctx)
	s := Sample{At: time.Now().UTC().Truncate(time.Second), Pressure: c.Pressure, RAMGB: c.RAMGB,
		SwapGB: c.SwapUsedGB, DiskGB: c.DiskFreeGB, CPUs: c.CPUs}
	total, avail, _ := parseMeminfo(readFile("/proc/meminfo"))
	s.InRAMGB = round1(total - avail)
	if some, full, ok := parsePSI(readFile("/proc/pressure/memory")); ok {
		s.Pressure = worse(s.Pressure, psiPressure(some, full))
	}
	s.Load1 = parseLoad(readFile("/proc/loadavg"))
	if b := linuxBattery(readSupplies("/sys/class/power_supply")); b.Present {
		s.Batt = &b
	}
	return s
}

func memoryUsers(ctx context.Context) []Group {
	return parsePSGroups(run(ctx, "ps", "-eo", "rss=,comm="))
}
