package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// ---- "Wi-Fi is fading" ----

const fadeTitle = "Argo: Wi-Fi is fading"

var (
	weakSig   = &WiFiSignal{RSSI: -88, Noise: -95} // SNR 7 dB: a bad sample for the detector (RSSI <= -85)
	strongSig = &WiFiSignal{RSSI: -55, Noise: -95} // SNR 40 dB: a good sample
)

// wifiSnap is a working Wi-Fi link (the MY SIM fixture) with a signal reading and a connect time.
func wifiSnap(t *testing.T, sig *WiFiSignal, rttMs int) Snapshot {
	s := fixture(t, "my_sim_ok.json")
	s.WiFiSec, s.Signal, s.API.ConnectMs = "WPA2_PSK", sig, rttMs
	return s
}

type fadeRig struct {
	l  Loop
	fx *fakeFx
	p  *seqProber
	st State
}

func newFadeRig(t *testing.T, first Snapshot) *fadeRig {
	l, fx := newLoop(t, first)
	return &fadeRig{l: l, fx: fx, p: l.Prober.(*seqProber)}
}

// run ticks n times, one minute apart (the hotspot cadence), all with snapshot s.
func (r *fadeRig) run(n int, s Snapshot) {
	r.p.snaps = []Snapshot{s}
	for i := 0; i < n; i++ {
		r.fx.now = r.fx.now.Add(time.Minute)
		r.st = r.l.Tick(context.Background())
	}
}

func (r *fadeRig) texts() int {
	n := 0
	for _, title := range r.fx.notes {
		if title == fadeTitle {
			n++
		}
	}
	return n
}

func (r *fadeRig) status() string { return statusLine(r.st, r.fx.now) }

func TestFadeAlertTable(t *testing.T) {
	cases := []struct {
		name       string
		sig        *WiFiSignal
		rttMs      int
		via        string // "" = the link check is not available
		noAlert    bool   // config "fading_alert": "off"
		wantLow    bool
		wantTexts  int
		wantStatus bool
	}{
		{name: "weak Wi-Fi enters the low state: exactly one text", sig: weakSig, rttMs: 80, via: "wifi", wantLow: true, wantTexts: 1, wantStatus: true},
		{name: "link check unavailable, signal measured and weak: one text", sig: weakSig, rttMs: 80, wantLow: true, wantTexts: 1, wantStatus: true},
		{name: "traffic on the phone's USB cable: silent", sig: weakSig, rttMs: 80, via: "usb", wantLow: true},
		{name: "traffic on Ethernet: silent", sig: weakSig, rttMs: 80, via: "ethernet", wantLow: true},
		{name: "signal not measured, link slow: silent", sig: nil, rttMs: 2000, via: "wifi", wantLow: true},
		{name: "signal strong, link slow (not a range problem): silent", sig: strongSig, rttMs: 2000, via: "wifi", wantLow: true},
		{name: "turned off in config: status only", sig: weakSig, rttMs: 80, via: "wifi", noAlert: true, wantLow: true, wantStatus: true},
		{name: "healthy link: nothing", sig: strongSig, rttMs: 80, via: "wifi"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			snap := wifiSnap(t, c.sig, c.rttMs)
			r := newFadeRig(t, snap)
			r.l.NoFadeAlert = c.noAlert
			if c.via != "" {
				r.l.Link = func(context.Context, bool) LinkVia { return LinkVia{Via: c.via} }
			}
			r.run(12, snap)
			if r.st.Low.On != c.wantLow {
				t.Fatalf("low-signal mode = %v, want %v", r.st.Low.On, c.wantLow)
			}
			if got := r.texts(); got != c.wantTexts {
				t.Errorf("texts = %d (%v), want %d", got, r.fx.notes, c.wantTexts)
			}
			if got := strings.Contains(r.status(), "Wi-Fi is fading"); got != c.wantStatus {
				t.Errorf("status %q: fading line = %v, want %v", r.status(), got, c.wantStatus)
			}
			if got := r.status(); strings.Contains(got, "back to normal") {
				t.Errorf("status %q says back to normal while nothing cleared", got)
			}
		})
	}
}

