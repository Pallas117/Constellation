package main

import (
	"math"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
)

// HostCapacity is what Gauss needs to decide whether a mesh device can host
// agents or shared memory: sizes and the kernel's own pressure level only. No
// process names, paths or user data leave the device.
type HostCapacity struct {
	RAMGB      float64 `json:"ramGB"`
	Pressure   string  `json:"pressure"` // normal | warn | critical | "" (unknown)
	SwapUsedGB float64 `json:"swapUsedGB"`
	DiskFreeGB float64 `json:"diskFreeGB"`
	CPUs       int     `json:"cpus"`
	OS         string  `json:"os"`
}

func gb(bytes float64) float64 { return math.Round(bytes/(1<<30)*10) / 10 }

// pressureName maps macOS kern.memorystatus_vm_pressure_level (1 normal, 2 warn,
// 4 critical) to a word. mem-guard trusts this, not memory_pressure's "free %".
func pressureName(level int) string {
	switch level {
	case 1:
		return "normal"
	case 2:
		return "warn"
	case 4:
		return "critical"
	}
	return ""
}

var swapUsedRe = regexp.MustCompile(`used = ([0-9.]+)([MG])`)

// parseSwapUsage reads `sysctl -n vm.swapusage`: "total = 4096.00M  used = 2994.94M  free = …".
func parseSwapUsage(s string) float64 {
	m := swapUsedRe.FindStringSubmatch(s)
	if m == nil {
		return 0
	}
	v, _ := strconv.ParseFloat(m[1], 64)
	if m[2] == "M" {
		v /= 1024
	}
	return math.Round(v*10) / 10
}

// parseMeminfo reads Linux /proc/meminfo (values in kB).
func parseMeminfo(text string) (totalGB, availGB, swapUsedGB float64) {
	kb := map[string]float64{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			v, err := strconv.ParseFloat(f[1], 64)
			if err == nil {
				kb[strings.TrimSuffix(f[0], ":")] = v
			}
		}
	}
	return gb(kb["MemTotal"] * 1024), gb(kb["MemAvailable"] * 1024), gb((kb["SwapTotal"] - kb["SwapFree"]) * 1024)
}

// linuxPressure approximates the macOS levels from available memory.
func linuxPressure(totalGB, availGB float64) string {
	if totalGB <= 0 {
		return ""
	}
	switch r := availGB / totalGB; {
	case r < 0.10:
		return "critical"
	case r < 0.20:
		return "warn"
	}
	return "normal"
}

func diskFreeGB(path string) float64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0
	}
	return gb(float64(st.Bavail) * float64(st.Bsize))
}

func baseCapacity() HostCapacity {
	return HostCapacity{CPUs: runtime.NumCPU(), OS: runtime.GOOS, DiskFreeGB: diskFreeGB("/")}
}
