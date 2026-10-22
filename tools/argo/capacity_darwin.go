//go:build darwin

package main

import (
	"context"
	"strconv"
	"strings"
)

func hostCapacity(ctx context.Context) HostCapacity {
	c := baseCapacity()
	if mem, err := strconv.ParseFloat(strings.TrimSpace(run(ctx, "sysctl", "-n", "hw.memsize")), 64); err == nil {
		c.RAMGB = gb(mem)
	}
	if lvl, err := strconv.Atoi(strings.TrimSpace(run(ctx, "sysctl", "-n", "kern.memorystatus_vm_pressure_level"))); err == nil {
		c.Pressure = pressureName(lvl)
	}
	c.SwapUsedGB = parseSwapUsage(run(ctx, "sysctl", "-n", "vm.swapusage"))
	return c
}
