package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// refusedPause is how long Argo stops reporting after Gauss refuses the
// device token (401/403). CyberTiger blocks an address after 8 auth failures
// in 5 minutes; a revoked device (or a container ticking every 15 s) would
// otherwise fail every tick, forever.
const refusedPause = time.Hour

type gaussRefused struct {
	At     time.Time `json:"at"`
	Status int       `json:"status"`
}

func (s Store) loadRefused() (gaussRefused, bool) {
	var r gaussRefused
	b, err := os.ReadFile(s.path("gauss-refused.json"))
	if err != nil || json.Unmarshal(b, &r) != nil || r.At.IsZero() {
		return r, false
	}
	return r, true
}

// gaussStatus is the `argo status` suffix while Gauss refuses this device.
func gaussStatus(s Store, now time.Time) string {
	if r, ok := s.loadRefused(); ok && now.Sub(r.At) < 7*24*time.Hour {
		return " gauss:token-refused"
	}
	return ""
}

const minReportGap = 15 * time.Second

// pushToGauss reports once per check, pausing after a refused token.
func pushToGauss(cfg Config, st State) { pushAt(cfg, st, DefaultStore(), time.Now()) }

func pushAt(cfg Config, st State, s Store, now time.Time) {
	if r, ok := s.loadRefused(); ok && now.Sub(r.At) < refusedPause {
		return
	}
	// Gauss takes one report per device every 10 s. Runs from the minute timer
	// and from network-change events can land closer than that; skip instead
	// of collecting a 429 (launchd.log 2026-10-24/25).
	last := s.path("gauss-last-report")
	if b, err := os.ReadFile(last); err == nil {
		if t, perr := time.Parse(time.RFC3339Nano, strings.TrimSpace(string(b))); perr == nil && now.Sub(t) >= 0 && now.Sub(t) < minReportGap {
			return
		}
	}
	code, err := sendReport(cfg, st)
	if err == nil {
		_ = os.MkdirAll(s.Dir, 0o700)
		_ = os.WriteFile(last, []byte(now.Format(time.RFC3339Nano)), 0o600)
	}
	switch {
	case err != nil:
		return // offline or Gauss down: the next check reports again
	case code == http.StatusTooManyRequests:
		return // a newer report is due within the minute
	case code == http.StatusUnauthorized || code == http.StatusForbidden:
		b, _ := json.Marshal(gaussRefused{At: now, Status: code})
		_ = os.MkdirAll(s.Dir, 0o700)
		_ = os.WriteFile(s.path("gauss-refused.json"), b, 0o600)
		fmt.Fprintf(os.Stderr, "%s argo: Gauss refused this device's token (HTTP %d); pausing reports for %s. Create a new token on /mesh and run `argo enroll` again.\n",
			now.UTC().Format(time.RFC3339), code, refusedPause)
	case code >= 300: // e.g. a class Gauss doesn't know yet: say so instead of failing silently
		fmt.Fprintf(os.Stderr, "%s argo: Gauss rejected the report for class %s: HTTP %d\n", now.UTC().Format(time.RFC3339), st.Class, code)
	default:
		_ = os.Remove(s.path("gauss-refused.json"))
	}
}

// sendReport posts a minimal record: no public IP, no MAC, no SSID, no env.
func sendReport(cfg Config, st State) (int, error) {
	u, err := tailnetOnly(cfg.GaussURL)
	if err != nil {
		return 0, err
	}
	tok, err := os.ReadFile(filepath.Join(configDir(), "token"))
	if err != nil {
		return 0, err
	}
	report := map[string]any{
		"device": cfg.Device, "class": st.Class, "reason": Mask(st.Reason), "loc": st.Loc,
		"network": st.Fingerprint, "tailscale": st.Tailscale.Running, "exitNode": st.Tailscale.ExitNode,
		"breakerOpen": time.Now().Before(st.BreakerUntil), "argoVersion": version, "checkedAt": st.CheckedAt,
		"host":     hostCapacityNow(), // sizes and pressure only, so Gauss can tell which devices can host agents
		"platform": platformName(runtime.GOOS),
		"net":      netReport(st.Net),                                      // scores and their reasons; no SSID, BSSID or IP
		"link":     linkReport(DefaultStore().Incidents(), st, time.Now()), // availability from the local incident log
	}
	addGuard(report, DefaultStore().loadGuard(), time.Now())
	body, _ := json.Marshal(report)
	u.Path = "/api/mesh/report"
	req, _ := http.NewRequest(http.MethodPost, u.String(), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(tok)))
	c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}}
	resp, err := c.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

// verifyEnroll sends a first report straight away, read-only like `argo
// doctor`, so a mistyped token or an unreachable Gauss shows up now instead
// of as a device stuck on "Never reported".
func verifyEnroll(ctx context.Context, cfg Config, s Store, p Prober) error {
	_ = os.Remove(s.path("gauss-refused.json")) // a new token starts clean
	_ = withLock(s, func() { guardStep(s, cfg, sampleHost(ctx, false)) })
	snap := p.Probe(ctx)
	class, reason := Classify(snap)
	st := State{Class: class, Reason: reason, Fingerprint: Fingerprint(snap.GatewayMAC, snap.PublicIP), Loc: snap.Loc,
		CheckedAt: time.Now(), Tailscale: snap.Tailscale, Net: ScoreNet(snap)}
	return enrollOutcome(sendReport(cfg, st))
}

func enrollOutcome(code int, err error) error {
	switch {
	case err != nil:
		return fmt.Errorf("saved, but Gauss didn't answer (%v). Check Tailscale is on; Argo keeps trying every check", err)
	case code == http.StatusUnauthorized || code == http.StatusForbidden:
		return fmt.Errorf("Gauss refused the token (HTTP %d). Paste the whole token, or create a new one on /mesh and run `argo enroll` again", code)
	case code == http.StatusTooManyRequests:
	case code >= 300:
		return fmt.Errorf("Gauss rejected the first report (HTTP %d). Gauss and Argo may be different versions: update both", code)
	}
	fmt.Println("Gauss accepted the first report. This device now shows on /mesh; it takes mesh work after 10 calm minutes (`argo guard` shows why not).")
	return nil
}
