package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// Private DNS (GAU-248). Josh, 2026-11-18: "privatise the argo network", "manage DNS issues",
// "a reduced hop service for internet connection servers for all devices on the network".
//
// Evidence on judith that day: `scutil --dns` sent every lookup outside the tailnet in plain text
// to 1.1.1.1 and 8.8.8.8 over whatever Wi-Fi was joined (Tailscale's 100.100.100.100 only answered
// ts.net), and `tailscale dns status` said the tailnet configures no resolvers. Any network on
// the way could read those lookups or answer them falsely.
//
// Argo does not run a DNS server for the other devices: on a laptop that roams and sleeps it
// would take every device's DNS down with it, and it would have to listen on the tailnet. Instead
// each device's Argo measures the encrypted resolvers from the network it is on, picks the
// nearest that works (anycast: the fewest hops is the lowest round trip), remembers that per
// network, and writes a profile the person installs. Argo never installs it or changes settings.

// dnsProvider is one public DNS-over-HTTPS service, reached by address so a broken or hijacked
// local resolver can't get in the way.
type dnsProvider struct {
	ID, Name string
	Host     string   // TLS name and DoH host
	Path     string   // DoH path
	IPs      []string // anycast addresses, IPv4 first
	Note     string   // why one would pick it
	port     string   // "" is 443; tests point it at a local server
}

// dohRoots is nil (the system's roots) except in tests.
var dohRoots *x509.CertPool

// dnsProviders: Quad9 first because it is a non-profit that says it keeps no client IPs, and it
// wins ties. Addresses and URLs are the providers' published ones.
var dnsProviders = []dnsProvider{
	{ID: "quad9", Name: "Quad9", Host: "dns.quad9.net", Path: "/dns-query",
		IPs: []string{"9.9.9.9", "149.112.112.112", "2620:fe::fe", "2620:fe::9"}, Note: "non-profit, no client IPs kept"},
	{ID: "cloudflare", Name: "Cloudflare", Host: "cloudflare-dns.com", Path: "/dns-query",
		IPs: []string{"1.1.1.1", "1.0.0.1", "2606:4700:4700::1111", "2606:4700:4700::1001"}, Note: "logs deleted within 24 h (its policy)"},
	{ID: "google", Name: "Google", Host: "dns.google", Path: "/dns-query",
		IPs: []string{"8.8.8.8", "8.8.4.4", "2001:4860:4860::8888", "2001:4860:4860::8844"}, Note: "fast almost everywhere; logs kept longer"},
}

func providerByID(id string) (dnsProvider, bool) {
	for _, p := range dnsProviders {
		if p.ID == id {
			return p, true
		}
	}
	return dnsProvider{}, false
}

const (
	dohTimeout   = 3 * time.Second
	dohTries     = 3
	privacySlack = 15 * time.Millisecond // Quad9 is kept when it is at most this much slower
)

// ---- DNS wire format (RFC 1035), just enough for one A query ----

// dnsQuery builds a recursive query for name's A record. ID 0, as RFC 8484 §4.1 recommends for
// cache-friendliness.
func dnsQuery(name string) ([]byte, error) {
	name = strings.TrimSuffix(name, ".")
	if name == "" || len(name) > 253 {
		return nil, errors.New("bad name")
	}
	var b bytes.Buffer
	b.Write([]byte{0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0}) // id 0, RD, 1 question
	for _, l := range strings.Split(name, ".") {
		if l == "" || len(l) > 63 {
			return nil, errors.New("bad label")
		}
		b.WriteByte(byte(len(l)))
		b.WriteString(l)
	}
	b.Write([]byte{0, 0, 1, 0, 1}) // root, type A, class IN
	return b.Bytes(), nil
}

// dnsAnswerOK checks a response header: a response (QR), NOERROR, at least one answer.
func dnsAnswerOK(b []byte) error {
	if len(b) < 12 {
		return errors.New("short DNS response")
	}
	flags := binary.BigEndian.Uint16(b[2:4])
	switch {
	case flags&0x8000 == 0:
		return errors.New("not a DNS response")
	case flags&0x000f != 0:
		return fmt.Errorf("DNS error rcode %d", flags&0x000f)
	case binary.BigEndian.Uint16(b[6:8]) == 0:
		return errors.New("no answers")
	}
	return nil
}

