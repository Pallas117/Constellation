package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// Nebula mesh status (Phase 1 of the move off Tailscale; scripts/ops/nebula/README.md).
//
// Read-only: Argo looks for the nebula binary, asks `nebula-cert print -json` about this device's
// certificate, checks the process with pgrep and the overlay address on the interfaces. It never starts
// or stops Nebula, never reads a private key and never signs anything: signing and renewal are Phase 2
// (scripts/ops/nebula/THREAT-MODEL.md, gated on Josh's review). Output stays on this machine.

const (
	nebulaWarnDays = 7        // warn when the device certificate has less than this left
	nebulaPrintMax = 64 << 10 // ignore nebula-cert output larger than this
	nebulaAbsent   = "absent" // Level when Nebula isn't on this machine at all
	pgrepPath      = "/usr/bin/pgrep"
)

// Pinned locations, checked in order: the root-owned copy the kit installs on macOS, Homebrew, the
// Linux kit's /usr/local/bin, distribution packages.
var (
	nebulaBins      = []string{"/usr/local/libexec/lightbound/nebula", "/usr/local/bin/nebula", "/opt/homebrew/bin/nebula", "/usr/bin/nebula"}
	nebulaCertTools = []string{"/usr/local/libexec/lightbound/nebula-cert", "/usr/local/bin/nebula-cert", "/opt/homebrew/bin/nebula-cert", "/usr/bin/nebula-cert"}
	nebulaCertPaths = []string{"/etc/nebula/host.crt", "/opt/homebrew/etc/nebula/host.crt", "/usr/local/etc/nebula/host.crt"}
)

// nebulaEnv is everything the check touches, so tests run on fixtures.
type nebulaEnv struct {
	run      func(ctx context.Context, name string, args ...string) (string, error)
	exists   func(path string) bool
	procUp   func(ctx context.Context) (up, known bool)
	addrs    func() map[netip.Addr]string // address on an interface that is up -> interface name
	certPath string                       // ARGO_NEBULA_CERT; else the first of nebulaCertPaths that exists
	now      time.Time
}

// NebulaCert is the public part of the device certificate Argo reports.
type NebulaCert struct {
	Name        string    `json:"name"`
	Networks    []string  `json:"networks"`
	Groups      []string  `json:"groups"`
	NotAfter    time.Time `json:"notAfter"`
	Fingerprint string    `json:"fingerprint,omitempty"`
}

// NebulaFinding is one problem, with a sentence for the person (Argo never acts on it).
type NebulaFinding struct {
	Level string `json:"level"`
	Text  string `json:"text"`
	Fix   string `json:"fix,omitempty"`
}

// NebulaStatus is the result of one look.
type NebulaStatus struct {
	Installed bool            `json:"installed"`
	Running   string          `json:"running"` // yes | no | unknown
	Overlay   string          `json:"overlay,omitempty"`
	Iface     string          `json:"iface,omitempty"`
	CertPath  string          `json:"certPath,omitempty"`
	Cert      *NebulaCert     `json:"cert,omitempty"`
	DaysLeft  int             `json:"daysLeft"`
	Level     string          `json:"level"` // ok | warn | fail | unknown | absent
	Findings  []NebulaFinding `json:"findings,omitempty"`
}

func (s *NebulaStatus) add(level, text, fix string) {
	s.Findings = append(s.Findings, NebulaFinding{Level: level, Text: text, Fix: fix})
	if nebulaRank(level) > nebulaRank(s.Level) {
		s.Level = level
	}
}

func nebulaRank(l string) int {
	switch l {
	case postureFail:
		return 3
	case postureWarn:
		return 2
	case postureUnknown:
		return 1
	}
	return 0
}

func firstExisting(e nebulaEnv, paths []string) string {
	for _, p := range paths {
		if e.exists(p) {
			return p
		}
	}
	return ""
}

const nebulaRenewFix = "On the CA Mac: bash scripts/ops/nebula/sign.sh <device> <overlay-ip> <groups> --pub <its host.pub>, then copy the new certificate to /etc/nebula/host.crt here"

