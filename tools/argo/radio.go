package main

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// Radio profile and link quality (GAU-188). What we had to find by hand on
// 2026-10-23: the iPhone hotspot sat on 2.4 GHz channel 10 with 8 overlapping
// networks while 5 GHz was nearly empty, and the Wi-Fi link was fine while the
// cellular side lost a third of its packets.
//
//   Radio  the current link's band, channel, width, PHY, MCS and tx rate, plus how
//          many nearby networks share or overlap its channel. Read from the same
//          system_profiler output as the signal (passive: macOS's own scan list,
//          nothing transmitted). Neighbours are counted, never named: no SSID or
//          BSSID is kept or reported.
//   Link   a short ping series to the gateway and to 1.1.1.1. A clean gateway with
//          a lossy internet means the problem is upstream (cellular/ISP), not Wi-Fi.

// Radio describes the current Wi-Fi link and its neighbourhood.
type Radio struct {
	Band        string         `json:"band"` // "2.4", "5" or "6" (GHz)
	Channel     int            `json:"channel"`
	WidthMHz    int            `json:"width_mhz"`
	PHY         string         `json:"phy,omitempty"` // e.g. "ax"
	MCS         int            `json:"mcs"`           // -1 not reported
	TxMbps      int            `json:"tx_mbps"`       // 0 not reported
	CoChannel   int            `json:"co_channel"`    // neighbours on our primary channel
	Overlapping int            `json:"overlapping"`   // neighbours whose spectrum overlaps ours (includes co-channel)
	BandCounts  map[string]int `json:"band_counts,omitempty"`
}

var (
	reChannel = regexp.MustCompile(`Channel:\s*(\d+)\s*\((\d+)GHz,\s*(\d+)MHz\)`)
	rePHY     = regexp.MustCompile(`PHY Mode:\s*802\.11([a-z]+)`)
	reMCS     = regexp.MustCompile(`MCS Index:\s*(\d+)`)
	reTx      = regexp.MustCompile(`Transmit Rate:\s*(\d+)`)
)

type channelInfo struct {
	band    string
	channel int
	width   int
}

func parseChannel(s string) (channelInfo, bool) {
	m := reChannel.FindStringSubmatch(s)
	if m == nil {
		return channelInfo{}, false
	}
	ch, _ := strconv.Atoi(m[1])
	w, _ := strconv.Atoi(m[3])
	band := map[string]string{"2": "2.4", "5": "5", "6": "6"}[m[2]]
	if band == "" || ch <= 0 || w <= 0 {
		return channelInfo{}, false
	}
	return channelInfo{band, ch, w}, true
}

// span is the slice of spectrum (MHz) a network occupies. macOS reports only the
// primary channel, so on 2.4 GHz a 40 MHz network is assumed to extend either way
// (conservative); on 5/6 GHz wide channels sit in fixed, aligned blocks.
func span(c channelInfo) (lo, hi int) {
	switch c.band {
	case "2.4":
		f := 2407 + 5*c.channel
		if c.channel == 14 {
			f = 2484
		}
		if c.width >= 40 {
			return f - 30, f + 30
		}
		return f - 10, f + 10
	case "5", "6":
		f, base := 5000+5*c.channel, 5170
		if c.band == "6" {
			f, base = 5950+5*c.channel, 5945
		} else if c.channel >= 149 {
			base = 5735
		}
		w := c.width
		if w < 20 {
			w = 20
		}
		lo = base + ((f-10-base)/w)*w
		return lo, lo + w
	}
	return 0, 0
}

func overlaps(a, b channelInfo) bool {
	if a.band != b.band {
		return false
	}
	alo, ahi := span(a)
	blo, bhi := span(b)
	return alo < bhi && blo < ahi
}