// ---- DoH probe ----

// dohFunc runs one DoH query against provider p at address ip and returns the round trip.
type dohFunc func(ctx context.Context, p dnsProvider, ip, name string) (time.Duration, error)

// dohOnce sends an RFC 8484 GET to p at ip, verifying p's certificate for p.Host. No proxy, no
// redirects, nothing from the response is used beyond the DNS header.
func dohOnce(ctx context.Context, p dnsProvider, ip, name string) (time.Duration, error) {
	q, err := dnsQuery(name)
	if err != nil {
		return 0, err
	}
	port := p.port
	if port == "" {
		port = "443"
	}
	addr := net.JoinHostPort(ip, port)
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			d := net.Dialer{Timeout: dohTimeout}
			return d.DialContext(ctx, network, addr) // by address: no lookup for the resolver itself
		},
		TLSClientConfig:     &tls.Config{ServerName: p.Host, MinVersion: tls.VersionTLS12, RootCAs: dohRoots},
		TLSHandshakeTimeout: dohTimeout,
		DisableKeepAlives:   true,
		ForceAttemptHTTP2:   true, // Quad9's DoH answers HTTP/1.1 with 505 (seen 2026-11-18)
	}
	defer tr.CloseIdleConnections()
	c := &http.Client{Transport: tr, Timeout: dohTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	u := "https://" + p.Host + p.Path + "?dns=" + base64.RawURLEncoding.EncodeToString(q)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/dns-message")
	t0 := time.Now()
	resp, err := c.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	rtt := time.Since(t0)
	if err != nil {
		return 0, err
	}
	if resp.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return rtt, dnsAnswerOK(body)
}

// ResolverRTT is one provider measured from here.
type ResolverRTT struct {
	ID    string `json:"id"`
	Ms    int    `json:"ms,omitempty"` // median DoH round trip, 0 when it failed
	OK    int    `json:"ok"`           // answers out of tries
	Tries int    `json:"tries"`
	Err   string `json:"err,omitempty"`
}

// rankResolvers measures every provider at once (its first IPv4 address, dohTries queries in a
// row, so the TLS setup cost is the same for all) and returns them fastest first, failures last.
func rankResolvers(ctx context.Context, doh dohFunc, name string) []ResolverRTT {
	out := make([]ResolverRTT, len(dnsProviders))
	done := make(chan struct{}, len(dnsProviders))
	for i, p := range dnsProviders {
		go func() {
			r := ResolverRTT{ID: p.ID, Tries: dohTries}
			var ms []int
			for range dohTries {
				d, err := doh(ctx, p, p.IPs[0], name)
				if err != nil {
					r.Err = err.Error()
					continue
				}
				ms = append(ms, max(int(d.Milliseconds()), 1))
			}
			if r.OK = len(ms); r.OK > 0 {
				sort.Ints(ms)
				r.Ms = ms[len(ms)/2]
			}
			out[i] = r
			done <- struct{}{}
		}()
	}
	for range dnsProviders {
		<-done
	}
	sort.SliceStable(out, func(i, j int) bool {
		if (out[i].OK > 0) != (out[j].OK > 0) {
			return out[i].OK > 0
		}
		return out[i].Ms < out[j].Ms
	})
	return out
}

// pickResolver is the fastest working provider, except that Quad9 is kept when it works and is
// within privacySlack of the fastest. "" when none worked.
func pickResolver(r []ResolverRTT) string {
	if len(r) == 0 || r[0].OK == 0 {
		return ""
	}
	for _, x := range r {
		if x.ID == dnsProviders[0].ID && x.OK > 0 && time.Duration(x.Ms-r[0].Ms)*time.Millisecond <= privacySlack {
			return x.ID
		}
	}
	return r[0].ID
}

// dohReachable: does encrypted DNS work from here at all? Used by the probe when the network's
// own DNS fails, so the advice can say the network's resolver is the problem.
func dohReachable(ctx context.Context, doh dohFunc) bool {
	ctx, cancel := context.WithTimeout(ctx, dohTimeout+time.Second)
	defer cancel()
	res := make(chan bool, 2)
	for _, p := range dnsProviders[:2] {
		go func() {
			_, err := doh(ctx, p, p.IPs[0], "api.anthropic.com")
			res <- err == nil
		}()
	}
	ok := <-res
	return ok || <-res
}

