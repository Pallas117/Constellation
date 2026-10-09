package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Prober produces a Snapshot. The loop only depends on this interface, so
// tests drive it with recorded snapshots instead of the real network.
type Prober interface {
	Probe(ctx context.Context) Snapshot
}

const (
	apiURL     = "https://api.anthropic.com/v1/messages" // GET → 405 when reachable
	webURL     = "https://claude.ai/"
	traceURL   = "https://www.cloudflare.com/cdn-cgi/trace"
	captiveURL = "http://captive.apple.com/hotspot-detect.html"
)

var proxyVars = []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"}

// SystemProber probes the real machine. Every external command has a timeout
// and nothing is fetched or executed from the network.
type SystemProber struct {
	ExitNodes map[string]string // tailscale hostname → country, from config
}

func (p SystemProber) Probe(ctx context.Context) Snapshot {
	s := Snapshot{Time: time.Now().UTC()}
	s.Gateway, s.Online = parseDefaultRoute(run(ctx, "route", "-n", "get", "default"))
	if s.Online {
		s.GatewayMAC = parseARP(run(ctx, "arp", "-n", s.Gateway))
	}
	s.WPAD, s.PAC = parseScutilAuto(run(ctx, "scutil", "--proxy"))
	for _, pr := range parseScutilProxies(run(ctx, "scutil", "--proxy")) {
		pr.Alive = dialAlive(pr.URL)
		s.Proxies = append(s.Proxies, pr)
	}
	for _, v := range proxyVars {
		if u := os.Getenv(v); u != "" {
			s.Proxies = append(s.Proxies, Proxy{Source: "env:" + v, URL: maskURL(u), Alive: dialAlive(u)})
		}
	}
	s.StaleProcs = findStaleProcs(run(ctx, "ps", "-E", "-ww", "-x", "-o", "pid=,command="), dialAlive)
	s.Tailscale = parseTailscale(run(ctx, tailscaleCLI(), "status", "--json"), p.ExitNodes)
	s.Tailscale.MeshHealOpen = meshHealCircuitOpen(time.Now())
	if !s.Online {
		return s
	}

	dctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	_, err := net.DefaultResolver.LookupHost(dctx, "api.anthropic.com")
	cancel()
	if err != nil {
		s.DNS = Result{Err: ErrDNS, Detail: err.Error()}
	} else {
		s.DNS = Result{OK: true}
	}
	s.Captive = probeCaptive(ctx)
	s.API = httpProbe(ctx, apiURL)
	s.Web = httpProbe(ctx, webURL)
	if r, body := httpGet(ctx, traceURL); r.OK {
		s.PublicIP, s.Loc = parseTrace(body)
	}
	return s
}

