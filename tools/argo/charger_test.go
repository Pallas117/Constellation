package main

import (
	"strings"
	"testing"
)

// Captured shape of `ioreg -rn AppleSmartBattery` (AdapterDetails is one line; other keys trimmed).
// The first sample is judith on 17 Nov 2026: 5 V x 1.5 A = 8 W, plain USB.
const ioregNoPD = `+-o AppleSmartBattery  <class AppleSmartBattery, id 0x100000a3c, registered, matched, active, busy 0 (3 ms), retain 7>
    {
      "CycleCount" = 412
      "ExternalConnected" = Yes
      "SystemLoad" = 9400
      "AdapterDetails" = {"AdapterVoltage"=5000,"IsWireless"=No,"Watts"=8,"Description"="usb charger","Current"=1500,"Source"=1,"AdapterPowerTier"=1}
      "AppleRawAdapterDetails" = ({"AdapterVoltage"=5000,"Watts"=8,"Current"=1500})
    }`

const ioregPD = `    {
      "ExternalConnected" = Yes
      "SystemLoad" = 14200
      "AdapterDetails" = {"AdapterVoltage"=20000,"IsWireless"=No,"Watts"=30,"Description"="pd charger","Current"=1500,"Source"=3,"AdapterPowerTier"=3}
    }`

const ioregWireless = `    "AdapterDetails" = {"AdapterVoltage"=9000,"IsWireless"=Yes,"Watts"=15,"Current"=1667}`

const ioregUnplugged = `    {
      "ExternalConnected" = No
      "AdapterDetails" = {}
      "SystemLoad" = 6100
    }`

func chBatt(pct int, ac bool) *Battery { return &Battery{Present: true, Pct: pct, OnAC: ac} }

func TestParseAdapterDetails(t *testing.T) {
	for _, c := range []struct {
		name string
		out  string
		ok   bool
		want Adapter
	}{
		{"5 V / 8 W plain USB (17 Nov)", ioregNoPD, true, Adapter{Volts: 5, Amps: 1.5, Watts: 8, Tier: 1}},
		{"20 V / 30 W Power Delivery", ioregPD, true, Adapter{Volts: 20, Amps: 1.5, Watts: 30, Tier: 3}},
		{"wireless", ioregWireless, true, Adapter{Volts: 9, Amps: 1.7, Watts: 15, Wireless: true}},
		{"unplugged: empty block", ioregUnplugged, false, Adapter{}},
		{"no block at all", `"CycleCount" = 3`, false, Adapter{}},
		{"empty output", "", false, Adapter{}},
		{"raw array alone is not trusted", `"AppleRawAdapterDetails" = ({"AdapterVoltage"=5000,"Watts"=8})`, false, Adapter{}},
		{"zero watts", `"AdapterDetails" = {"AdapterVoltage"=5000,"Watts"=0,"Current"=0}`, false, Adapter{}},
		{"absurd voltage", `"AdapterDetails" = {"AdapterVoltage"=900000,"Watts"=8,"Current"=1500}`, false, Adapter{}},
		{"absurd watts", `"AdapterDetails" = {"AdapterVoltage"=20000,"Watts"=99999,"Current"=1500}`, false, Adapter{}},
		{"missing watts", `"AdapterDetails" = {"AdapterVoltage"=20000,"Current"=1500}`, false, Adapter{}},
	} {
		got, ok := parseAdapterDetails(c.out)
		if ok != c.ok || got != c.want {
			t.Errorf("%s: got %+v ok=%v, want %+v ok=%v", c.name, got, ok, c.want, c.ok)
		}
	}
}

func TestApplyIoregAdapter(t *testing.T) {
	b := Battery{Present: true, OnAC: true}
	applyIoreg(&b, ioregNoPD)
	if b.Adapter == nil || b.Adapter.Watts != 8 || b.SystemW != 9.4 || b.Cycles != 412 {
		t.Errorf("on AC: %+v adapter %+v", b, b.Adapter)
	}
	off := Battery{Present: true}
	applyIoreg(&off, ioregNoPD)
	if off.Adapter != nil {
		t.Errorf("on battery there is no charger to report: %+v", off.Adapter)
	}
}

