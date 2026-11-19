package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Per-host reachability (GAU-247). On 2026-11-18 the dorm network (TM, 110.159.x) resolved
// iswa.gsfc.nasa.gov and cdaweb.gsfc.nasa.gov but TCP 443 and 80 to them timed out, and a
// traceroute died after 206.223.117.192, while www.nasa.gov and SWPC answered. Nothing in
// Argo's link classes covers "this one host is unreachable from this network": the uplink is
// fine and Claude works. `argo reach` names it, says what helps, and remembers it per network.

// Verdicts, most fundamental first.
const (
	ReachOK        = "ok"
	ReachUplink    = "uplink_down"   // nothing gets out: not about this host
	ReachDNS       = "dns"           // the name does not resolve here
	ReachBlocked   = "blocked"       // resolves, but no address accepts a TCP connection
	ReachTLS       = "tls_failed"    // TCP connects, the TLS handshake is dropped or reset (SNI filtering looks like this)
	ReachUntrusted = "tls_untrusted" // a certificate this Mac doesn't trust: interception on this path
)

// defaultReachHosts are the data sources Gauss fetches plus Claude's API. ARGO_REACH_HOSTS
// (comma-separated host or host:port) replaces them.
var defaultReachHosts = []string{
	"api.anthropic.com",
	"services.swpc.noaa.gov",
	"iswa.gsfc.nasa.gov",
	"cdaweb.gsfc.nasa.gov",
}

const (
	reachLookupTimeout = 5 * time.Second
	reachDialTimeout   = 4 * time.Second
	reachTLSTimeout    = 5 * time.Second
	reachMaxAddrs      = 4  // addresses tried per host
	reachMaxHosts      = 16 // hosts per run
	keepBlockedHosts   = 32 // remembered per network
	blockedHostTTL     = 30 * 24 * time.Hour
)

// HostReach is one host's result.
type HostReach struct {
	Host      string `json:"host"` // host:port
	Verdict   string `json:"verdict"`
	Addrs     int    `json:"addrs,omitempty"`
	ConnectMs int    `json:"connect_ms,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

// reacher does the network work; tests replace every function.
type reacher struct {
	lookup    func(ctx context.Context, host string) ([]string, error)
	dial      dialFunc
	handshake func(ctx context.Context, c net.Conn, host string) error // nil: TCP only
	anchors   func(ctx context.Context) bool
}

func systemReacher() reacher {
	return reacher{
		lookup: net.DefaultResolver.LookupHost,
		dial: func(ctx context.Context, addr string) (net.Conn, error) {
			d := net.Dialer{Timeout: reachDialTimeout}
			return d.DialContext(ctx, "tcp", addr)
		},
		handshake: func(ctx context.Context, c net.Conn, host string) error {
			// Certificates are always verified: an untrusted chain is a finding, never accepted.
			tc := tls.Client(c, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12})
			ctx, cancel := context.WithTimeout(ctx, reachTLSTimeout)
			defer cancel()
			return tc.HandshakeContext(ctx)
		},
		anchors: func(ctx context.Context) bool { return ipReachable(ctx, tcpDial) },
	}
}

var reHostName = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*$`)

// parseReachTarget accepts "host" or "host:port" (443 by default). No schemes, paths or
// user info: the value becomes a dial address and a key in state.
func parseReachTarget(v string) (host, port string, err error) {
	v = strings.ToLower(strings.TrimSpace(v))
	host, port = v, "443"
	if strings.Contains(v, ":") {
		if host, port, err = net.SplitHostPort(v); err != nil {
			return "", "", fmt.Errorf("bad host %q", v)
		}
	}
	if len(host) > 253 || (!reHostName.MatchString(host) && net.ParseIP(host) == nil) {
		return "", "", fmt.Errorf("bad host %q (want a name like iswa.gsfc.nasa.gov, optionally :port)", v)
	}
	var n int
	if _, e := fmt.Sscanf(port, "%d", &n); e != nil || n < 1 || n > 65535 || fmt.Sprint(n) != port {
		return "", "", fmt.Errorf("bad port in %q", v)
	}
	return host, port, nil
}