// directClient never uses a proxy: Argo measures the network itself, and
// dead proxies are reported separately. TLS verification is always on.
func directClient() *http.Client {
	tr := &http.Transport{
		Proxy:               nil,
		TLSHandshakeTimeout: 6 * time.Second,
		TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
	}
	return &http.Client{
		Transport:     tr,
		Timeout:       10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func httpGet(ctx context.Context, u string) (Result, string) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("User-Agent", "argo/"+version)
	resp, err := directClient().Do(req)
	if err != nil {
		kind, detail := classifyErr(err)
		return Result{Err: kind, Detail: detail}, ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	return Result{OK: true, Status: resp.StatusCode}, string(body)
}

func httpProbe(ctx context.Context, u string) Result {
	r, _ := httpGet(ctx, u)
	return r
}

func probeCaptive(ctx context.Context) Result {
	r, body := httpGet(ctx, captiveURL)
	if !r.OK {
		return r // network errors are classified elsewhere; not proof of a portal
	}
	if r.Status == 200 && strings.Contains(body, "Success") {
		return Result{OK: true, Status: 200}
	}
	return Result{Status: r.Status, Err: ErrPortal, Detail: "unexpected captive response"}
}

func classifyErr(err error) (string, string) {
	var dnsErr *net.DNSError
	var unknownCA x509.UnknownAuthorityError
	var certErr *tls.CertificateVerificationError
	var hostErr x509.HostnameError
	var netErr net.Error
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return ErrRefused, err.Error()
	case errors.As(err, &dnsErr):
		return ErrDNS, err.Error()
	case errors.As(err, &unknownCA), errors.As(err, &certErr), errors.As(err, &hostErr):
		return ErrTLSUntrusted, err.Error()
	case errors.As(err, &netErr) && netErr.Timeout():
		return ErrTimeout, err.Error()
	}
	return ErrOther, err.Error()
}

// dialAlive reports whether a proxy URL accepts TCP connections.
func dialAlive(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		u, err = url.Parse("http://" + raw)
		if err != nil {
			return false
		}
	}
	host := u.Host
	if u.Port() == "" {
		host = net.JoinHostPort(u.Hostname(), "80")
	}
	c, err := net.DialTimeout("tcp", host, 1500*time.Millisecond)
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func isLoopback(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	h := u.Hostname()
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// ---- parsers (pure; tested against recorded command output) ----

func parseDefaultRoute(out string) (gateway string, ok bool) {
	for _, line := range strings.Split(out, "\n") {
		if k, v, found := strings.Cut(strings.TrimSpace(line), ":"); found && k == "gateway" {
			gateway = strings.TrimSpace(v)
		}
	}
	return gateway, gateway != ""
}

var macRe = regexp.MustCompile(`\bat ([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b`)

func parseARP(out string) string {
	if m := macRe.FindStringSubmatch(strings.ToLower(out)); m != nil {
		return m[1]
	}
	return ""
}

func scutilValue(out, key string) string {
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), " : "); ok && k == key {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func parseScutilAuto(out string) (wpad, pac bool) {
	return scutilValue(out, "ProxyAutoDiscoveryEnable") == "1", scutilValue(out, "ProxyAutoConfigEnable") == "1"
}

func parseScutilProxies(out string) []Proxy {
	var ps []Proxy
	for _, kind := range []string{"HTTP", "HTTPS", "SOCKS"} {
		if scutilValue(out, kind+"Enable") != "1" {
			continue
		}
		host, port := scutilValue(out, kind+"Proxy"), scutilValue(out, kind+"Port")
		if host != "" {
			ps = append(ps, Proxy{Source: "system:" + kind, URL: "http://" + net.JoinHostPort(host, port)})
		}
	}
	return ps
}

var envProxyRe = regexp.MustCompile(`(?:^|\s)(?:HTTPS?_PROXY|ALL_PROXY|https?_proxy|all_proxy)=(\S+)`)

// findStaleProcs scans `ps -E` output for claude processes carrying a
// loopback proxy that no longer accepts connections.
func findStaleProcs(psOut string, alive func(string) bool) []StaleProc {
	var out []StaleProc
	cache := map[string]bool{}
	for _, line := range strings.Split(psOut, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || filepath.Base(fields[1]) != "claude" {
			continue
		}
		for _, m := range envProxyRe.FindAllStringSubmatch(line, -1) {
			u := m[1]
			if !isLoopback(u) {
				continue
			}
			ok, seen := cache[u]
			if !seen {
				ok = alive(u)
				cache[u] = ok
			}
			if !ok {
				out = append(out, StaleProc{PID: pid, Command: commandOnly(fields[1:]), Proxy: maskURL(u)})
				break
			}
		}
	}
	return out
}

var envAssignRe = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)

// commandOnly keeps at most three argv words and stops at the first VAR=value,
// because `ps -E` appends the environment (which may hold secrets) after argv.
func commandOnly(words []string) string {
	var keep []string
	for _, w := range words {
		if envAssignRe.MatchString(w) || len(keep) == 3 {
			break
		}
		keep = append(keep, w)
	}
	return strings.Join(keep, " ")
}

func parseTrace(body string) (ip, loc string) {
	sc := bufio.NewScanner(strings.NewReader(body))
	for sc.Scan() {
		k, v, _ := strings.Cut(sc.Text(), "=")
		switch k {
		case "ip":
			ip = v
		case "loc":
			loc = strings.ToUpper(v)
		}
	}
	return ip, loc
}

type tsPeer struct {
	HostName       string
	Online         bool
	ExitNode       bool
	ExitNodeOption bool
}

func parseTailscale(out string, allow map[string]string) Tailscale {
	var st struct {
		BackendState string
		Peer         map[string]tsPeer
	}
	if json.Unmarshal([]byte(out), &st) != nil {
		return Tailscale{}
	}
	t := Tailscale{Running: st.BackendState == "Running"}
	for _, p := range st.Peer {
		if p.ExitNode {
			t.ExitNode = p.HostName
		}
		if p.ExitNodeOption && p.Online && AllowedCountries[allow[p.HostName]] {
			t.ExitCandidates = append(t.ExitCandidates, p.HostName)
		}
	}
	return t
}

// meshHealCircuitOpen reads mesh-heal's KEY=VALUE state without sourcing it.
func meshHealCircuitOpen(now time.Time) bool {
	b, err := os.ReadFile(filepath.Join(home(), ".local/share/mesh-heal/state"))
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(b), "\n") {
		if v, ok := strings.CutPrefix(line, "circuit_until="); ok {
			until, _ := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
			return until > now.Unix()
		}
	}
	return false
}

// ---- helpers ----

func run(ctx context.Context, name string, args ...string) string {
	c, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(c, name, args...).Output()
	return string(out)
}

func tailscaleCLI() string {
	if p, err := exec.LookPath("tailscale"); err == nil {
		return p
	}
	return "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
}

func home() string {
	h, _ := os.UserHomeDir()
	return h
}
