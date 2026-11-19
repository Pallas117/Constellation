package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// The scan from 2026-10-23 on the iPhone hotspot (names replaced): 2.4 GHz ch10 at
// 20 MHz with neighbours on ch2/3/6/8/10, two of them 40 MHz; 5 GHz much quieter.
const hotspotScan = `Wi-Fi:
      Interfaces:
        en0:
          Current Network Information:
            Phone:
              PHY Mode: 802.11ax
              Channel: 10 (2GHz, 20MHz)
              Security: WPA2 Personal
              Signal / Noise: -35 dBm / -98 dBm
              Transmit Rate: 114
              MCS Index: 9
          Other Local Wi-Fi Networks:
            A:
              Channel: 2 (2GHz, 20MHz)
            B:
              Channel: 2 (2GHz, 40MHz)
            C:
              Channel: 3 (2GHz, 40MHz)
            D:
              Channel: 6 (2GHz, 20MHz)
            E:
              Channel: 8 (2GHz, 20MHz)
            F:
              Channel: 10 (2GHz, 20MHz)
            G:
              Channel: 40 (5GHz, 160MHz)
            H:
              Channel: 149 (5GHz, 80MHz)
`

func TestParseRadioHotspot(t *testing.T) {
	r := parseRadio(hotspotScan)
	if r == nil {
		t.Fatal("no radio parsed")
	}
	if r.Band != "2.4" || r.Channel != 10 || r.WidthMHz != 20 || r.PHY != "ax" || r.MCS != 9 || r.TxMbps != 114 {
		t.Fatalf("current link: %+v", r)
	}
	// Overlapping ch10/20 MHz (2447-2467): ch6 (2427-2447 touches, no), ch8, ch10, and the 40 MHz
	// ones on ch3 (2392-2452) and ch2 (2387-2447, touches, no). ch2/20 MHz is clear.
	if r.CoChannel != 1 || r.Overlapping != 3 {
		t.Fatalf("congestion: co=%d overlapping=%d", r.CoChannel, r.Overlapping)
	}
	if r.BandCounts["2.4"] != 6 || r.BandCounts["5"] != 2 {
		t.Fatalf("band counts: %v", r.BandCounts)
	}
	if b, _ := json.Marshal(r); strings.Contains(strings.ToLower(string(b)+radioLine(r, nil)), "phone") {
		t.Fatal("a network name leaked into the radio profile")
	}
}

func TestSpanAlignedBlocks(t *testing.T) {
	cases := []struct {
		c      channelInfo
		lo, hi int
	}{
		{channelInfo{"5", 36, 20}, 5170, 5190},
		{channelInfo{"5", 40, 160}, 5170, 5330},
		{channelInfo{"5", 100, 160}, 5490, 5650},
		{channelInfo{"5", 149, 80}, 5735, 5815},
		{channelInfo{"6", 1, 20}, 5945, 5965},
		{channelInfo{"6", 37, 160}, 6105, 6265},
		{channelInfo{"2.4", 1, 20}, 2402, 2422},
		{channelInfo{"2.4", 14, 20}, 2474, 2494},
	}
	for _, c := range cases {
		if lo, hi := span(c.c); lo != c.lo || hi != c.hi {
			t.Errorf("%+v: got %d-%d want %d-%d", c.c, lo, hi, c.lo, c.hi)
		}
	}
	if overlaps(channelInfo{"5", 36, 20}, channelInfo{"5", 44, 20}) {
		t.Error("ch36 and ch44 at 20 MHz don't overlap")
	}
	if !overlaps(channelInfo{"5", 36, 20}, channelInfo{"5", 48, 80}) {
		t.Error("ch36/20 sits inside the ch36-48 80 MHz block")
	}
	if overlaps(channelInfo{"2.4", 6, 20}, channelInfo{"5", 6, 20}) {
		t.Error("different bands never overlap")
	}
}

func TestParseRadioMissing(t *testing.T) {
	if parseRadio("") != nil || parseRadio(profilerOut) != nil {
		t.Fatal("no Channel line: no radio")
	}
	r := parseRadio("Current Network Information:\n  Channel: 149 (5GHz, 80MHz)\n")
	if r == nil || r.MCS != -1 || r.TxMbps != 0 || r.PHY != "" || r.Overlapping != 0 {
		t.Fatalf("missing fields must read as unknown: %+v", r)
	}
	if parseRadio("Current Network Information:\n  Channel: 3 (9GHz, 20MHz)\n") != nil {
		t.Fatal("unknown band accepted")
	}
}

const pingMac = `PING 1.1.1.1 (1.1.1.1): 56 data bytes
64 bytes from 1.1.1.1: icmp_seq=0 ttl=56 time=40.0 ms
64 bytes from 1.1.1.1: icmp_seq=1 ttl=56 time=30.0 ms
64 bytes from 1.1.1.1: icmp_seq=3 ttl=56 time=50.0 ms

--- 1.1.1.1 ping statistics ---
5 packets transmitted, 3 packets received, 40.0% packet loss
`

