package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/xml"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestDNSQueryWireFormat(t *testing.T) {
	q, err := dnsQuery("a.bc.")
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 'a', 2, 'b', 'c', 0, 0, 1, 0, 1}
	if !bytes.Equal(q, want) {
		t.Fatalf("%v", q)
	}
	for _, bad := range []string{"", "a..b", strings.Repeat("x", 64) + ".org", strings.Repeat("a.", 130)} {
		if _, err := dnsQuery(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func answer(flags uint16, an uint16) []byte {
	b := make([]byte, 12)
	binary.BigEndian.PutUint16(b[2:], flags)
	binary.BigEndian.PutUint16(b[6:], an)
	return b
}

func TestDNSAnswerOK(t *testing.T) {
	if err := dnsAnswerOK(answer(0x8180, 1)); err != nil {
		t.Fatal(err)
	}
	for name, b := range map[string][]byte{"short": {1, 2}, "query": answer(0x0100, 1), "servfail": answer(0x8182, 0), "nxdomain": answer(0x8183, 0), "empty": answer(0x8180, 0)} {
		if dnsAnswerOK(b) == nil {
			t.Errorf("%s accepted", name)
		}
	}
}

// A local DoH server with a test certificate: dohOnce must verify it, send RFC 8484 GETs and
// never follow a redirect.
func TestDoHOnceAgainstALocalServer(t *testing.T) {
	var got string
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ProtoMajor != 2 { // Quad9 answers HTTP/1.1 with 505 (2026-11-18)
			http.Error(w, "HTTP/2 only", http.StatusHTTPVersionNotSupported)
			return
		}
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "https://evil.example/", http.StatusFound)
			return
		}
		q, err := base64.RawURLEncoding.DecodeString(r.URL.Query().Get("dns"))
		if err != nil || r.Header.Get("Accept") != "application/dns-message" {
			http.Error(w, "bad", 400)
			return
		}
		got = string(q[12:])
		resp := append(answer(0x8180, 1), q[12:]...)
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(resp)
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	host, port, _ := net.SplitHostPort(srv.Listener.Addr().String())
	p := dnsProvider{ID: "test", Name: "Test", Host: "example.com", Path: "/dns-query", IPs: []string{host}, port: port}

	if _, err := dohOnce(context.Background(), p, host, "api.anthropic.com"); err == nil {
		t.Fatal("an untrusted certificate was accepted")
	}
	dohRoots = srv.Client().Transport.(*http.Transport).TLSClientConfig.RootCAs
	defer func() { dohRoots = nil }()
	if _, err := dohOnce(context.Background(), p, host, "api.anthropic.com"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "anthropic") {
		t.Fatalf("query not sent: %q", got)
	}
	p.Path = "/redirect"
	if _, err := dohOnce(context.Background(), p, host, "api.anthropic.com"); err == nil {
		t.Fatal("a redirect was followed or accepted")
	}
}

func fakeDoH(ms map[string]int) dohFunc {
	return func(_ context.Context, p dnsProvider, _, _ string) (time.Duration, error) {
		if v, ok := ms[p.ID]; ok {
			return time.Duration(v) * time.Millisecond, nil
		}
		return 0, errors.New("i/o timeout")
	}
}

func TestRankAndPickNearestResolver(t *testing.T) {
	r := rankResolvers(context.Background(), fakeDoH(map[string]int{"quad9": 40, "cloudflare": 12}), "x.org")
	if r[0].ID != "cloudflare" || r[1].ID != "quad9" || r[2].ID != "google" || r[2].OK != 0 || r[0].Ms != 12 {
		t.Fatalf("%+v", r)
	}
	if got := pickResolver(r); got != "cloudflare" {
		t.Fatalf("28 ms slower is not a tie: %s", got)
	}
	r = rankResolvers(context.Background(), fakeDoH(map[string]int{"quad9": 22, "cloudflare": 12, "google": 15}), "x.org")
	if got := pickResolver(r); got != "quad9" {
		t.Fatalf("within %s Quad9 wins on privacy: %s", privacySlack, got)
	}
	r = rankResolvers(context.Background(), fakeDoH(map[string]int{}), "x.org")
	if got := pickResolver(r); got != "" {
		t.Fatalf("nothing answered: %s", got)
	}
	if !dohReachable(context.Background(), fakeDoH(map[string]int{"cloudflare": 5})) || dohReachable(context.Background(), fakeDoH(nil)) {
		t.Fatal("dohReachable")
	}
}

// The real `scutil --dns` from judith on 2026-11-18 (tailnet name replaced).
const scutilJudith = `DNS configuration

resolver #1
  search domain[0] : tail0000.ts.net
  search domain[1] : lan
  nameserver[0] : 100.100.100.100
  nameserver[1] : fd7a:115c:a1e0::53
  if_index : 24 (utun7)
  flags    : Supplemental, Request A records, Request AAAA records
  reach    : 0x00000003 (Reachable,Transient Connection)
  order    : 101600

resolver #2
  nameserver[0] : 1.1.1.1
  nameserver[1] : 8.8.8.8
  flags    : Request A records
  reach    : 0x00000002 (Reachable)
  order    : 200000

resolver #3
  domain   : lan.
  nameserver[0] : 100.100.100.100
  flags    : Supplemental, Request A records, Request AAAA records

DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 192.168.88.1
  if_index : 15 (en0)
  flags    : Scoped, Request A records
`