func TestFadeAlertWaitsForTheDetectorAndSaysWhatItMeasured(t *testing.T) {
	snap := wifiSnap(t, weakSig, 80)
	r := newFadeRig(t, snap)
	r.run(lowEnterBad-1, snap)
	if r.st.Low.On || r.texts() != 0 {
		t.Fatalf("texted before the detector entered the low state: low=%v notes=%v", r.st.Low.On, r.fx.notes)
	}
	r.run(1, snap) // third bad probe: the detector enters
	if !r.st.Low.On || r.texts() != 0 {
		t.Fatalf("on entry: low=%v texts=%d, want low and no text until it has lasted %s", r.st.Low.On, r.texts(), fadeAfter)
	}
	r.run(2, snap)
	if r.texts() != 1 {
		t.Fatalf("texts = %d after %s in the low state, want 1", r.texts(), fadeAfter)
	}
	msg := r.fx.msgs[len(r.fx.msgs)-1]
	for _, want := range []string{"SNR 7 dB", "-88 dBm", "poor", "may drop", "Move closer", "USB cable"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q lacks %q", msg, want)
		}
	}
	// Tied to the network, and no fix credited.
	var fading []Incident
	for _, in := range r.l.Store.Incidents() {
		if in.Event == "fading" {
			fading = append(fading, in)
		}
		if in.Fix != "" {
			t.Errorf("a fix was credited: %+v", in)
		}
	}
	if len(fading) != 1 || fading[0].Fingerprint == "" || fading[0].Fingerprint != r.st.Fingerprint {
		t.Errorf("fading incidents %+v, want one on network %s", fading, r.st.Fingerprint)
	}
	if n := r.st.Networks[r.st.Fingerprint]; len(n.Fixes) != 0 || len(n.Recover) != 0 {
		t.Errorf("the network learned something from a fade: %+v", n)
	}
}

func TestFadeAlertUsesTheWiredLinkAdviceWhenThereIsOne(t *testing.T) {
	snap := wifiSnap(t, weakSig, 80)
	r := newFadeRig(t, snap)
	r.l.Link = func(_ context.Context, low bool) LinkVia {
		return chooseLink([]HWPort{{"Wi-Fi", "en0"}, {"iPhone USB", "en7"}}, "en0", func(string) bool { return true }, low)
	}
	r.run(6, snap)
	if r.texts() != 1 {
		t.Fatalf("texts = %d, want 1", r.texts())
	}
	if msg := r.fx.msgs[len(r.fx.msgs)-1]; !strings.Contains(msg, "Service Order") || strings.Contains(msg, "holds better") {
		t.Errorf("message %q should carry the existing wired-link advice instead of the generic cable hint", msg)
	}
}

func TestFadeAlertDoesNotRepeatInsideTheInterval(t *testing.T) {
	snap := wifiSnap(t, weakSig, 80)
	r := newFadeRig(t, snap)
	r.run(5, snap)
	if r.texts() != 1 {
		t.Fatalf("texts = %d, want 1", r.texts())
	}
	r.run(119, snap) // 1 h 59 min after the text
	if r.texts() != 1 {
		t.Fatalf("texts = %d inside %s, want 1", r.texts(), fadeRemindEvery)
	}
	r.run(2, snap)
	if r.texts() != 2 {
		t.Fatalf("texts = %d after %s still fading, want 2 (at most every 2 h)", r.texts(), fadeRemindEvery)
	}
}