const pingLinux = `64 bytes from 192.168.1.1: icmp_seq=1 ttl=64 time=2.10 ms
64 bytes from 192.168.1.1: icmp_seq=2 ttl=64 time=1.90 ms
--- 192.168.1.1 ping statistics ---
2 packets transmitted, 2 received, 0% packet loss, time 201ms
`

func TestParsePing(t *testing.T) {
	loss, jit, rtt, ok := parsePing(pingMac)
	if !ok || loss != 40 || jit != 15 || rtt != 40 {
		t.Fatalf("mac: loss=%d jitter=%d rtt=%d ok=%v", loss, jit, rtt, ok)
	}
	loss, jit, rtt, ok = parsePing(pingLinux)
	if !ok || loss != 0 || jit != 0 || rtt != 2 {
		t.Fatalf("linux: loss=%d jitter=%d rtt=%d ok=%v", loss, jit, rtt, ok)
	}
	if _, _, _, ok := parsePing("ping: command not found"); ok {
		t.Fatal("no summary must not count as measured")
	}
}

func ping(sent, recv int, times ...string) string {
	var b strings.Builder
	for _, t := range times {
		b.WriteString("64 bytes: time=" + t + " ms\n")
	}
	fmt.Fprintf(&b, "%d packets transmitted, %d packets received\n", sent, recv)
	return b.String()
}

func TestJudgeLink(t *testing.T) {
	clean := ping(5, 5, "5", "6", "5", "6", "5")
	cases := []struct {
		name, gw, net, path string
	}{
		{"all good", clean, ping(5, 5, "40", "42", "41", "40", "42"), "ok"},
		{"upstream loss (2026-10-23)", clean, ping(5, 3, "500", "900", "1500"), "upstream"},
		{"Wi-Fi hop lossy", ping(5, 3, "5", "90", "6"), ping(5, 3, "50", "140", "60"), "local"},
		{"gateway drops ICMP, net fine", ping(5, 0), ping(5, 5, "40", "41", "40", "42", "41"), "ok"},
		{"gateway drops ICMP, net bad", ping(5, 0), ping(5, 2, "800", "900"), notMeasured},
	}
	for _, c := range cases {
		q := judgeLink(c.gw, c.net)
		if q == nil || q.Path != c.path {
			t.Errorf("%s: %+v", c.name, q)
		}
	}
	if judgeLink(clean, "") != nil {
		t.Error("no internet ping: no reading")
	}
}

func TestRadioAdvice(t *testing.T) {
	sig := parseSignal(hotspotScan)
	s := Snapshot{Online: true, Gateway: "172.20.10.1", WiFiSec: "WPA2_PSK", Signal: sig,
		Link: judgeLink(ping(5, 5, "5", "6", "5", "6", "5"), ping(5, 3, "500", "900", "1500"))}
	a := strings.Join(RadioAdvice(s), "\n")
	if !strings.Contains(a, "Maximize Compatibility") || !strings.Contains(a, "upstream") {
		t.Fatalf("hotspot advice missing: %q", a)
	}
	s.Gateway = "192.168.1.1"
	if a := strings.Join(RadioAdvice(s), "\n"); strings.Contains(a, "Maximize") || !strings.Contains(a, "5 GHz band") {
		t.Fatalf("non-hotspot advice: %q", a)
	}
	quiet := Snapshot{Online: true, WiFiSec: "WPA2_PSK", Signal: &WiFiSignal{RSSI: -50, Noise: -95, Radio: &Radio{Band: "5", Channel: 149, WidthMHz: 80}}}
	if a := RadioAdvice(quiet); len(a) != 0 {
		t.Fatalf("a healthy 5 GHz link needs no advice: %v", a)
	}
	weak := Snapshot{Online: true, WiFiSec: "WPA2_PSK", Signal: &WiFiSignal{RSSI: -82, Noise: -95}}
	if a := strings.Join(RadioAdvice(weak), ""); !strings.Contains(a, "Weak Wi-Fi (SNR 13 dB)") {
		t.Fatalf("weak signal advice: %q", a)
	}
}

func TestRadioReportNamesNothing(t *testing.T) {
	r := parseRadio(hotspotScan)
	q := judgeLink(ping(5, 5, "5", "6"), ping(5, 4, "40", "60"))
	m := radioReport(r, q)
	for _, k := range []string{"band", "channel", "widthMHz", "coChannel", "overlapping", "phy", "mcs", "txMbps", "netLossPct", "netJitterMs", "netRttMs", "path", "gwLossPct", "gwJitterMs"} {
		if _, ok := m[k]; !ok {
			t.Errorf("missing %s", k)
		}
	}
	if len(m) != 14 {
		t.Errorf("unexpected keys: %v", m)
	}
	if radioReport(nil, nil) != nil {
		t.Error("nothing measured: no block")
	}
	n := ScoreNet(Snapshot{Online: true, WiFiSec: "WPA2_PSK", Gateway: "172.20.10.1", Signal: parseSignal(hotspotScan), Link: q})
	if !strings.Contains(n.Line(), "Wi-Fi 2.4 GHz ch10/20 MHz ax, 3 overlapping") || netReport(n)["radio"] == nil {
		t.Fatalf("line/report: %s %v", n.Line(), netReport(n))
	}
}