func nebulaStatus(ctx context.Context, e nebulaEnv) NebulaStatus {
	s := NebulaStatus{Running: "unknown", Level: postureOK, DaysLeft: -1}
	bin := firstExisting(e, nebulaBins)
	tool := firstExisting(e, nebulaCertTools)
	cert := e.certPath
	if cert == "" {
		cert = firstExisting(e, nebulaCertPaths)
	} else if !e.exists(cert) {
		cert = ""
	}
	if bin == "" && tool == "" && cert == "" {
		s.Level = nebulaAbsent
		return s
	}
	s.Installed, s.CertPath = true, cert

	if up, known := e.procUp(ctx); known {
		s.Running = map[bool]string{true: "yes", false: "no"}[up]
	}

	switch {
	case cert == "":
		s.add(postureUnknown, "No device certificate found (looked in "+strings.Join(nebulaCertPaths, ", ")+")", "Set ARGO_NEBULA_CERT to its path, or install one (scripts/ops/nebula/README.md)")
	case tool == "":
		s.add(postureUnknown, "nebula-cert not found, so the certificate could not be read", "Install Nebula 1.12 or newer (scripts/ops/nebula/README.md)")
	default:
		c, err := readNebulaCert(ctx, e, tool, cert)
		if err != nil {
			s.add(postureUnknown, "The device certificate could not be read: "+err.Error(), "Check it with: nebula-cert print -path "+cert)
			break
		}
		s.Cert = c
		left := c.NotAfter.Sub(e.now)
		s.DaysLeft = max(int(left.Hours()/24), 0)
		switch {
		case left <= 0:
			s.add(postureFail, "This device's Nebula certificate expired on "+c.NotAfter.UTC().Format("2 Jan 2006 15:04 MST"), nebulaRenewFix)
		case left < nebulaWarnDays*24*time.Hour:
			when := fmt.Sprintf("in %d day%s", s.DaysLeft, plural(s.DaysLeft))
			if s.DaysLeft == 0 {
				when = "in less than a day"
			}
			s.add(postureWarn, "This device's Nebula certificate expires "+when+" ("+c.NotAfter.UTC().Format("2 Jan 2006")+")", nebulaRenewFix)
		}
		s.Overlay, s.Iface = overlayOnIface(c.Networks, e.addrs())
	}

	switch {
	case s.Running == "no":
		s.add(postureWarn, "Nebula is installed but not running", "Start it yourself: sudo launchctl kickstart -k system/uk.lightbound.nebula (Mac) or sudo systemctl restart nebula (Linux)")
	case s.Running == "yes" && s.Cert != nil && s.Overlay == "":
		s.add(postureWarn, "Nebula runs, but its overlay address is not on any interface", "Read the log: /var/log/nebula.log (Mac) or journalctl -u nebula (Linux)")
	}
	return s
}

// readNebulaCert runs `nebula-cert print -json -path CERT` (pinned tool, fixed argv) and keeps the
// device certificate that expires first (a v1+v2 pair renews together; the earlier one matters).
func readNebulaCert(ctx context.Context, e nebulaEnv, tool, path string) (*NebulaCert, error) {
	out, err := e.run(ctx, tool, "print", "-json", "-path", path)
	if err != nil && strings.TrimSpace(out) == "" {
		return nil, errors.New("nebula-cert failed")
	}
	if len(out) > nebulaPrintMax {
		return nil, errors.New("nebula-cert printed too much")
	}
	type details struct {
		Name     string    `json:"name"`
		Networks []string  `json:"networks"`
		IPs      []string  `json:"ips"` // nebula-cert before 1.10
		Groups   []string  `json:"groups"`
		NotAfter time.Time `json:"notAfter"`
		IsCA     bool      `json:"isCa"`
	}
	type certJSON struct {
		Details     details `json:"details"`
		Fingerprint string  `json:"fingerprint"`
	}
	var certs []certJSON
	trim := strings.TrimSpace(out)
	if strings.HasPrefix(trim, "{") {
		var one certJSON
		if json.Unmarshal([]byte(trim), &one) != nil {
			return nil, errors.New("unexpected output from nebula-cert")
		}
		certs = []certJSON{one}
	} else if json.Unmarshal([]byte(trim), &certs) != nil {
		return nil, errors.New("unexpected output from nebula-cert")
	}
	var best *NebulaCert
	for _, c := range certs {
		if c.Details.IsCA || c.Details.NotAfter.IsZero() {
			continue
		}
		nets := c.Details.Networks
		if len(nets) == 0 {
			nets = c.Details.IPs
		}
		if best == nil || c.Details.NotAfter.Before(best.NotAfter) {
			best = &NebulaCert{Name: c.Details.Name, Networks: nets, Groups: c.Details.Groups, NotAfter: c.Details.NotAfter, Fingerprint: c.Fingerprint}
		}
	}
	if best == nil {
		return nil, errors.New("no device certificate in the file")
	}
	return best, nil
}

