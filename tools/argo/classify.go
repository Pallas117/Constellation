package main

import (
	"fmt"
	"strings"
	"time"
)

// Class is the single failure class Argo assigns to a snapshot.
type Class string

const (
	OK           Class = "OK"
	Offline      Class = "OFFLINE"
	Captive      Class = "CAPTIVE"
	DNS          Class = "DNS"
	DeadProxy    Class = "DEAD_PROXY"
	StaleDaemon  Class = "STALE_DAEMON"
	TLSIntercept Class = "TLS_INTERCEPT"
	PortBlock    Class = "PORT_BLOCK"
	Region       Class = "REGION"
	WPADRisk     Class = "WPAD_RISK"
)

// Error kinds recorded by probes. Kept as strings so fixtures stay readable.
const (
	ErrRefused      = "refused"
	ErrTimeout      = "timeout"
	ErrDNS          = "dns"
	ErrTLSUntrusted = "tls_untrusted"
	ErrPortal       = "portal"
	ErrOther        = "other"
)

// AllowedCountries is the only set of exit countries Argo will accept or
// recommend. Anthropic supports both; Hong Kong (the old eSIM exit) is not.
var AllowedCountries = map[string]bool{"MY": true, "SG": true}

type Result struct {
	OK     bool   `json:"ok"`
	Status int    `json:"status,omitempty"`
	Err    string `json:"err,omitempty"`
	Detail string `json:"detail,omitempty"`
}

// Proxy is one proxy setting found in the environment or system config.
type Proxy struct {
	Source string `json:"source"` // e.g. "env:HTTPS_PROXY" or "system:HTTPS"
	URL    string `json:"url"`
	Alive  bool   `json:"alive"`
}

// StaleProc is a running claude process whose baked-in proxy is dead —
// the long-lived daemon bug from 2026-10-08/09.
type StaleProc struct {
	PID     int    `json:"pid"`
	Command string `json:"command"`
	Proxy   string `json:"proxy"`
}

type Tailscale struct {
	Running        bool     `json:"running"`
	ExitNode       string   `json:"exit_node,omitempty"`
	ExitCandidates []string `json:"exit_candidates,omitempty"` // online, allow-listed MY/SG nodes
	MeshHealOpen   bool     `json:"mesh_heal_circuit_open,omitempty"`
}

// Snapshot is everything one probe pass learned. Fixtures in testdata/ are
// recorded Snapshots, so classification is tested without touching the network.
type Snapshot struct {
	Time       time.Time   `json:"time"`
	Online     bool        `json:"online"`
	Gateway    string      `json:"gateway,omitempty"`
	GatewayMAC string      `json:"gateway_mac,omitempty"`
	PublicIP   string      `json:"public_ip,omitempty"`
	Loc        string      `json:"loc,omitempty"`
	DNS        Result      `json:"dns"`
	API        Result      `json:"api"` // api.anthropic.com, direct (no proxy)
	Web        Result      `json:"web"` // legacy fixtures only; claude.ai 403s non-browsers so it is not probed
	Captive    Result      `json:"captive"`
	WPAD       bool        `json:"wpad"`
	PAC        bool        `json:"pac"`
	Proxies    []Proxy     `json:"proxies,omitempty"`
	StaleProcs []StaleProc `json:"stale_procs,omitempty"`
	Tailscale  Tailscale   `json:"tailscale"`
}

// Classify picks the most fundamental failure first: there is no point
// diagnosing region blocks while a captive portal is eating every request.
func Classify(s Snapshot) (Class, string) {
	switch {
	case !s.Online:
		return Offline, "no default route"
	case s.Captive.Err == ErrPortal:
		return Captive, "captive.apple.com did not return Success"
	case s.DNS.Err != "" || s.API.Err == ErrDNS:
		return DNS, "cannot resolve api.anthropic.com: " + firstNonEmpty(s.DNS.Detail, s.API.Detail)
	}
	for _, p := range s.Proxies {
		if !p.Alive {
			return DeadProxy, fmt.Sprintf("%s=%s refuses connections", p.Source, p.URL)
		}
	}
	if len(s.StaleProcs) > 0 {
		p := s.StaleProcs[0]
		return StaleDaemon, fmt.Sprintf("%d claude process(es) still use dead proxy %s (pid %d)", len(s.StaleProcs), p.Proxy, p.PID)
	}
	switch s.API.Err {
	case ErrTLSUntrusted:
		return TLSIntercept, "api.anthropic.com certificate not trusted: " + s.API.Detail
	case ErrTimeout, ErrRefused:
		return PortBlock, "api.anthropic.com:443 " + s.API.Err
	case ErrOther:
		return PortBlock, "api.anthropic.com unreachable: " + s.API.Detail
	}
	if s.API.Status == 403 {
		return Region, fmt.Sprintf("api.anthropic.com returned 403 (exit loc=%s)", orUnknown(s.Loc))
	}
	if s.Loc != "" && !AllowedCountries[s.Loc] {
		return Region, fmt.Sprintf("exit country %s is not in the MY/SG allowlist", s.Loc)
	}
	if s.WPAD || s.PAC {
		return WPADRisk, "automatic proxy discovery/PAC is on; a hostile network can redirect traffic"
	}
	return OK, fmt.Sprintf("api reachable (HTTP %d), loc=%s", s.API.Status, orUnknown(s.Loc))
}

// Blocking reports whether Claude cannot work. WPAD_RISK is a warning only,
// and "" (no previous check) is not a failure.
func (c Class) Blocking() bool { return c != "" && c != OK && c != WPADRisk }

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func orUnknown(s string) string {
	if s == "" {
		return "?"
	}
	return s
}