// reachTargets is the list to check: arguments, else ARGO_REACH_HOSTS, else the defaults.
func reachTargets(args []string, env string) ([]string, error) {
	list := args
	if len(list) == 0 && strings.TrimSpace(env) != "" {
		list = strings.Split(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachHosts
	}
	var out []string
	seen := map[string]bool{}
	for _, v := range list {
		if strings.TrimSpace(v) == "" {
			continue
		}
		h, p, err := parseReachTarget(v)
		if err != nil {
			return nil, err
		}
		if k := net.JoinHostPort(h, p); !seen[k] {
			seen[k] = true
			out = append(out, k)
		}
	}
	if len(out) > reachMaxHosts {
		return nil, fmt.Errorf("at most %d hosts per run", reachMaxHosts)
	}
	return out, nil
}

// checkHost classifies one host:port. Addresses are tried in parallel; the first that
// connects decides.
func (r reacher) checkHost(ctx context.Context, target string) HostReach {
	host, port, _ := net.SplitHostPort(target)
	out := HostReach{Host: target}
	addrs := []string{host}
	if net.ParseIP(host) == nil {
		lctx, cancel := context.WithTimeout(ctx, reachLookupTimeout)
		a, err := r.lookup(lctx, host)
		cancel()
		if err != nil || len(a) == 0 {
			out.Verdict, out.Detail = ReachDNS, errText(err, "no addresses")
			return out
		}
		addrs = a
	}
	out.Addrs = len(addrs)
	if len(addrs) > reachMaxAddrs {
		addrs = addrs[:reachMaxAddrs]
	}
	type res struct {
		c   net.Conn
		ms  int
		err error
	}
	dctx, cancel := context.WithTimeout(ctx, reachDialTimeout+time.Second)
	defer cancel()
	ch := make(chan res, len(addrs))
	for _, a := range addrs {
		go func() {
			t0 := time.Now()
			c, err := r.dial(dctx, net.JoinHostPort(a, port))
			ch <- res{c, int(time.Since(t0).Milliseconds()), err}
		}()
	}
	var conn net.Conn
	var lastErr error
	for range addrs {
		x := <-ch
		switch {
		case x.err != nil:
			lastErr = x.err
		case conn == nil:
			conn, out.ConnectMs = x.c, max(x.ms, 1)
		default:
			x.c.Close()
		}
	}
	if conn == nil {
		out.Verdict, out.Detail = ReachBlocked, "no TCP answer on port "+port+" from "+fmt.Sprint(len(addrs))+" address(es): "+errText(lastErr, "")
		return out
	}
	defer conn.Close()
	if port == "443" && r.handshake != nil && net.ParseIP(host) == nil {
		if err := r.handshake(ctx, conn, host); err != nil {
			var unk x509.UnknownAuthorityError
			var inv x509.CertificateInvalidError
			var hn x509.HostnameError
			if errors.As(err, &unk) || errors.As(err, &inv) || errors.As(err, &hn) {
				out.Verdict, out.Detail = ReachUntrusted, err.Error()
			} else {
				out.Verdict, out.Detail = ReachTLS, err.Error()
			}
			return out
		}
	}
	out.Verdict = ReachOK
	return out
}

// reach checks every target; when any fails it dials the IP anchors once, so a dead uplink
// is reported as that and not as a pile of per-host blocks.
func (r reacher) reach(ctx context.Context, targets []string) []HostReach {
	out := make([]HostReach, len(targets))
	done := make(chan struct{}, len(targets))
	for i, t := range targets {
		go func() { out[i] = r.checkHost(ctx, t); done <- struct{}{} }()
	}
	for range targets {
		<-done
	}
	failed := false
	for _, h := range out {
		failed = failed || h.Verdict != ReachOK
	}
	if failed && r.anchors != nil && !r.anchors(ctx) {
		for i := range out {
			if out[i].Verdict == ReachDNS || out[i].Verdict == ReachBlocked {
				out[i].Verdict, out[i].Detail = ReachUplink, "nothing gets out: 1.1.1.1, 9.9.9.9 and 8.8.8.8 don't answer by IP either"
			}
		}
	}
	return out
}

// reachAdvice says what helps for one result, or "" when it is fine.
func reachAdvice(h HostReach, others int, hotspot bool) string {
	name, _, _ := net.SplitHostPort(h.Host)
	switch h.Verdict {
	case ReachUplink:
		return "Nothing gets out on this network at all; it is not about " + name + ". Switch to the iPhone hotspot."
	case ReachBlocked, ReachTLS, ReachDNS:
		what := map[string]string{
			ReachBlocked: "resolves but no address answers",
			ReachTLS:     "connects but the secure handshake is cut",
			ReachDNS:     "does not resolve",
		}[h.Verdict]
		s := name + " " + what + " from this network"
		if others > 0 {
			s += fmt.Sprintf(" while %d other host(s) work, so this network or its provider drops it (Argo can't fix that here)", others)
		}
		if hotspot {
			return s + ". Try Wi-Fi or another device on the tailnet, or wait: Gauss keeps its last data."
		}
		return s + ". Fetch it over the iPhone hotspot (a different carrier may route it) or from another device on the tailnet; Gauss keeps its last data meanwhile."
	case ReachUntrusted:
		return name + " shows a certificate this Mac doesn't trust: something on this path intercepts it. Don't fetch it here; switch network."
	}
	return ""
}

// rememberBlocks updates this network's blocked-host memory from one run: failures are
// recorded with the time seen, successes clear them, entries expire and the map is capped.
func rememberBlocks(n *Net, results []HostReach, now time.Time) {
	if n.BlockedHosts == nil {
		n.BlockedHosts = map[string]time.Time{}
	}
	for _, h := range results {
		switch h.Verdict {
		case ReachOK:
			delete(n.BlockedHosts, h.Host)
		case ReachBlocked, ReachTLS, ReachDNS, ReachUntrusted:
			n.BlockedHosts[h.Host] = now
		} // uplink_down says nothing about the host
	}
	keys := make([]string, 0, len(n.BlockedHosts))
	for k, t := range n.BlockedHosts {
		if now.Sub(t) > blockedHostTTL {
			delete(n.BlockedHosts, k)
			continue
		}
		keys = append(keys, k)
	}
	if len(keys) > keepBlockedHosts { // drop the oldest
		sort.Slice(keys, func(i, j int) bool { return n.BlockedHosts[keys[i]].After(n.BlockedHosts[keys[j]]) })
		for _, k := range keys[keepBlockedHosts:] {
			delete(n.BlockedHosts, k)
		}
	}
	if len(n.BlockedHosts) == 0 {
		n.BlockedHosts = nil
	}
}

// printReach writes the human report; it returns how many hosts are not reachable.
func printReach(w io.Writer, results []HostReach, known map[string]time.Time, hotspot bool) int {
	okCount := 0
	for _, h := range results {
		if h.Verdict == ReachOK {
			okCount++
		}
	}
	bad := 0
	for _, h := range results {
		line := fmt.Sprintf("%-34s %-13s", h.Host, h.Verdict)
		if h.ConnectMs > 0 {
			line += fmt.Sprintf(" %d ms", h.ConnectMs)
		}
		fmt.Fprintln(w, strings.TrimRight(line, " "))
		if h.Verdict != ReachOK {
			bad++
			if h.Detail != "" {
				fmt.Fprintln(w, "    "+Mask(h.Detail))
			}
			fmt.Fprintln(w, "  → "+reachAdvice(h, okCount, hotspot))
		}
	}
	var earlier []string
	for k, t := range known {
		if !hasHost(results, k) {
			earlier = append(earlier, fmt.Sprintf("%s (%s)", k, t.Local().Format("2 Jan 15:04")))
		}
	}
	sort.Strings(earlier)
	if len(earlier) > 0 {
		fmt.Fprintln(w, "Seen blocked on this network before: "+strings.Join(earlier, ", "))
	}
	return bad
}

func hasHost(r []HostReach, host string) bool {
	for _, h := range r {
		if h.Host == host {
			return true
		}
	}
	return false
}

func errText(err error, fallback string) string {
	if err == nil {
		return fallback
	}
	return err.Error()
}

// reachCmd is `argo reach [--json] [host[:port] ...]`. Exit 2 when any host is unreachable,
// so a fetch script can ask before it spends minutes on timeouts. It records results under the
// network Argo last saw (state is shared with the tick, so it takes the lock).
func reachCmd(ctx context.Context, store Store, args []string) (int, error) {
	asJSON := false
	var hosts []string
	for _, a := range args {
		if a == "--json" {
			asJSON = true
			continue
		}
		if strings.HasPrefix(a, "-") {
			return 1, fmt.Errorf("usage: argo reach [--json] [host[:port] ...]")
		}
		hosts = append(hosts, a)
	}
	targets, err := reachTargets(hosts, os.Getenv("ARGO_REACH_HOSTS"))
	if err != nil {
		return 1, err
	}
	results := systemReacher().reach(ctx, targets)
	var known map[string]time.Time
	var gw string
	_ = withLock(store, func() {
		st := store.Load()
		gw = st.Gateway
		if st.Fingerprint == "" {
			return
		}
		n := st.Networks[st.Fingerprint]
		rememberBlocks(&n, results, time.Now())
		st.Networks[st.Fingerprint] = n
		known = n.BlockedHosts
		_ = store.Save(st)
	})
	bad := 0
	if asJSON {
		b, _ := json.MarshalIndent(results, "", "  ")
		fmt.Println(string(b))
		for _, h := range results {
			if h.Verdict != ReachOK {
				bad++
			}
		}
	} else {
		bad = printReach(os.Stdout, results, known, isIPhoneHotspot(gw))
	}
	if bad > 0 {
		return 2, nil
	}
	return 0, nil
}