// overlayOnIface finds the certificate's overlay address among this machine's interface addresses.
func overlayOnIface(networks []string, addrs map[netip.Addr]string) (string, string) {
	for _, n := range networks {
		p, err := netip.ParsePrefix(n)
		if err != nil {
			continue
		}
		if name, ok := addrs[p.Addr()]; ok {
			return p.Addr().String(), name
		}
	}
	return "", ""
}

func nebulaText(s NebulaStatus) string {
	if s.Level == nebulaAbsent {
		return "nebula: not installed (scripts/ops/nebula/README.md)\n"
	}
	var b strings.Builder
	state := map[string]string{"yes": "up", "no": "not running", "unknown": "process state unknown"}[s.Running]
	b.WriteString("nebula: " + state)
	if s.Overlay != "" {
		fmt.Fprintf(&b, ", overlay %s (%s)", s.Overlay, s.Iface)
	}
	b.WriteString("\n")
	if c := s.Cert; c != nil {
		fmt.Fprintf(&b, "  certificate: %s, groups %s, valid until %s (%d day%s left)\n", c.Name, strings.Join(c.Groups, ","), c.NotAfter.UTC().Format("2 Jan 2006"), s.DaysLeft, plural(s.DaysLeft))
		if len(c.Fingerprint) >= 16 {
			fmt.Fprintf(&b, "  fingerprint: %s… (public; the blocklist uses it)\n", c.Fingerprint[:16])
		}
	}
	for _, f := range s.Findings {
		fmt.Fprintf(&b, "  %s: %s\n", f.Level, f.Text)
		if f.Fix != "" {
			fmt.Fprintf(&b, "    → %s\n", f.Fix)
		}
	}
	return b.String()
}

// netCmd: `argo net [status] [--json]`. Exit 1 when something needs attention (warn or fail), so scripts
// can act on it. Phase 1 has no other subcommand: enrolment and renewal wait for the threat model.
func netCmd(ctx context.Context, args []string, e nebulaEnv, w io.Writer) (int, error) {
	asJSON := false
	for _, a := range args {
		switch a {
		case "status":
		case "--json":
			asJSON = true
		default:
			return 2, errors.New("usage: argo net [status] [--json]")
		}
	}
	s := nebulaStatus(ctx, e)
	if asJSON {
		b, _ := json.MarshalIndent(s, "", "  ")
		fmt.Fprintln(w, string(b))
	} else {
		fmt.Fprint(w, nebulaText(s))
	}
	if s.Level == postureWarn || s.Level == postureFail {
		return 1, nil
	}
	return 0, nil
}

// doctorNebula adds the Nebula lines to `argo doctor`, only on machines that have Nebula.
func doctorNebula(ctx context.Context, e nebulaEnv, w io.Writer) {
	s := nebulaStatus(ctx, e)
	if s.Level == nebulaAbsent {
		return
	}
	fmt.Fprint(w, nebulaText(s))
}

func realNebulaEnv(now time.Time) nebulaEnv {
	return nebulaEnv{
		run:      runReadOnly,
		exists:   func(p string) bool { _, err := os.Stat(p); return err == nil },
		procUp:   nebulaProcUp,
		addrs:    ifaceAddrs,
		certPath: os.Getenv("ARGO_NEBULA_CERT"),
		now:      now,
	}
}

// nebulaProcUp: pgrep exits 0 when a process named exactly "nebula" runs, 1 when none does.
func nebulaProcUp(ctx context.Context) (bool, bool) {
	if _, err := os.Stat(pgrepPath); err != nil {
		return false, false
	}
	_, err := runReadOnly(ctx, pgrepPath, "-x", "nebula")
	if err == nil {
		return true, true
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) && ee.ExitCode() == 1 {
		return false, true
	}
	return false, false
}

func ifaceAddrs() map[netip.Addr]string {
	out := map[netip.Addr]string{}
	ifs, err := net.Interfaces()
	if err != nil {
		return out
	}
	sort.Slice(ifs, func(i, j int) bool { return ifs[i].Index < ifs[j].Index })
	for _, i := range ifs {
		if i.Flags&net.FlagUp == 0 {
			continue
		}
		as, _ := i.Addrs()
		for _, a := range as {
			if n, ok := a.(*net.IPNet); ok {
				if ip, ok := netip.AddrFromSlice(n.IP); ok {
					out[ip.Unmap()] = i.Name
				}
			}
		}
	}
	return out
}
