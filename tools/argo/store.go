package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Store owns everything Argo writes. Paths are injectable for tests.
type Store struct {
	Dir string // ~/.local/state/argo
}

func DefaultStore() Store { return Store{Dir: filepath.Join(home(), ".local/state/argo")} }

func (s Store) path(name string) string { return filepath.Join(s.Dir, name) }

// State is the loop's memory between ticks. Breaker and backoff numbers
// mirror mesh-heal: 4 attempts, 60s·2^(n-1) capped at 15 min, 30 min open.
type State struct {
	Class        Class     `json:"class"`
	Reason       string    `json:"reason"`
	Fingerprint  string    `json:"fingerprint"`
	Loc          string    `json:"loc,omitempty"`
	CheckedAt    time.Time `json:"checked_at"`
	IncidentAt   time.Time `json:"incident_at,omitempty"`
	Attempts     int       `json:"attempts"`
	LastFixAt    time.Time `json:"last_fix_at,omitempty"`
	LastFix      string    `json:"last_fix,omitempty"`
	BreakerUntil time.Time `json:"breaker_until,omitempty"`
	// LastSummaryAt is when the weekly iMessage summary was last sent.
	LastSummaryAt time.Time      `json:"last_summary_at,omitempty"`
	Networks      map[string]Net `json:"networks,omitempty"` // fingerprint → what worked there
	Tailscale     Tailscale      `json:"tailscale"`
	Gateway       string         `json:"gateway,omitempty"`
	GatewayMAC    string         `json:"gateway_mac,omitempty"`
}

// Net remembers which fix resolved each class on one network.
type Net struct {
	FirstSeen time.Time        `json:"first_seen"`
	Fixes     map[Class]string `json:"fixes,omitempty"`
}

const (
	maxAttempts    = 4
	backoffBase    = 60 * time.Second
	backoffMax     = 15 * time.Minute
	breakerCooldwn = 30 * time.Minute
)

func backoff(attempts int) time.Duration {
	if attempts <= 0 {
		return 0
	}
	d := backoffBase << (attempts - 1)
	if d > backoffMax || d <= 0 {
		return backoffMax
	}
	return d
}

func (s Store) Load() State {
	var st State
	b, err := os.ReadFile(s.path("state.json"))
	if err == nil {
		_ = json.Unmarshal(b, &st)
	}
	if st.Networks == nil {
		st.Networks = map[string]Net{}
	}
	return st
}

func (s Store) Save(st State) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	tmp := s.path("state.json.tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path("state.json"))
}

// Incident is one line of incidents.jsonl.
type Incident struct {
	Time        time.Time `json:"time"`
	Event       string    `json:"event"` // open | attempt | resolved | escalated
	Class       Class     `json:"class"`
	Fingerprint string    `json:"fingerprint"`
	Detail      string    `json:"detail,omitempty"`
	Actions     []string  `json:"actions,omitempty"`
	Fix         string    `json:"fix,omitempty"`
}

func (s Store) Append(in Incident) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	in.Detail = Mask(in.Detail)
	f, err := os.OpenFile(s.path("incidents.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	b, _ := json.Marshal(in)
	_, err = f.Write(append(b, '\n'))
	return err
}

func (s Store) Incidents() []Incident {
	f, err := os.Open(s.path("incidents.jsonl"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []Incident
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var in Incident
		if json.Unmarshal(sc.Bytes(), &in) == nil {
			out = append(out, in)
		}
	}
	return out
}

// Lock is an O_EXCL lock file; a lock older than 10 minutes is from a killed run.
func (s Store) Lock() (func(), error) {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return nil, err
	}
	p := s.path("lock")
	for i := 0; i < 2; i++ {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			fmt.Fprintf(f, "%d\n", os.Getpid())
			f.Close()
			return func() { os.Remove(p) }, nil
		}
		if fi, serr := os.Stat(p); serr == nil && time.Since(fi.ModTime()) > 10*time.Minute {
			os.Remove(p)
			continue
		}
		return nil, errors.New("another argo run is in progress")
	}
	return nil, errors.New("could not take lock")
}

func (s Store) Disabled() bool {
	_, err := os.Stat(s.path("disabled"))
	return err == nil
}

// Fingerprint identifies a network by gateway MAC plus the public IP prefix
// (first three IPv4 octets or IPv6 hextets), hashed so the raw IP and MAC are
// never stored or reported.
func Fingerprint(gatewayMAC, publicIP string) string {
	if gatewayMAC == "" && publicIP == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(gatewayMAC + "|" + ipPrefix(publicIP)))
	return hex.EncodeToString(sum[:6])
}

func ipPrefix(ip string) string {
	parsed := net.ParseIP(ip)
	switch {
	case parsed == nil:
		return ""
	case parsed.To4() != nil:
		p := strings.Split(parsed.To4().String(), ".")
		return strings.Join(p[:3], ".")
	default:
		p := strings.Split(parsed.String(), ":")
		if len(p) > 3 {
			p = p[:3]
		}
		return strings.Join(p, ":")
	}
}

// ---- secret masking ----

var secretRe = regexp.MustCompile(`(?i)([A-Za-z0-9_\-]*(?:key|token|secret|password|passwd)[A-Za-z0-9_\-]*"?\s*[:=]\s*"?)([^\s"&,]+)`)

// Mask hides values whose names contain key/token/secret/password and any
// user:pass in URLs. Every string written to disk or the network goes through it.
func Mask(s string) string {
	s = secretRe.ReplaceAllString(s, "${1}***")
	return userinfoRe.ReplaceAllString(s, "${1}***@")
}

var userinfoRe = regexp.MustCompile(`([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/@\s]+@`)

func maskURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return Mask(raw)
	}
	u.User = url.User("***")
	return u.String()
}
