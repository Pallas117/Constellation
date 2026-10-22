//go:build linux

package main

import "context"

func hostCapacity(context.Context) HostCapacity {
	c := baseCapacity()
	total, avail, swap := parseMeminfo(readFile("/proc/meminfo"))
	c.RAMGB, c.SwapUsedGB, c.Pressure = total, swap, linuxPressure(total, avail)
	return c
}