func TestParseScutilDNSFindsThePlainPath(t *testing.T) {
	servers, tn := parseScutilDNS(scutilJudith)
	if strings.Join(servers, ",") != "1.1.1.1,8.8.8.8" || tn != "tail0000.ts.net" {
		t.Fatalf("%v %q", servers, tn)
	}
	p := DNSPath{Servers: servers, TailnetSuffix: tn}
	if ok, why := p.Private(); ok || !strings.Contains(why, "plain text to 1.1.1.1, 8.8.8.8") {
		t.Fatalf("%v %q", ok, why)
	}
	override := strings.Replace(scutilJudith, "flags    : Supplemental, Request A records, Request AAAA records\n  reach    : 0x00000003", "flags    : Request A records\n  reach    : 0x00000003", 1)
	servers, _ = parseScutilDNS(override)
	if !containsStr(servers, "100.100.100.100") {
		t.Fatalf("override local DNS not seen: %v", servers)
	}
}

func TestParseTailscaleDNS(t *testing.T) {
	none := "Resolvers (in preference order):\n  (no resolvers configured, system default will be used: see 'System DNS configuration' below)\n\nSplit DNS Routes:\n  - ts.net. -> 199.247.155.53\n"
	if c, d := parseTailscaleDNS(none); c || d {
		t.Fatal("judith's tailnet has no resolvers")
	}
	if c, d := parseTailscaleDNS("Resolvers (in preference order):\n  - 9.9.9.9\n  - 149.112.112.112\n\nSplit"); !c || !d {
		t.Fatal("Quad9 is upgraded to DoH")
	}
	if c, d := parseTailscaleDNS("Resolvers (in preference order):\n  - https://dns.nextdns.io/abc\n"); !c || !d {
		t.Fatal("an https resolver is DoH")
	}
	if c, d := parseTailscaleDNS("Resolvers (in preference order):\n  - 192.168.88.1\n\n"); !c || d {
		t.Fatal("a LAN resolver is plain")
	}
	for _, p := range []DNSPath{{Profile: true}, {ViaTailscale: true, TailnetDoH: true, Servers: []string{"100.100.100.100"}}} {
		if ok, _ := p.Private(); !ok {
			t.Errorf("%+v should be private", p)
		}
	}
	if ok, why := (DNSPath{ViaTailscale: true, Servers: []string{"100.100.100.100"}}).Private(); ok || !strings.Contains(why, "no DoH resolver") {
		t.Fatalf("%q", why)
	}
}

func TestMobileconfigIsAValidDNSProfile(t *testing.T) {
	p, _ := providerByID("quad9")
	n := 0
	uuid := func() string { n++; return "00000000-0000-4000-8000-00000000000" + string(rune('0'+n)) }
	doc := mobileconfig(p, profileDomains("tail0000.ts.net"), uuid)
	d := xml.NewDecoder(strings.NewReader(doc))
	for {
		if _, err := d.Token(); err == io.EOF {
			break
		} else if err != nil {
			t.Fatalf("not well-formed XML: %v", err)
		}
	}
	for _, w := range []string{"com.apple.dnsSettings.managed", "<string>HTTPS</string>", "https://dns.quad9.net/dns-query",
		"<string>9.9.9.9</string>", "<string>2620:fe::fe</string>", "NeverConnect", "<string>tail0000.ts.net</string>",
		"<string>ts.net</string>", "<string>gauss.internal</string>", "<key>PayloadRemovalDisallowed</key>\n\t<false/>", profileID} {
		if !strings.Contains(doc, w) {
			t.Errorf("profile lacks %q", w)
		}
	}
	if strings.Contains(doc, "ProhibitDisablement") {
		t.Fatal("the person must always be able to turn it off")
	}
	if runtime.GOOS == "darwin" {
		if _, err := os.Stat("/usr/bin/plutil"); err == nil {
			f := filepath.Join(t.TempDir(), "p.mobileconfig")
			_ = os.WriteFile(f, []byte(doc), 0o600)
			if out, err := exec.Command("/usr/bin/plutil", "-lint", f).CombinedOutput(); err != nil {
				t.Fatalf("plutil: %s", out)
			}
		}
	}
	if a := linuxAdvice(p); !strings.Contains(a, "DNS=9.9.9.9#dns.quad9.net 149.112.112.112#dns.quad9.net") || !strings.Contains(a, "DNSOverTLS=yes") {
		t.Fatalf("%q", a)
	}
}

func TestBrokenNetworkResolverPointsToPrivateDNS(t *testing.T) {
	s := Snapshot{Online: true, DNS: Result{Err: ErrDNS, Detail: "i/o timeout"}, API: Result{Err: ErrDNS}, IPUp: boolPtr(true), DoHOK: boolPtr(true)}
	c, why := Classify(s)
	if c != DNS || !strings.Contains(why, "encrypted DNS over port 443 works") {
		t.Fatalf("%s %q", c, why)
	}
	plan := Plan(c, s, "")
	if plan[0].ID != "private-dns" || plan[0].Auto || plan[0].Admin || plan[0].Command != "argo private-dns profile" {
		t.Fatalf("%+v", plan[0])
	}
	s.DoHOK = boolPtr(false)
	if p := Plan(DNS, s, ""); p[0].ID == "private-dns" {
		t.Fatal("encrypted DNS is no remedy when it is blocked too")
	}
	portal := Snapshot{Online: true, Captive: Result{Err: ErrPortal}, DNSProfile: true}
	if p := Plan(Captive, portal, ""); len(p) != 2 || p[1].ID != "pause-private-dns" {
		t.Fatalf("login page with the profile on: %v", ids(p))
	}
}
