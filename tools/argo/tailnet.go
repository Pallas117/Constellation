package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Tailscale after a network change (2026-11-05, Josh: "the Tailscale faster wired in").
// Argo never changes Tailscale settings (mesh-heal owns `tailscale up`; README "Tailscale: Argo
// defers to mesh-heal"). What it can do, read-only, is ask right after a switch whether the
// tailnet answers and how long that took: `tailscale ping` of the hub (one ping, short
// timeout), and when that does not answer, `tailscale netcheck` for the nearest DERP relay.
// The answer decides whether files go now or wait in the outbox (store-and-forward, relay.go),
// and is shown by `argo status` and reported to the mesh (link.tailnetMs / link.tailnetVia).

const (
	tailnetPingTimeout = 3 * time.Second
	tailnetCheckBudget = 5 * time.Second
)

// TailnetCheck is one answer from the tailnet after a switch.
type TailnetCheck struct {
	At   time.Time `json:"at"`
	Peer string    `json:"peer,omitempty"` // the hub host asked; "" when no Gauss URL is configured
	Ms   int       `json:"ms"`             // round trip to the peer; -1: no answer within tailnetPingTimeout
	Via  string    `json:"via,omitempty"`  // "direct" or "relay" (a DERP server); "" when no answer
	// From netcheck, when the peer did not answer: the nearest DERP region and its latency.
	DERPRegion int    `json:"derp_region,omitempty"`
	DERPMs     int    `json:"derp_ms,omitempty"`
	Err        string `json:"err,omitempty"`
	TookMs     int    `json:"took_ms"` // wall time of the whole check
}

// Answered is true when the hub replied over the tailnet.
func (c TailnetCheck) Answered() bool { return c.Ms >= 0 && c.Peer != "" }

// SwitchInfo is what Argo recorded at the last network change (or recovery): the networks, the
// tailnet answer and whether deliveries fall back to store-and-forward.
type SwitchInfo struct {
	At           time.Time    `json:"at"`
	From         string       `json:"from,omitempty"` // previous fingerprint; "" after a recovery on the same network
	To           string       `json:"to"`
	Tailnet      TailnetCheck `json:"tailnet"`
	StoreForward bool         `json:"store_forward"` // the hub did not answer: bundles wait in the outbox
	Avail7d      float64      `json:"avail_7d"`      // this network's learned 7-day availability; -1 unknown
}

// cmdRunner runs one pinned command and returns its stdout; tests pass a fake.
type cmdRunner func(ctx context.Context, name string, args ...string) (string, error)

func execRunner(ctx context.Context, name string, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, name, args...).Output()
	return string(out), err
}

var rePong = regexp.MustCompile(`via (DERP\([^)]*\)|\S+) in (\d+(?:\.\d+)?)ms`)

// parseTailscalePing reads `tailscale ping --c 1` output:
//
//	pong from judith (100.64.0.1) via DERP(sin) in 123ms
//	pong from judith (100.64.0.1) via 203.0.113.5:41641 in 12ms
func parseTailscalePing(out string) (ms int, via string, ok bool) {
	m := rePong.FindStringSubmatch(out)
	if m == nil {
		return -1, "", false
	}
	f, err := strconv.ParseFloat(m[2], 64)
	if err != nil {
		return -1, "", false
	}
	via = "direct"
	if strings.HasPrefix(m[1], "DERP(") {
		via = "relay"
	}
	return max(1, int(f+0.5)), via, true
}

// parseNetcheck reads `tailscale netcheck --format=json`: the preferred DERP region and its
// latency (RegionLatency holds nanoseconds keyed by region id).
func parseNetcheck(out string) (region, ms int) {
	var r struct {
		PreferredDERP int
		RegionLatency map[string]int64
	}
	if json.Unmarshal([]byte(out), &r) != nil || r.PreferredDERP <= 0 {
		return 0, -1
	}
	ns, ok := r.RegionLatency[strconv.Itoa(r.PreferredDERP)]
	if !ok {
		return r.PreferredDERP, -1
	}
	return r.PreferredDERP, max(1, int(ns/int64(time.Millisecond)))
}