func TestFadeClearsQuietlyWithOneStatusLine(t *testing.T) {
	weak, good := wifiSnap(t, weakSig, 80), wifiSnap(t, strongSig, 80)
	r := newFadeRig(t, weak)
	r.run(6, weak)
	if r.texts() != 1 || !strings.Contains(r.status(), "Wi-Fi is fading") {
		t.Fatalf("setup: texts=%d status=%q", r.texts(), r.status())
	}
	notes := len(r.fx.notes)
	r.run(9, good) // signal is fine again, but the detector has not left yet (hysteresis)
	if !r.st.Low.On || strings.Contains(r.status(), "back to normal") || strings.Contains(r.status(), "Wi-Fi is fading") {
		t.Fatalf("in the hysteresis window: low=%v status=%q, want low-signal mode and neither line yet", r.st.Low.On, r.status())
	}
	r.run(6, good) // 10 good probes and 15 minutes: the detector leaves
	if r.st.Low.On {
		t.Fatal("detector still in the low state")
	}
	if len(r.fx.notes) != notes || len(r.fx.relayed) != 0 {
		t.Fatalf("recovery sent something: %v %v", r.fx.notes[notes:], r.fx.relayed)
	}
	got := r.status()
	if strings.Contains(got, "Wi-Fi is fading") || strings.Count(got, "Wi-Fi signal back to normal since") != 1 {
		t.Fatalf("status %q, want one back-to-normal line and no fading line", got)
	}
	var events []string
	for _, in := range r.l.Store.Incidents() {
		events = append(events, in.Event)
		if in.Fix != "" {
			t.Errorf("a fix was credited for a recovery nobody caused: %+v", in)
		}
	}
	if strings.Join(events, ",") != "fading,fading-cleared" {
		t.Errorf("incidents %v, want fading then fading-cleared", events)
	}
	r.run(int(fadeClearedShow/time.Minute)+1, good)
	if got := r.status(); strings.Contains(got, "back to normal") || strings.Contains(got, "fading") {
		t.Fatalf("status %q still talks about the fade %s later", got, fadeClearedShow)
	}
	if len(r.fx.notes) != notes {
		t.Fatalf("texts after recovery: %v", r.fx.notes[notes:])
	}
}

func TestFadeFlappingDoesNotStorm(t *testing.T) {
	weak, good := wifiSnap(t, weakSig, 80), wifiSnap(t, strongSig, 80)
	// Around the threshold: one probe just weak, one just fine, for 6 hours. The link
	// itself stays slow, so the detector stays in the low state throughout.
	edgeWeak, edgeOK := wifiSnap(t, &WiFiSignal{RSSI: -76, Noise: -95}, 2000), wifiSnap(t, &WiFiSignal{RSSI: -60, Noise: -95}, 2000)
	for name, pattern := range map[string][]Snapshot{
		"3 bad, 2 good":                {weak, weak, weak, good, good},
		"signal on the threshold":      {edgeWeak, edgeOK},
		"5 bad, 9 good (never leaves)": {weak, weak, weak, weak, weak, good, good, good, good, good, good, good, good, good},
	} {
		t.Run(name, func(t *testing.T) {
			r := newFadeRig(t, weak)
			for i := 0; i < 6*60; i++ {
				r.run(1, pattern[i%len(pattern)])
			}
			// 6 hours at "at most every 2 h" is 3 texts, however often it flaps.
			if got := r.texts(); got < 1 || got > 3 {
				t.Fatalf("texts = %d over 6 h of flapping, want 1 to 3", got)
			}
		})
	}
}

func TestFadeFlappingThatLeavesAndReentersStaysUnderTheLimit(t *testing.T) {
	weak, good := wifiSnap(t, weakSig, 80), wifiSnap(t, strongSig, 80)
	r := newFadeRig(t, weak)
	for i := 0; i < 8; i++ { // 6 min weak, 20 min good: every cycle enters and leaves the low state
		r.run(6, weak)
		r.run(20, good)
	}
	// 8 cycles of 26 min = 3 h 28 min: at most 2 texts for this network.
	if got := r.texts(); got < 1 || got > 2 {
		t.Fatalf("texts = %d over 8 enter/leave cycles in 3.5 h, want 1 or 2", got)
	}
}