// ---- where this device's DNS goes now ----

// DNSPath is what the device uses for ordinary lookups.
type DNSPath struct {
	Servers       []string // default (non-supplemental) nameservers
	ViaTailscale  bool     // 100.100.100.100 answers everything (Tailscale "override local DNS")
	TailnetDoH    bool     // the tailnet configures resolvers Tailscale upgrades to DoH
	Profile       bool     // Argo's encrypted DNS profile is installed
	TailnetSuffix string   // e.g. tail4f9ebe.ts.net, kept out of the profile
	Linux         bool
}

const profileID = "uk.lightbound.argo.private-dns"

// parseScutilDNS reads the first section of `scutil --dns` (the scoped section is per interface)
// and returns the nameservers of resolvers that are neither supplemental nor domain-scoped, plus
// tailnet search domains.
func parseScutilDNS(out string) (servers []string, tailnet string) {
	if i := strings.Index(out, "DNS configuration (for scoped queries)"); i >= 0 {
		out = out[:i]
	}
	for _, block := range strings.Split(out, "\nresolver #") {
		var ns []string
		scoped := false
		for _, line := range strings.Split(block, "\n") {
			line = strings.TrimSpace(line)
			k, v, ok := strings.Cut(line, ":")
			if !ok {
				continue
			}
			k, v = strings.TrimSpace(k), strings.TrimSpace(v)
			switch {
			case strings.HasPrefix(k, "nameserver["):
				ns = append(ns, v)
			case k == "domain":
				scoped = true
			case k == "flags" && strings.Contains(v, "Supplemental"):
				scoped = true
			case strings.HasPrefix(k, "search domain[") && strings.HasSuffix(v, ".ts.net") && tailnet == "":
				tailnet = v
			}
		}
		if !scoped {
			for _, n := range ns {
				if !containsStr(servers, n) {
					servers = append(servers, n)
				}
			}
		}
	}
	return servers, tailnet
}

// parseTailscaleDNS reads `tailscale dns status`: does the tailnet hand out resolvers, and are
// they ones Tailscale upgrades to DoH (its documented "popular providers"; we only count the
// three above, by address, or an explicit https:// resolver)?
func parseTailscaleDNS(out string) (configured, doh bool) {
	_, after, ok := strings.Cut(out, "Resolvers (in preference order):")
	if !ok {
		return false, false
	}
	if i := strings.Index(after, "\n\n"); i >= 0 {
		after = after[:i]
	}
	if strings.Contains(after, "no resolvers configured") {
		return false, false
	}
	for _, line := range strings.Split(after, "\n") {
		v := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "-"))
		if v == "" {
			continue
		}
		configured = true
		if strings.HasPrefix(v, "https://") || knownDoHIP(v) {
			doh = true
		}
	}
	return configured, doh
}

func knownDoHIP(v string) bool {
	for _, p := range dnsProviders {
		if containsStr(p.IPs, v) {
			return true
		}
	}
	return false
}