func TestLinuxAdapter(t *testing.T) {
	sup := func(kv ...string) map[string]string {
		m := map[string]string{}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i]] = kv[i+1] + "\n"
		}
		return m
	}
	for _, c := range []struct {
		name string
		in   map[string]map[string]string
		want *Adapter
	}{
		{"USB-C 5 V 1.5 A", map[string]map[string]string{
			"BAT0": sup("type", "Battery", "capacity", "50"),
			"ucsi": sup("type", "USB", "online", "1", "voltage_max", "5000000", "current_max", "1500000")},
			&Adapter{Volts: 5, Amps: 1.5, Watts: 7.5}},
		{"mains 20 V 1.5 A from voltage_now", map[string]map[string]string{
			"AC": sup("type", "Mains", "online", "1", "voltage_now", "20000000", "current_max", "1500000")},
			&Adapter{Volts: 20, Amps: 1.5, Watts: 30}},
		{"offline", map[string]map[string]string{
			"AC": sup("type", "Mains", "online", "0", "voltage_max", "20000000", "current_max", "1500000")}, nil},
		{"online but no figures: UNKNOWN", map[string]map[string]string{
			"AC": sup("type", "Mains", "online", "1")}, nil},
		{"no current limit: UNKNOWN", map[string]map[string]string{
			"AC": sup("type", "Mains", "online", "1", "voltage_max", "20000000")}, nil},
		{"battery files never count", map[string]map[string]string{
			"BAT0": sup("type", "Battery", "online", "1", "voltage_max", "12000000", "current_max", "3000000")}, nil},
		{"garbage", map[string]map[string]string{
			"AC": sup("type", "Mains", "online", "1", "voltage_max", "x", "current_max", "y")}, nil},
		{"none", nil, nil},
	} {
		got := linuxAdapter(c.in)
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestClassifyCharger(t *testing.T) {
	for _, c := range []struct {
		name  string
		a     *Adapter
		loadW float64
		want  string
	}{
		{"nothing reported", nil, 10, ChargerUnknown},
		{"5 V 8 W is plain USB", &Adapter{Volts: 5, Watts: 8}, 9.4, ChargerNoPD},
		{"5 V 15 W is still plain USB", &Adapter{Volts: 5, Watts: 15}, 0, ChargerNoPD},
		{"5 V needs no load reading", &Adapter{Volts: 5, Watts: 8}, 0, ChargerNoPD},
		{"20 V 30 W carries a 14 W load", &Adapter{Volts: 20, Watts: 30}, 14.2 + defaultWorkerW, ChargerOK},
		{"PD 20 V 18 W, load 25 W: derated 14.4 W is short", &Adapter{Volts: 20, Watts: 18}, 25, ChargerPDLow},
		{"PD with no draw reading is not judged", &Adapter{Volts: 20, Watts: 18}, 0, ChargerOK},
		{"9 V 15 W is Power Delivery, not no-PD", &Adapter{Volts: 9, Watts: 15}, 5, ChargerOK},
		{"5 V above 15 W is not plain USB", &Adapter{Volts: 5, Watts: 25}, 5, ChargerOK},
		{"zero watts", &Adapter{Volts: 5}, 5, ChargerUnknown},
	} {
		if got := classifyCharger(c.a, c.loadW); got != c.want {
			t.Errorf("%s: %q, want %q", c.name, got, c.want)
		}
	}
}

func TestChargerReasonInGuardAndAlert(t *testing.T) {
	// judith, 17 Nov: 5 V / 8 W, drawing 12 W: the guard says why and what to do.
	s := calm()
	b := chBatt(70, true)
	b.AdapterW, b.SystemW, b.Adapter = 8, 12, &Adapter{Volts: 5, Amps: 1.5, Watts: 8, Tier: 1}
	s.Batt = b
	var f *Finding
	a := assess(nil, s)
	for i := range a.Findings {
		if a.Findings[i].Code == "charger-weak" {
			f = &a.Findings[i]
		}
	}
	const want = "plugged into 5 V USB (no USB-C Power Delivery): use a USB-C to USB-C cable with a fast charger; this one gives 8 W"
	if f == nil || !strings.Contains(f.Text, want) || f.Level != LevelWatch {
		t.Fatalf("finding %+v, want level watch and %q", f, want)
	}
	// The alert keeps its key and its warn level (attention policy): same key, no new repeats.
	if al := (Alert{Title: "Gauss: charger can't keep up", Key: "charger-weak", Msg: f.Text}); al.level() != AlertWarn {
		t.Errorf("alert level %d, want warn", al.level())
	}
	// Losing charge on the same charger: the reason rides on the existing charger-behind text.
	if note := chargerNote(b); !strings.Contains(note, want) {
		t.Errorf("charger-behind note %q", note)
	}
	// No negotiation reported: the text is as before, never a guess.
	b2 := chBatt(70, true)
	b2.AdapterW, b2.SystemW = 8, 12
	s.Batt = b2
	for _, f := range assess(nil, s).Findings {
		if f.Code == "charger-weak" && strings.Contains(f.Text, "USB") {
			t.Errorf("guessed a reason with no negotiation: %q", f.Text)
		}
	}
	if chargerNote(b2) != " (8 W adapter)" {
		t.Errorf("unknown note %q", chargerNote(b2))
	}
}

func TestChargerStatusAndReport(t *testing.T) {
	b := chBatt(70, true)
	b.SystemW, b.Adapter = 9.4, &Adapter{Volts: 5, Amps: 1.5, Watts: 8}
	g := GuardState{Batt: b}
	g.Report.At = t0
	g.Report.Level = "ok"
	if got := guardStatus(g, t0); got != " charger:no-pd 5V/8W" {
		t.Errorf("status %q", got)
	}
	rep := map[string]any{}
	addGuard(rep, g, t0)
	bat, _ := rep["battery"].(map[string]any)
	if c, _ := bat["charger"].(Charger); c != (Charger{State: ChargerNoPD, Volts: 5, Watts: 8}) {
		t.Errorf("report charger %+v", bat["charger"])
	}
	// Unknown sends nothing and prints nothing.
	g.Batt = chBatt(70, true)
	rep = map[string]any{}
	addGuard(rep, g, t0)
	if bat, _ := rep["battery"].(map[string]any); bat == nil || bat["charger"] != nil || guardStatus(g, t0) != "" {
		t.Errorf("unknown charger must stay silent: %v %q", rep, guardStatus(g, t0))
	}
	if !strings.Contains(chargerText(Charger{}), "unknown") {
		t.Error("unknown text")
	}
}