func TestFadeNeverTextsWhileOffline(t *testing.T) {
	weak := wifiSnap(t, weakSig, 80)
	r := newFadeRig(t, weak)
	r.run(lowEnterBad, weak) // in the low state, not yet texted
	off := fixture(t, "offline.json")
	off.WiFiSec, off.Signal, off.GatewayMAC = "WPA2_PSK", weakSig, weak.GatewayMAC
	r.run(10, off)
	if r.st.Class != Offline {
		t.Fatalf("class = %s, want OFFLINE", r.st.Class)
	}
	if r.texts() != 0 {
		t.Fatalf("a fading text was raised from an offline Mac: %v", r.fx.notes)
	}
	if strings.Contains(r.status(), "Wi-Fi is fading") {
		t.Fatalf("status %q", r.status())
	}
}

func TestFadeIsPerNetwork(t *testing.T) {
	a := wifiSnap(t, weakSig, 80)
	b := wifiSnap(t, weakSig, 80)
	b.GatewayMAC, b.Gateway, b.PublicIP = "02:00:00:00:00:02", "10.9.8.1", "203.0.113.77"
	r := newFadeRig(t, a)
	r.run(6, a)
	r.run(6, b)
	r.run(6, a) // back on the first network inside its 2 h: no third text
	if r.texts() != 2 {
		t.Fatalf("texts = %d, want one per network (2)", r.texts())
	}
}

func TestWeakWiFiSignal(t *testing.T) {
	for _, c := range []struct {
		sig  *WiFiSignal
		snr  int
		weak bool
	}{
		{nil, 0, false},
		{&WiFiSignal{RSSI: -50, Noise: -95}, 45, false},
		{&WiFiSignal{RSSI: -70, Noise: -95}, 25, false},
		{&WiFiSignal{RSSI: -71, Noise: -95}, 24, true},  // "fair": drops likely
		{&WiFiSignal{RSSI: -75, Noise: -101}, 26, true}, // RSSI at the detector's edge
		{&WiFiSignal{RSSI: -88, Noise: -95}, 7, true},
	} {
		if snr, weak := weakWiFiSignal(c.sig); snr != c.snr || weak != c.weak {
			t.Errorf("weakWiFiSignal(%+v) = %d, %v; want %d, %v", c.sig, snr, weak, c.snr, c.weak)
		}
	}
}

// ---- laptops off the tailnet ----

type peerSpec struct {
	name, os string
	user     int
	online   bool
	off      time.Duration // offline for this long; 0 with !online = never seen
}

func tailnetJSON(now time.Time, selfOnline bool, peers ...peerSpec) []byte {
	var b strings.Builder
	fmt.Fprintf(&b, `{"Self":{"HostName":"judith","OS":"macOS","Online":%v,"UserID":7},"Peer":{`, selfOnline)
	for i, p := range peers {
		if i > 0 {
			b.WriteString(",")
		}
		seen := ""
		if p.off > 0 {
			seen = fmt.Sprintf(`,"LastSeen":%q`, now.Add(-p.off).Format(time.RFC3339))
		}
		fmt.Fprintf(&b, `"k%d":{"HostName":%q,"DNSName":%q,"OS":%q,"Online":%v,"UserID":%d%s}`, i, p.name, p.name+".tail0.ts.net.", p.os, p.online, p.user, seen)
	}
	b.WriteString("}}")
	return []byte(b.String())
}

type sentText struct{ title, msg string }

type deviceRig struct {
	s    Store
	now  time.Time
	sent []sentText
}

func newDeviceRig(t *testing.T) *deviceRig {
	return &deviceRig{s: Store{Dir: t.TempDir()}, now: time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)}
}

func (d *deviceRig) round(names []string, laptops, selfOnline bool, peers ...peerSpec) []string {
	return deviceRound(tailnetJSON(d.now, selfOnline, peers...), names, laptops, d.s, func(title, msg string) {
		d.sent = append(d.sent, sentText{title, msg})
	}, d.now)
}

func (d *deviceRig) titles() string {
	var out []string
	for _, s := range d.sent {
		out = append(out, s.title)
	}
	return strings.Join(out, " | ")
}