// parseRadio reads the current link from the "Current Network Information" block
// and only the Channel lines of "Other Local Wi-Fi Networks".
func parseRadio(out string) *Radio {
	i := strings.Index(out, "Current Network Information:")
	if i < 0 {
		return nil
	}
	cur, others := out[i:], ""
	if j := strings.Index(cur, "Other Local Wi-Fi Networks:"); j >= 0 {
		cur, others = cur[:j], cur[j:]
	}
	me, ok := parseChannel(cur)
	if !ok {
		return nil
	}
	r := &Radio{Band: me.band, Channel: me.channel, WidthMHz: me.width, MCS: -1, BandCounts: map[string]int{}}
	if m := rePHY.FindStringSubmatch(cur); m != nil {
		r.PHY = m[1]
	}
	if m := reMCS.FindStringSubmatch(cur); m != nil {
		r.MCS, _ = strconv.Atoi(m[1])
	}
	if m := reTx.FindStringSubmatch(cur); m != nil {
		r.TxMbps, _ = strconv.Atoi(m[1])
	}
	for _, line := range strings.Split(others, "\n") {
		n, ok := parseChannel(line)
		if !ok {
			continue
		}
		r.BandCounts[n.band]++
		if n.band == me.band && n.channel == me.channel {
			r.CoChannel++
		}
		if overlaps(me, n) {
			r.Overlapping++
		}
	}
	return r
}

// LinkQuality is loss and jitter to the gateway (the Wi-Fi hop) and past it.
type LinkQuality struct {
	GwLossPct   int    `json:"gw_loss_pct"`  // -1 not measured (no reply at all: many gateways drop ICMP)
	GwJitterMs  int    `json:"gw_jitter_ms"` // mean absolute difference between successive round trips
	NetLossPct  int    `json:"net_loss_pct"`
	NetJitterMs int    `json:"net_jitter_ms"`
	NetRTTMs    int    `json:"net_rtt_ms"`
	Path        string `json:"path"` // "ok", "local" (the Wi-Fi hop), "upstream" (ISP/cellular) or notMeasured
}

const pingTarget = "1.1.1.1" // anycast, answers ICMP, near every PoP

var (
	rePingSummary = regexp.MustCompile(`(\d+) packets transmitted, (\d+) (?:packets )?received`)
	rePingTime    = regexp.MustCompile(`time[=<]([\d.]+) ?ms`)
)

// parsePing returns loss %, jitter and mean round trip in ms; ok is false when
// the output has no summary (ping missing or killed).
func parsePing(out string) (lossPct, jitterMs, rttMs int, ok bool) {
	m := rePingSummary.FindStringSubmatch(out)
	if m == nil {
		return 0, 0, 0, false
	}
	sent, _ := strconv.Atoi(m[1])
	recv, _ := strconv.Atoi(m[2])
	if sent == 0 {
		return 0, 0, 0, false
	}
	lossPct = (sent - recv) * 100 / sent
	var rtts []float64
	for _, t := range rePingTime.FindAllStringSubmatch(out, -1) {
		if v, err := strconv.ParseFloat(t[1], 64); err == nil {
			rtts = append(rtts, v)
		}
	}
	if len(rtts) > 0 {
		sum, d := 0.0, 0.0
		for i, v := range rtts {
			sum += v
			if i > 0 {
				d += math.Abs(v - rtts[i-1])
			}
		}
		rttMs = int(math.Round(sum / float64(len(rtts))))
		if len(rtts) > 1 {
			jitterMs = int(math.Round(d / float64(len(rtts)-1)))
		}
	}
	return lossPct, jitterMs, rttMs, true
}

// judgeLink names where loss or jitter comes from. Thresholds: 10% loss or 100 ms
// jitter break calls and interactive sessions; 300 ms round trips lag visibly.
func judgeLink(gwOut, netOut string) *LinkQuality {
	nl, nj, nr, nok := parsePing(netOut)
	if !nok {
		return nil
	}
	q := &LinkQuality{GwLossPct: -1, NetLossPct: nl, NetJitterMs: nj, NetRTTMs: nr, Path: "ok"}
	if gl, gj, _, gok := parsePing(gwOut); gok && gl < 100 {
		q.GwLossPct, q.GwJitterMs = gl, gj
	}
	switch {
	case q.GwLossPct >= 20 || q.GwJitterMs >= 50:
		q.Path = "local"
	case nl >= 10 || nj >= 100 || nr >= 300:
		q.Path = "upstream"
		if q.GwLossPct < 0 {
			q.Path = notMeasured // can't tell which hop without the gateway
		}
	}
	return q
}

