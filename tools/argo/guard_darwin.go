//go:build darwin

package main

import (
	"context"
	"regexp"
	"time"
)

var lowPowerRe = regexp.MustCompile(`(?m)^\s*lowpowermode\s+1\b`)

// sampleHost reads this Mac with the same commands mem-guard and
// gauss-services.sh use (sysctl, vm_stat, pmset, ioreg). deep adds
// system_profiler's battery health, which takes about a second.
func sampleHost(ctx context.Context, deep bool) Sample {
	c := hostCapacity(ctx)
	s := Sample{At: time.Now().UTC().Truncate(time.Second), Pressure: c.Pressure, RAMGB: c.RAMGB,
		SwapGB: c.SwapUsedGB, DiskGB: c.DiskFreeGB, CPUs: c.CPUs}
	vm := run(ctx, "vm_stat")
	s.InRAMGB, s.DemandGB = macMemory(vm)
	s.SwapOutGB = swapOutGB(vm)
	s.AvailGB = availGB(run(ctx, "sysctl", "-n", "kern.memorystatus_level"), s.RAMGB)
	s.Load1 = parseLoad(run(ctx, "sysctl", "-n", "vm.loadavg"))
	s.SpeedPct = parseTherm(run(ctx, "pmset", "-g", "therm"))
	if b := parsePmsetBatt(run(ctx, "pmset", "-g", "batt")); b.Present {
		if b.OnAC {
			b.AdapterW = parsePmsetAC(run(ctx, "pmset", "-g", "ac"))
		}
		applyIoreg(&b, run(ctx, "ioreg", "-rn", "AppleSmartBattery"))
		b.LowPower = lowPowerRe.MatchString(run(ctx, "pmset", "-g"))
		if deep {
			applyProfiler(&b, run(ctx, "system_profiler", "SPPowerDataType"))
		}
		s.Batt = &b
	}
	return s
}

func memoryUsers(ctx context.Context) []Group {
	return parsePSGroups(run(ctx, "ps", "-axo", "rss=,comm="))
}