func TestLaptopOfflineThresholdTable(t *testing.T) {
	for _, c := range []struct {
		name   string
		peer   peerSpec
		names  []string
		noLap  bool
		wantN  int
		wantIn string // in the title
	}{
		{name: "9 min: silent", peer: peerSpec{"talos", "linux", 7, false, 9 * time.Minute}},
		{name: "10 min: one text", peer: peerSpec{"talos", "linux", 7, false, 10 * time.Minute}, wantN: 1, wantIn: "talos is out of reach"},
		{name: "a Mac counts too", peer: peerSpec{"judith-2", "macOS", 7, false, 12 * time.Minute}, wantN: 1, wantIn: "judith-2 is out of reach"},
		{name: "online: silent", peer: peerSpec{"talos", "linux", 7, true, 0}},
		{name: "someone else's laptop: not watched", peer: peerSpec{"merve-mac", "macOS", 9, false, 40 * time.Minute}},
		{name: "gone for days and never named: silent", peer: peerSpec{"old-box", "linux", 7, false, 17 * 24 * time.Hour}},
		{name: "never seen and never named: silent", peer: peerSpec{"new-box", "linux", 7, false, 0}},
		{name: "a TV is not a laptop", peer: peerSpec{"appletv", "tvOS", 7, false, 40 * time.Minute}},
		{name: "named server of another owner: watched", peer: peerSpec{"relay-1", "linux", 99, false, 11 * time.Minute}, names: []string{"relay-1"}, wantN: 1, wantIn: "relay-1 is out of reach"},
		{name: "named and gone for days: still one text", peer: peerSpec{"talos", "linux", 7, false, 17 * 24 * time.Hour}, names: []string{"Talos"}, wantN: 1, wantIn: "talos is out of reach"},
		{name: "named but 9 min: silent", peer: peerSpec{"talos", "linux", 7, false, 9 * time.Minute}, names: []string{"talos"}},
		{name: "turned off: laptops not watched", peer: peerSpec{"talos", "linux", 7, false, 40 * time.Minute}, noLap: true},
		{name: "turned off, named, 20 min: silent as before", peer: peerSpec{"talos", "linux", 7, false, 20 * time.Minute}, names: []string{"talos"}, noLap: true},
		{name: "turned off, named, 40 min: the old text", peer: peerSpec{"talos", "linux", 7, false, 40 * time.Minute}, names: []string{"talos"}, noLap: true, wantN: 1, wantIn: "talos offline"},
	} {
		t.Run(c.name, func(t *testing.T) {
			d := newDeviceRig(t)
			d.round(c.names, !c.noLap, true, c.peer)
			if len(d.sent) != c.wantN || (c.wantN > 0 && !strings.Contains(d.sent[0].title, c.wantIn)) {
				t.Fatalf("sent %q, want %d containing %q", d.titles(), c.wantN, c.wantIn)
			}
		})
	}
}

func TestLaptopOneTextPerOutageAndAgainNextOutage(t *testing.T) {
	d := newDeviceRig(t)
	off := func(dur time.Duration) peerSpec { return peerSpec{"talos", "linux", 7, false, dur} }
	on := peerSpec{"talos", "linux", 7, true, 0}

	d.round(nil, true, true, off(9*time.Minute))
	if len(d.sent) != 0 || rangeStatus(d.s, d.now) != "" {
		t.Fatalf("9 min: sent %q status %q", d.titles(), rangeStatus(d.s, d.now))
	}
	d.now = d.now.Add(time.Minute)
	lines := d.round(nil, true, true, off(10*time.Minute))
	if len(d.sent) != 1 || len(lines) != 1 {
		t.Fatalf("10 min: sent %q lines %v", d.titles(), lines)
	}
	msg := d.sent[0].msg
	since := d.now.Add(-10 * time.Minute).Local().Format("15:04")
	for _, want := range []string{"talos", "since " + since, "10 min", "out of Wi-Fi range", "One text per outage"} {
		if !strings.Contains(msg, want) {
			t.Errorf("message %q lacks %q", msg, want)
		}
	}
	if got := rangeStatus(d.s, d.now); !strings.Contains(got, "talos is off the tailnet (10 min)") {
		t.Errorf("status %q", got)
	}
	// Still off for 9 more hours, checked every 5 min: nothing more.
	for i := 1; i <= 108; i++ {
		d.now = d.now.Add(5 * time.Minute)
		d.round(nil, true, true, off(10*time.Minute+time.Duration(i)*5*time.Minute))
	}
	if len(d.sent) != 1 {
		t.Fatalf("same outage texted %d times: %q", len(d.sent), d.titles())
	}
	// Back online: no text, status clears.
	d.now = d.now.Add(5 * time.Minute)
	if lines := d.round(nil, true, true, on); len(lines) != 0 || len(d.sent) != 1 || rangeStatus(d.s, d.now) != "" {
		t.Fatalf("back online: lines %v sent %q status %q", lines, d.titles(), rangeStatus(d.s, d.now))
	}
	// The next outage texts again.
	d.now = d.now.Add(time.Hour)
	d.round(nil, true, true, off(15*time.Minute))
	if len(d.sent) != 2 {
		t.Fatalf("next outage: sent %d (%q), want 2", len(d.sent), d.titles())
	}
}