func measureLink(ctx context.Context, gateway string) *LinkQuality {
	if gateway == "" {
		return nil
	}
	return judgeLink(run(ctx, "ping", pingArgs(gateway)...), run(ctx, "ping", pingArgs(pingTarget)...))
}

// RadioAdvice turns the radio profile and link quality into concrete steps,
// most useful first. It only ever advises: Argo changes no radio settings.
func RadioAdvice(s Snapshot) []string {
	var out []string
	var r *Radio
	if s.Signal != nil {
		r = s.Signal.Radio
	}
	if r != nil && r.Band == "2.4" && r.Overlapping >= 3 {
		if isIPhoneHotspot(s.Gateway) {
			out = append(out, fmt.Sprintf("Hotspot is on crowded 2.4 GHz (ch %d, %d overlapping networks): on the iPhone turn off Personal Hotspot > Maximize Compatibility so it uses 5 GHz.", r.Channel, r.Overlapping))
		} else {
			out = append(out, fmt.Sprintf("On crowded 2.4 GHz (ch %d, %d overlapping networks): join this network's 5 GHz band if it has one.", r.Channel, r.Overlapping))
		}
	}
	if s.Signal != nil && s.Signal.RSSI-s.Signal.Noise < 20 {
		out = append(out, fmt.Sprintf("Weak Wi-Fi (SNR %d dB): move closer to the access point or phone, or use a cable / USB tether.", s.Signal.RSSI-s.Signal.Noise))
	}
	if q := s.Link; q != nil {
		switch q.Path {
		case "local":
			out = append(out, fmt.Sprintf("Loss on the Wi-Fi hop itself (gateway loss %d%%, jitter %d ms): interference or distance, not the internet.", q.GwLossPct, q.GwJitterMs))
		case "upstream":
			out = append(out, fmt.Sprintf("Wi-Fi is fine; the loss is upstream (internet loss %d%%, jitter %d ms, %d ms): the ISP or cellular side.", q.NetLossPct, q.NetJitterMs, q.NetRTTMs))
		}
	}
	return out
}

// radioLine is the short radio summary added to the network line.
func radioLine(r *Radio, q *LinkQuality) string {
	var parts []string
	if r != nil {
		p := fmt.Sprintf("Wi-Fi %s GHz ch%d/%d MHz", r.Band, r.Channel, r.WidthMHz)
		if r.PHY != "" {
			p += " " + r.PHY
		}
		p += fmt.Sprintf(", %d overlapping", r.Overlapping)
		parts = append(parts, p)
	}
	if q != nil {
		p := fmt.Sprintf("loss net %d%%", q.NetLossPct)
		if q.GwLossPct >= 0 {
			p = fmt.Sprintf("loss Wi-Fi %d%% / net %d%%", q.GwLossPct, q.NetLossPct)
		}
		parts = append(parts, fmt.Sprintf("%s, jitter %d ms", p, q.NetJitterMs))
	}
	return strings.Join(parts, " · ")
}

// radioReport is the optional "radio" block of the Gauss report (backend parseNet):
// counts and grades only, never a network name.
func radioReport(r *Radio, q *LinkQuality) map[string]any {
	if r == nil && q == nil {
		return nil
	}
	m := map[string]any{}
	if r != nil {
		m["band"], m["channel"], m["widthMHz"], m["coChannel"], m["overlapping"] = r.Band, r.Channel, r.WidthMHz, r.CoChannel, r.Overlapping
		if r.PHY != "" {
			m["phy"] = r.PHY
		}
		if r.MCS >= 0 {
			m["mcs"] = r.MCS
		}
		if r.TxMbps > 0 {
			m["txMbps"] = r.TxMbps
		}
	}
	if q != nil {
		m["netLossPct"], m["netJitterMs"], m["netRttMs"], m["path"] = q.NetLossPct, q.NetJitterMs, q.NetRTTMs, q.Path
		if q.GwLossPct >= 0 {
			m["gwLossPct"], m["gwJitterMs"] = q.GwLossPct, q.GwJitterMs
		}
	}
	return m
}