// kickTailnet asks the tailnet once. cli is the pinned tailscale binary (tailscaleCLI()); peer
// is the hub's tailnet host or "". Both commands are read-only.
func kickTailnet(ctx context.Context, run cmdRunner, cli, peer string, now func() time.Time) TailnetCheck {
	t0 := now()
	c := TailnetCheck{At: t0, Peer: peer, Ms: -1, DERPMs: -1}
	if peer != "" {
		pctx, cancel := context.WithTimeout(ctx, tailnetPingTimeout+time.Second)
		out, err := run(pctx, cli, "ping", "--c", "1", "--timeout", tailnetPingTimeout.String(), peer)
		cancel()
		if ms, via, ok := parseTailscalePing(out); ok {
			c.Ms, c.Via = ms, via
			c.TookMs = int(now().Sub(t0) / time.Millisecond)
			return c
		}
		if err != nil {
			c.Err = "ping: " + Mask(strings.TrimSpace(firstLine(out, err.Error())))
		} else {
			c.Err = "ping: no reply"
		}
	}
	nctx, cancel := context.WithTimeout(ctx, tailnetCheckBudget)
	out, err := run(nctx, cli, "netcheck", "--format=json")
	cancel()
	if err != nil && strings.TrimSpace(out) == "" {
		c.Err = strings.TrimSpace(c.Err + "; netcheck: " + Mask(err.Error()))
	} else {
		c.DERPRegion, c.DERPMs = parseNetcheck(out)
	}
	c.Err = strings.TrimPrefix(c.Err, "; ")
	c.TookMs = int(now().Sub(t0) / time.Millisecond)
	return c
}

func firstLine(out, fallback string) string {
	if l, _, _ := strings.Cut(strings.TrimSpace(out), "\n"); l != "" {
		return l
	}
	return fallback
}

// hubHost is the tailnet host Argo reports to, or "" (unset, or loopback: nothing to ping).
func hubHost(cfg Config) string {
	if cfg.GaussURL == "" {
		return ""
	}
	u, err := tailnetOnly(cfg.GaussURL)
	if err != nil || isLoopback(cfg.GaussURL) {
		return ""
	}
	return u.Hostname()
}

// tailnetKicker is what the real loop calls after a switch.
func tailnetKicker(cfg Config) func(context.Context) TailnetCheck {
	return func(ctx context.Context) TailnetCheck {
		return kickTailnet(ctx, execRunner, tailscaleCLI(), hubHost(cfg), time.Now)
	}
}

// netAvailability is one network's 7-day availability from the incident log (-1: nothing observed).
func netAvailability(in []Incident, st State, fp string, now time.Time) float64 {
	var mine []Incident
	for _, e := range in {
		if e.Fingerprint == fp {
			mine = append(mine, e)
		}
	}
	since := st.Networks[fp].FirstSeen
	if since.IsZero() {
		return -1
	}
	return linkStats(mine, since, now, 7*24*time.Hour).Availability
}

// switchLine is the `argo status` suffix: when the last switch was, whether the tailnet answered
// and how fast, and whether deliveries wait in the outbox.
func switchLine(st State, now time.Time) string {
	s := st.Switch
	if s == nil {
		return ""
	}
	ago := now.Sub(s.At).Round(time.Second)
	t := s.Tailnet
	var tn string
	switch {
	case t.Answered():
		tn = fmt.Sprintf("tailnet %dms %s", t.Ms, t.Via)
	case t.Peer == "" && t.DERPMs >= 0:
		tn = fmt.Sprintf("no hub to ping; relay %dms", t.DERPMs)
	case t.DERPMs >= 0:
		tn = fmt.Sprintf("hub silent, relay %dms: store-and-forward", t.DERPMs)
	default:
		tn = "tailnet silent: store-and-forward"
	}
	line := fmt.Sprintf(" switch %s ago (%s, %d ms)", ago, tn, t.TookMs)
	if s.Avail7d >= 0 {
		line += fmt.Sprintf(", this network %d%% up over 7 d", int(s.Avail7d*100+0.5))
	}
	return line
}