func TestLaptopFlappingAtTheEdgeOfRangeIsRateLimited(t *testing.T) {
	d := newDeviceRig(t)
	off, on := peerSpec{"talos", "linux", 7, false, 11 * time.Minute}, peerSpec{"talos", "linux", 7, true, 0}
	for i := 0; i < 18; i++ { // 6 hours: off at one check, back at the next, 20 min a cycle
		d.round(nil, true, true, off)
		d.now = d.now.Add(10 * time.Minute)
		d.round(nil, true, true, on)
		d.now = d.now.Add(10 * time.Minute)
	}
	if got := len(d.sent); got != 3 {
		t.Fatalf("texts = %d over 6 h of flapping, want 3 (at most every 2 h): %q", got, d.titles())
	}
	// An outage that began inside the limit and lasts is still told once the limit has passed.
	d2 := newDeviceRig(t)
	d2.round(nil, true, true, off)
	d2.now = d2.now.Add(10 * time.Minute)
	d2.round(nil, true, true, on)
	for i := 0; i < 30; i++ { // off again 20 min later and stays off for 2.5 h
		d2.now = d2.now.Add(5 * time.Minute)
		d2.round(nil, true, true, peerSpec{"talos", "linux", 7, false, 10*time.Minute + time.Duration(i)*5*time.Minute})
	}
	if got := len(d2.sent); got != 2 {
		t.Fatalf("texts = %d, want 2: %q", got, d2.titles())
	}
}

func TestLaptopNothingIsJudgedWhileThisMacIsOffTheTailnet(t *testing.T) {
	d := newDeviceRig(t)
	off := peerSpec{"talos", "linux", 7, false, 12 * time.Minute}
	d.round(nil, true, true, off)
	d.now = d.now.Add(5 * time.Minute)
	if lines := d.round(nil, true, false, off); lines != nil || len(d.sent) != 1 {
		t.Fatalf("this Mac off the tailnet: lines %v sent %q", lines, d.titles())
	}
	if lines := deviceRound([]byte("not json"), nil, true, d.s, func(string, string) { t.Error("texted on bad input") }, d.now); lines != nil {
		t.Fatalf("bad input gave %v", lines)
	}
	// Back on the tailnet 3 h later, the same outage is not texted again.
	d.now = d.now.Add(3 * time.Hour)
	d.round(nil, true, true, peerSpec{"talos", "linux", 7, false, 3*time.Hour + 17*time.Minute})
	if len(d.sent) != 1 {
		t.Fatalf("the same outage was texted again after this Mac rejoined: %q", d.titles())
	}
}

