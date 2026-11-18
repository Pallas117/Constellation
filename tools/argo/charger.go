package main

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// ---- charger diagnosis ----
//
// 17 Nov 2026: judith sat on a charger that negotiated 5 V x 1.5 A = 8 W (ioreg AppleSmartBattery
// AdapterDetails: AdapterVoltage=5000, Current=1500, Watts=8, AdapterPowerTier=1): plain USB with
// no USB-C Power Delivery. The guard said only "charger can't keep up". The negotiation tells why:
// USB-C Power Delivery (USB PD, USB-IF specification; typically 9-20 V) is what lets a laptop
// charger give 30 W or more; a plain 5 V port tops out at 15 W (USB Type-C 3.0 A at 5 V) and
// usually gives 5-12 W. Readings only: a host that reports no negotiation is UNKNOWN, never guessed.

// Adapter is what the charger negotiated with the machine.
type Adapter struct {
	Volts    float64 `json:"volts"`              // negotiated voltage
	Amps     float64 `json:"amps,omitempty"`     // negotiated current limit
	Watts    float64 `json:"watts"`              // negotiated power
	Tier     int     `json:"tier,omitempty"`     // macOS AdapterPowerTier, as reported
	Wireless bool    `json:"wireless,omitempty"` // macOS IsWireless
}

// Charger states. ChargerUnknown means no negotiation was reported.
const (
	ChargerUnknown = ""
	ChargerNoPD    = "no-pd"  // 5 V (or less) and at most 15 W: plain USB, no USB-C Power Delivery
	ChargerPDLow   = "pd-low" // Power Delivery, but too few watts for the measured heavy-job load
	ChargerOK      = "ok"
)

const (
	noPDMaxV = 5.0  // a plain USB source stays at 5 V; Power Delivery steps up to 9 V and beyond
	noPDMaxW = 15.0 // USB Type-C at 5 V and 3 A
)

// Charger is the diagnosis: state and the numbers behind it, for the guard, `argo status` and the
// mesh report.
type Charger struct {
	State string  `json:"state,omitempty"`
	Volts float64 `json:"volts,omitempty"`
	Watts float64 `json:"watts,omitempty"`
}

var adapterDetailsRe = regexp.MustCompile(`"AdapterDetails"\s*=\s*\{([^{}]*)\}`)

// parseAdapterDetails reads the AdapterDetails block of `ioreg -rn AppleSmartBattery`. ok is false
// when the block is absent or empty (nothing plugged in, or a Mac that doesn't report it).
func parseAdapterDetails(out string) (Adapter, bool) {
	m := adapterDetailsRe.FindStringSubmatch(out)
	if m == nil {
		return Adapter{}, false
	}
	block := m[1]
	mv, okV := ioregInt(block, "AdapterVoltage")
	ma, _ := ioregInt(block, "Current")
	w, okW := ioregInt(block, "Watts")
	if !okV || !okW || mv <= 0 || mv > 60_000 || w <= 0 || w > 500 || ma < 0 || ma > 20_000 {
		return Adapter{}, false
	}
	a := Adapter{Volts: round1(float64(mv) / 1000), Amps: round1(float64(ma) / 1000), Watts: float64(w)}
	if t, ok := ioregInt(block, "AdapterPowerTier"); ok && t <= 15 {
		a.Tier = int(t)
	}
	a.Wireless = regexp.MustCompile(`"IsWireless"\s*=\s*(Yes|1|true)\b`).MatchString(block)
	return a, true
}

// linuxAdapter reads the charger from /sys/class/power_supply files (readSupplies): an online
// Mains or USB supply that reports a voltage (voltage_max, else voltage_now, in µV) and a current
// limit (current_max, µA). Without both the answer is nil: UNKNOWN.
func linuxAdapter(supplies map[string]map[string]string) *Adapter {
	for _, f := range supplies {
		v := func(k string) float64 { x, _ := strconv.ParseFloat(strings.TrimSpace(f[k]), 64); return x }
		switch strings.TrimSpace(f["type"]) {
		case "Mains", "USB", "USB_C", "USB_PD", "USB_PD_DRP", "USB_DCP", "USB_CDP", "USB_ACA":
		default:
			continue
		}
		if strings.TrimSpace(f["online"]) != "1" {
			continue
		}
		uv, ua := v("voltage_max"), v("current_max")
		if uv <= 0 {
			uv = v("voltage_now")
		}
		if uv <= 0 || uv > 60e6 || ua <= 0 || ua > 20e6 {
			continue
		}
		volts, amps := uv/1e6, ua/1e6
		return &Adapter{Volts: round1(volts), Amps: round1(amps), Watts: round1(volts * amps)}
	}
	return nil
}

// classifyCharger judges a negotiation against the load the machine is carrying. loadW is the
// machine's draw plus one more worker of the heavy job (power.go's measured watts per worker);
// with no draw reading only no-PD can be told. The derated supply is what counts, as in the budget.
func classifyCharger(a *Adapter, loadW float64) string {
	switch {
	case a == nil || a.Watts <= 0:
		return ChargerUnknown
	case a.Volts <= noPDMaxV && a.Watts <= noPDMaxW:
		return ChargerNoPD
	case loadW > 0 && a.Watts*sourceDerate < loadW:
		return ChargerPDLow
	}
	return ChargerOK
}

// chargerOf is the diagnosis for one battery reading.
func chargerOf(b *Battery, workerW float64) Charger {
	if b == nil || !b.Present || !b.OnAC || b.Adapter == nil {
		return Charger{}
	}
	if workerW < minWorkerW {
		workerW = defaultWorkerW
	}
	load := 0.0
	if b.SystemW > 0 {
		load = b.SystemW + workerW
	}
	return Charger{State: classifyCharger(b.Adapter, load), Volts: b.Adapter.Volts, Watts: b.Adapter.Watts}
}

// chargerWhy says why power is short and what to do, or "" when the charger is fine or unknown.
func chargerWhy(c Charger) string {
	switch c.State {
	case ChargerNoPD:
		return fmt.Sprintf("plugged into %s V USB (no USB-C Power Delivery): use a USB-C to USB-C cable with a fast charger; this one gives %s W",
			trimNum(c.Volts), trimNum(c.Watts))
	case ChargerPDLow:
		return fmt.Sprintf("this charger negotiated %s V and gives only %s W, less than a heavy job needs: use a charger of 30 W or more",
			trimNum(c.Volts), trimNum(c.Watts))
	}
	return ""
}

// chargerText is the one-line charger state for `argo status`.
func chargerText(c Charger) string {
	switch c.State {
	case ChargerNoPD:
		return fmt.Sprintf("no USB-C Power Delivery: %s V, %s W (%s)", trimNum(c.Volts), trimNum(c.Watts), chargerAdvice(c))
	case ChargerPDLow:
		return fmt.Sprintf("Power Delivery but low: %s V, %s W (%s)", trimNum(c.Volts), trimNum(c.Watts), chargerAdvice(c))
	case ChargerOK:
		return fmt.Sprintf("ok: %s V, %s W", trimNum(c.Volts), trimNum(c.Watts))
	}
	return "unknown: the host reports no charger negotiation"
}

func chargerAdvice(c Charger) string {
	if c.State == ChargerNoPD {
		return "use a USB-C to USB-C cable with a fast charger"
	}
	return "use a charger of 30 W or more"
}

func trimNum(f float64) string {
	if f == math.Trunc(f) {
		return strconv.Itoa(int(f))
	}
	return strconv.FormatFloat(f, 'f', 1, 64)
}