func containsStr(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// readDNSPath gathers the facts; every command has a pinned path and fixed arguments.
func readDNSPath(ctx context.Context) DNSPath {
	var p DNSPath
	if runtime.GOOS != "darwin" {
		p.Linux = true
		b, _ := os.ReadFile("/etc/resolv.conf")
		for _, line := range strings.Split(string(b), "\n") {
			if f := strings.Fields(line); len(f) >= 2 && f[0] == "nameserver" {
				p.Servers = append(p.Servers, f[1])
			}
		}
		return p
	}
	p.Servers, p.TailnetSuffix = parseScutilDNS(run(ctx, "/usr/sbin/scutil", "--dns"))
	p.ViaTailscale = containsStr(p.Servers, "100.100.100.100")
	if p.ViaTailscale {
		_, p.TailnetDoH = parseTailscaleDNS(run(ctx, tailscaleCLI(), "dns", "status"))
	}
	p.Profile = strings.Contains(run(ctx, "/usr/bin/profiles", "list"), profileID)
	return p
}

// Private reports whether ordinary lookups leave this device encrypted, and why.
func (p DNSPath) Private() (bool, string) {
	switch {
	case p.Profile:
		return true, "Argo's encrypted DNS profile is installed"
	case p.ViaTailscale && p.TailnetDoH:
		return true, "Tailscale answers all lookups and sends them on over DNS-over-HTTPS"
	case p.ViaTailscale:
		return false, "Tailscale answers all lookups but the tailnet names no DoH resolver, so they leave in plain text"
	case len(p.Servers) == 0:
		return false, "no DNS servers found"
	}
	return false, "lookups go in plain text to " + strings.Join(p.Servers, ", ") + ": this network can read and change them"
}

// ---- the profile ----

// profileDomains stay with the normal resolvers: the tailnet (MagicDNS), headscale's planned
// domain and local names. Without this a DNS profile can break MagicDNS.
func profileDomains(tailnet string) []string {
	d := []string{"ts.net", "gauss.internal", "local", "lan", "home.arpa"}
	if tailnet != "" && !containsStr(d, tailnet) {
		d = append([]string{tailnet}, d...)
	}
	return d
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%X-%X-%X-%X-%X", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func xmlEsc(s string) string {
	var b bytes.Buffer
	for _, r := range s {
		switch r {
		case '&':
			b.WriteString("&amp;")
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// mobileconfig is an unsigned configuration profile with one DNS Settings payload
// (com.apple.dnsSettings.managed, DNSProtocol HTTPS). macOS and iOS ask the person to approve it
// in Settings; it can be removed there at any time (PayloadRemovalDisallowed false).
func mobileconfig(p dnsProvider, domains []string, uuid func() string) string {
	var ips, doms strings.Builder
	for _, ip := range p.IPs {
		fmt.Fprintf(&ips, "\t\t\t\t\t<string>%s</string>\n", xmlEsc(ip))
	}
	for _, d := range domains {
		fmt.Fprintf(&doms, "\t\t\t\t\t\t\t\t<string>%s</string>\n", xmlEsc(d))
	}
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>DNSSettings</key>
			<dict>
				<key>DNSProtocol</key>
				<string>HTTPS</string>
				<key>ServerURL</key>
				<string>https://` + xmlEsc(p.Host+p.Path) + `</string>
				<key>ServerAddresses</key>
				<array>
` + ips.String() + `				</array>
			</dict>
			<key>OnDemandRules</key>
			<array>
				<dict>
					<key>Action</key>
					<string>EvaluateConnection</string>
					<key>ActionParameters</key>
					<array>
						<dict>
							<key>DomainAction</key>
							<string>NeverConnect</string>
							<key>Domains</key>
							<array>
` + doms.String() + `							</array>
						</dict>
					</array>
				</dict>
				<dict>
					<key>Action</key>
					<string>Connect</string>
				</dict>
			</array>
			<key>PayloadDisplayName</key>
			<string>Argo private DNS (` + xmlEsc(p.Name) + `)</string>
			<key>PayloadIdentifier</key>
			<string>` + profileID + `.dns</string>
			<key>PayloadType</key>
			<string>com.apple.dnsSettings.managed</string>
			<key>PayloadUUID</key>
			<string>` + uuid() + `</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDescription</key>
	<string>Encrypts this device's DNS lookups (DNS over HTTPS to ` + xmlEsc(p.Name) + `), chosen by Argo as the nearest working resolver. Tailnet and local names keep using the normal resolver. Remove it in Settings at any time.</string>
	<key>PayloadDisplayName</key>
	<string>Argo private DNS</string>
	<key>PayloadIdentifier</key>
	<string>` + profileID + `</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>` + uuid() + `</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`
}

// linuxAdvice is the systemd-resolved equivalent (DNS over TLS), for Linux devices on the mesh.
func linuxAdvice(p dnsProvider) string {
	var s []string
	for _, ip := range p.IPs[:2] {
		s = append(s, ip+"#"+p.Host)
	}
	return "In /etc/systemd/resolved.conf under [Resolve]: DNS=" + strings.Join(s, " ") +
		" and DNSOverTLS=yes, then: sudo systemctl restart systemd-resolved"
}

// ---- the command ----

// privateDNSCmd is `argo private-dns [status|profile] [--json] [--provider ID] [--out FILE]`.
// It measures, prints, remembers the choice for the current network and, for `profile`, writes
// the file. It never installs anything and changes no setting.
func privateDNSCmd(ctx context.Context, store Store, args []string, w io.Writer) error {
	sub, provider, out := "status", "", ""
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case a == "status" || a == "profile":
			sub = a
		case (a == "--provider" || a == "--out") && i+1 < len(args):
			if a == "--provider" {
				provider = args[i+1]
			} else {
				out = args[i+1]
			}
			i++
		default:
			return errors.New("usage: argo private-dns [status|profile] [--provider quad9|cloudflare|google] [--out FILE]")
		}
	}
	if provider != "" {
		if _, ok := providerByID(provider); !ok {
			return fmt.Errorf("unknown provider %q (quad9, cloudflare, google)", provider)
		}
	}
	path := readDNSPath(ctx)
	ranked := rankResolvers(ctx, dohOnce, "api.anthropic.com")
	pick := pickResolver(ranked)

	var fp string
	_ = withLock(store, func() {
		st := store.Load()
		if fp = st.Fingerprint; fp == "" || pick == "" {
			return
		}
		n := st.Networks[fp]
		n.PrivateDNS = pick
		st.Networks[fp] = n
		_ = store.Save(st)
	})

	reportPrivateDNS(w, path, ranked, pick)
	if sub != "profile" {
		return nil
	}
	if provider == "" {
		provider = pick
	}
	if provider == "" {
		return errors.New("no encrypted resolver answered from this network, so there is nothing to pick; try --provider quad9 to write one anyway")
	}
	p, _ := providerByID(provider)
	if path.Linux {
		fmt.Fprintln(w, linuxAdvice(p))
		return nil
	}
	if out == "" {
		out = filepath.Join(store.Dir, "argo-private-dns.mobileconfig")
	}
	if err := os.WriteFile(out, []byte(mobileconfig(p, profileDomains(path.TailnetSuffix), newUUID)), 0o600); err != nil {
		return err
	}
	fmt.Fprintf(w, "\nWrote %s (%s).\n", out, p.Name)
	fmt.Fprintln(w, "Install on this Mac: open it (`open "+shellQuote(out)+"`), then approve it in System Settings (search \"Profiles\").")
	fmt.Fprintln(w, "iPhone: AirDrop the file, then Settings > General > VPN & Device Management. Remove it there to undo.")
	fmt.Fprintln(w, "If a Wi-Fi login page won't load, remove the profile, log in, then add it again (UNVERIFIED how macOS handles login pages with it on).")
	return nil
}

func reportPrivateDNS(w io.Writer, path DNSPath, ranked []ResolverRTT, pick string) {
	private, why := path.Private()
	if private {
		fmt.Fprintln(w, "DNS: private. "+why+".")
	} else {
		fmt.Fprintln(w, "DNS: not private. "+why+".")
	}
	fmt.Fprintln(w, "Encrypted resolvers from this network (DNS over HTTPS, by address):")
	for _, r := range ranked {
		p, _ := providerByID(r.ID)
		mark := "  "
		if r.ID == pick {
			mark = "→ "
		}
		if r.OK == 0 {
			fmt.Fprintf(w, "%s%-10s no answer (%s)\n", mark, p.Name, Mask(r.Err))
			continue
		}
		fmt.Fprintf(w, "%s%-10s %4d ms  %d/%d  %s\n", mark, p.Name, r.Ms, r.OK, r.Tries, p.Note)
	}
	if pick == "" {
		fmt.Fprintln(w, "None answered: this network blocks encrypted DNS, or nothing gets out (see argo doctor).")
		return
	}
	if private {
		return
	}
	p, _ := providerByID(pick)
	fmt.Fprintln(w, "To make it private:")
	if path.Linux {
		fmt.Fprintln(w, "  "+linuxAdvice(p))
	} else {
		fmt.Fprintf(w, "  1. This device: argo private-dns profile  (writes a %s profile you approve once; also for the iPhone)\n", p.Name)
	}
	fmt.Fprintf(w, "  2. Whole tailnet (a tailnet admin, Tailscale admin console > DNS): add %s as a global nameserver and turn on Override local DNS; Tailscale then sends lookups over DNS-over-HTTPS. Argo never changes Tailscale settings.\n", p.Name)
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