func TestPhoneBehaviourUnchangedNextToLaptops(t *testing.T) {
	d := newDeviceRig(t)
	phone := func(dur time.Duration) peerSpec { return peerSpec{"iphone-13", "iOS", 7, false, dur} }
	d.round(nil, true, true, phone(29*time.Minute), peerSpec{"pixel", "android", 7, false, 12 * time.Minute})
	if len(d.sent) != 0 {
		t.Fatalf("a phone was texted before %s: %q", deviceOfflineAfter, d.titles())
	}
	d.now = d.now.Add(time.Minute)
	lines := d.round(nil, true, true, phone(30*time.Minute))
	if len(d.sent) != 1 || d.sent[0].title != "Argo: iphone-13 offline" || !strings.Contains(d.sent[0].msg, "Connect On Demand") || len(lines) != 1 {
		t.Fatalf("phone text %+v lines %v", d.sent, lines)
	}
	if rangeStatus(d.s, d.now) != "" {
		t.Errorf("a phone showed up in the laptop status line: %q", rangeStatus(d.s, d.now))
	}
	d.now = d.now.Add(5*time.Hour + 59*time.Minute)
	d.round(nil, true, true, phone(6*time.Hour+29*time.Minute))
	if len(d.sent) != 1 {
		t.Fatalf("phone reminded inside %s: %q", deviceRemindEvery, d.titles())
	}
	d.now = d.now.Add(time.Minute)
	d.round(nil, true, true, phone(6*time.Hour+30*time.Minute))
	if len(d.sent) != 2 || d.sent[1].title != "Argo: iphone-13 offline" {
		t.Fatalf("phone reminder after %s: %q", deviceRemindEvery, d.titles())
	}
}

func TestArgoDevicesListsWithoutTextingOrWriting(t *testing.T) {
	d := newDeviceRig(t)
	lines := deviceRound(tailnetJSON(d.now, true, peerSpec{"talos", "linux", 7, false, 12 * time.Minute}), nil, true, d.s, nil, d.now)
	if len(lines) != 1 || !strings.Contains(lines[0], "talos") {
		t.Fatalf("lines %v", lines)
	}
	if entries, _ := os.ReadDir(d.s.Dir); len(entries) != 0 {
		t.Fatalf("`argo devices` wrote state: %v", entries)
	}
}

func TestLaptopNamesAreCleanedAndStateIsPrivateAndBounded(t *testing.T) {
	d := newDeviceRig(t)
	raw := []byte(fmt.Sprintf(`{"Self":{"Online":true,"UserID":7},"Peer":{"x":{"HostName":"ta los\n$(rm -rf ~)/../x","OS":"linux","Online":false,"UserID":7,"LastSeen":%q}}}`,
		d.now.Add(-15*time.Minute).Format(time.RFC3339)))
	deviceRound(raw, nil, true, d.s, func(title, msg string) { d.sent = append(d.sent, sentText{title, msg}) }, d.now)
	if len(d.sent) != 1 || d.sent[0].title != "Argo: talosrm-rf..x is out of reach" || strings.ContainsAny(d.sent[0].msg, "\n$/~") {
		t.Fatalf("sent %+v", d.sent)
	}
	fi, err := os.Stat(d.s.path("devices-range.json"))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("state file: %v %v", fi, err)
	}
	// More offline computers than the cap: the file stays bounded.
	var many []peerSpec
	for i := 0; i < maxRangeDevices+20; i++ {
		many = append(many, peerSpec{fmt.Sprintf("box-%03d", i), "linux", 7, false, 11 * time.Minute})
	}
	d2 := newDeviceRig(t)
	d2.round(nil, true, true, many...)
	if n := len(loadRange(d2.s).Off); n != maxRangeDevices || len(d2.sent) != maxRangeDevices {
		t.Fatalf("kept %d entries and sent %d, want the cap %d", n, len(d2.sent), maxRangeDevices)
	}
}

func TestRangeStatusGoesQuietWhenStale(t *testing.T) {
	d := newDeviceRig(t)
	d.round(nil, true, true, peerSpec{"talos", "linux", 7, false, 12 * time.Minute})
	if rangeStatus(d.s, d.now.Add(laptopStatusFresh)) == "" {
		t.Fatal("status empty inside the fresh window")
	}
	if got := rangeStatus(d.s, d.now.Add(laptopStatusFresh+time.Minute)); got != "" {
		t.Fatalf("stale status still shown: %q", got)
	}
}
