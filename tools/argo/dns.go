package main

// `argo dns` is the read-only half of the DNS guard. A desired-state file
// (~/.config/argo/dns.json, example in examples/dns.json) says what each zone
// should publish: the site records, mail authentication (SPF, DKIM, DMARC,
// MTA-STS, TLS-RPT), CAA, DNSSEC and the HTTP redirect. `check` resolves every
// record twice (Cloudflare's 1.1.1.1 and the system resolver), prints one line
// per record and exits 2 on drift; `plan` prints the Cloudflare API requests
// that would close the gap; `apply` is a gated stub. Nothing here holds a token
// or writes to Cloudflare. Wire format: RFC 1035; EDNS(0)/DO: RFC 6891, RFC
// 4035; CAA: RFC 8659; DS: RFC 4034; SPF: RFC 7208; DKIM: RFC 6376; DMARC:
// RFC 7489; MTA-STS: RFC 8461; TLS-RPT: RFC 8460.

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"
)

// DNSSpec is the desired state: one entry per zone.
type DNSSpec struct {
	Zones []DNSZone `json:"zones"`
}

type DNSZone struct {
	Name    string      `json:"name"`
	Note    string      `json:"note,omitempty"`
	DNSSEC  bool        `json:"dnssec,omitempty"` // a DS must exist at the parent
	Records []DNSRecord `json:"records"`
	HTTP    []DNSHTTP   `json:"http,omitempty"` // redirects are checked over HTTP, not DNS
}

// DNSRecord is one expected record. Exactly one of Value, Values, Stages,
// Present or Proxied describes what "ok" means:
//   - Value/Values: the record set must equal these (MX, CAA, a fixed A) or,
//     for TXT, the one record with the same prefix ("v=spf1", "v=DMARC1",
//     "google-site-verification") must equal Value.
//   - Stages: accepted values in order; any stage is ok, the last is the
//     target, `plan` prints the next one under "Later".
//   - Match "tags": compare `k=v;` lists tag by tag (DMARC, DKIM, MTA-STS,
//     TLS-RPT); Require names tags that must be present with any value, so
//     an existing rua is kept without putting its address in this file.
//   - Present: any value will do (DKIM until the key is generated).
//   - Proxied: A/AAAA answers must all be Cloudflare's (orange cloud); the
//     addresses themselves are not pinned.
type DNSRecord struct {
	Name    string   `json:"name"` // "@" or a label relative to the zone
	Type    string   `json:"type"` // A, AAAA, TXT, MX, CAA
	Value   string   `json:"value,omitempty"`
	Values  []string `json:"values,omitempty"`
	Stages  []string `json:"stages,omitempty"`
	Match   string   `json:"match,omitempty"`
	Require []string `json:"require,omitempty"`
	Present bool     `json:"present,omitempty"`
	Prefix  string   `json:"prefix,omitempty"` // with present on TXT: count only records starting with this
	Proxied *bool    `json:"proxied,omitempty"`
	Note    string   `json:"note,omitempty"`
}

type DNSHTTP struct {
	URL      string `json:"url"`
	Status   int    `json:"status"`
	Location string `json:"location"` // prefix of the Location header
}

// dnsResult is one line of `argo dns check`.
type dnsResult struct {
	Zone     string `json:"zone"`
	Name     string `json:"name"`
	Type     string `json:"type"`
	Status   string `json:"status"` // ok, missing, differs, unverified
	Expected string `json:"expected,omitempty"`
	Found    string `json:"found,omitempty"`
	Note     string `json:"note,omitempty"`
	rec      *DNSRecord
	found    []string
	stage    int // index of the matched stage, -1 when none
}

var dnsRecordTypes = map[string]uint16{"A": dnsTypeA, "AAAA": dnsTypeAAAA, "TXT": dnsTypeTXT, "MX": dnsTypeMX, "CAA": dnsTypeCAA, "DS": dnsTypeDS}

func dnsSpecPath() string { return filepath.Join(configDir(), "dns.json") }

func loadDNSSpec(path string) (DNSSpec, error) {
	var s DNSSpec
	b, err := os.ReadFile(path)
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(b, &s); err != nil {
		return s, fmt.Errorf("%s: %w", path, err)
	}
	return s, validateDNSSpec(s)
}

func validateDNSSpec(s DNSSpec) error {
	if len(s.Zones) == 0 {
		return errors.New("dns.json has no zones")
	}
	for _, z := range s.Zones {
		if z.Name == "" || strings.ContainsAny(z.Name, " /:") {
			return fmt.Errorf("zone name %q", z.Name)
		}
		for _, r := range z.Records {
			if _, ok := dnsRecordTypes[r.Type]; !ok || r.Type == "DS" {
				return fmt.Errorf("%s %s: record type %s is not supported (A, AAAA, TXT, MX, CAA)", z.Name, r.Name, r.Type)
			}
			if r.Name == "" {
				return fmt.Errorf("%s: a %s record has no name", z.Name, r.Type)
			}
			n := 0
			for _, set := range []bool{r.Value != "", len(r.Values) > 0, len(r.Stages) > 0, r.Present, r.Proxied != nil} {
				if set {
					n++
				}
			}
			if n != 1 {
				return fmt.Errorf("%s %s %s: give exactly one of value, values, stages, present, proxied", z.Name, r.Name, r.Type)
			}
			if r.Proxied != nil && r.Type != "A" && r.Type != "AAAA" {
				return fmt.Errorf("%s %s: proxied applies to A and AAAA only", z.Name, r.Name)
			}
			if r.Prefix != "" && (!r.Present || r.Type != "TXT") {
				return fmt.Errorf("%s %s: prefix goes with present on a TXT record", z.Name, r.Name)
			}
			if r.Match != "" && r.Match != "tags" {
				return fmt.Errorf("%s %s: match must be empty or \"tags\"", z.Name, r.Name)
			}
		}
		for _, h := range z.HTTP {
			if !strings.HasPrefix(h.URL, "http://") && !strings.HasPrefix(h.URL, "https://") {
				return fmt.Errorf("%s: http url %q", z.Name, h.URL)
			}
		}
	}
	return nil
}

// ---- resolvers ----

// dnsLookup answers one question with normalised record strings:
// A/AAAA "1.2.3.4"; TXT the joined character-strings; MX "10 host" ("0 ." for
// a null MX); CAA "0 issue ca.example"; DS "keytag alg digesttype hex".
// NXDOMAIN and NODATA are an empty answer, not an error.
type dnsLookup interface {
	Name() string
	Lookup(ctx context.Context, fqdn, qtype string) ([]string, error)
}

var errDNSUnsupported = errors.New("no lookup for this record type")

// dnsEnv holds what the command needs from outside; tests replace it.
type dnsEnv struct {
	Resolvers []dnsLookup
	HTTP      func(ctx context.Context, url string) (status int, location string, err error)
}

func realDNSEnv() dnsEnv {
	return dnsEnv{
		Resolvers: []dnsLookup{wireResolver{server: "1.1.1.1:53", name: "1.1.1.1"}, sysResolver{}},
		HTTP:      httpRedirectProbe,
	}
}

// httpRedirectProbe fetches one URL without following redirects. TLS
// verification stays on; a bad certificate is reported as unverified.
func httpRedirectProbe(ctx context.Context, url string) (int, string, error) {
	c := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("User-Agent", "argo-dns/"+version)
	resp, err := c.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.StatusCode, resp.Header.Get("Location"), nil
}

// sysResolver uses the system resolver through net.Resolver, which has no
// CAA or DS lookups; those are answered by 1.1.1.1 only.
type sysResolver struct{}

func (sysResolver) Name() string { return "system" }

func (sysResolver) Lookup(ctx context.Context, fqdn, qtype string) ([]string, error) {
	r := net.DefaultResolver
	var out []string
	var err error
	switch qtype {
	case "A", "AAAA":
		network := "ip4"
		if qtype == "AAAA" {
			network = "ip6"
		}
		var ips []net.IP
		ips, err = r.LookupIP(ctx, network, fqdn)
		for _, ip := range ips {
			out = append(out, ip.String())
		}
	case "TXT":
		out, err = r.LookupTXT(ctx, fqdn)
	case "MX":
		var mxs []*net.MX
		mxs, err = r.LookupMX(ctx, fqdn)
		for _, m := range mxs {
			out = append(out, fmt.Sprintf("%d %s", m.Pref, dnsHost(m.Host)))
		}
	default:
		return nil, errDNSUnsupported
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
		return nil, nil
	}
	return out, err
}

func dnsHost(h string) string {
	h = strings.TrimSuffix(strings.ToLower(h), ".")
	if h == "" {
		return "."
	}
	return h
}

// wireResolver asks one server directly (RFC 1035 over UDP, TCP when
// truncated) with EDNS(0) and the DO bit, so DS and CAA work and the AD flag
// says whether the server validated the answer.
type wireResolver struct {
	server string
	name   string
}

func (w wireResolver) Name() string { return w.name }

const (
	dnsTypeA    uint16 = 1
	dnsTypeAAAA uint16 = 28
	dnsTypeTXT  uint16 = 16
	dnsTypeMX   uint16 = 15
	dnsTypeCAA  uint16 = 257
	dnsTypeDS   uint16 = 43
	dnsTypeOPT  uint16 = 41
)

func (w wireResolver) Lookup(ctx context.Context, fqdn, qtype string) ([]string, error) {
	typ, ok := dnsRecordTypes[qtype]
	if !ok {
		return nil, errDNSUnsupported
	}
	out, _, err := w.query(ctx, fqdn, typ)
	return out, err
}

func (w wireResolver) query(ctx context.Context, fqdn string, typ uint16) ([]string, bool, error) {
	var idb [2]byte
	if _, err := rand.Read(idb[:]); err != nil {
		return nil, false, err
	}
	id := binary.BigEndian.Uint16(idb[:])
	msg := buildDNSQuery(id, fqdn, typ)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := dnsExchange(ctx, "udp", w.server, msg)
	if err == nil && len(resp) > 2 && resp[2]&0x02 != 0 { // TC: ask again over TCP
		resp, err = dnsExchange(ctx, "tcp", w.server, msg)
	}
	if err != nil {
		return nil, false, err
	}
	return parseDNSResponse(resp, id, typ)
}

func dnsExchange(ctx context.Context, network, server string, msg []byte) ([]byte, error) {
	var d net.Dialer
	c, err := d.DialContext(ctx, network, server)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = c.SetDeadline(dl)
	}
	if network == "tcp" {
		msg = append([]byte{byte(len(msg) >> 8), byte(len(msg))}, msg...)
	}
	if _, err := c.Write(msg); err != nil {
		return nil, err
	}
	if network == "tcp" {
		var l [2]byte
		if _, err := io.ReadFull(c, l[:]); err != nil {
			return nil, err
		}
		buf := make([]byte, binary.BigEndian.Uint16(l[:]))
		_, err := io.ReadFull(c, buf)
		return buf, err
	}
	buf := make([]byte, 4096)
	n, err := c.Read(buf)
	return buf[:n], err
}

func encodeDNSName(name string) []byte {
	var b []byte
	for _, l := range strings.Split(strings.TrimSuffix(name, "."), ".") {
		if l == "" {
			continue
		}
		b = append(b, byte(len(l)))
		b = append(b, l...)
	}
	return append(b, 0)
}

func buildDNSQuery(id uint16, fqdn string, typ uint16) []byte {
	m := []byte{byte(id >> 8), byte(id), 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 1} // RD; one question, one OPT
	m = append(m, encodeDNSName(fqdn)...)
	m = append(m, byte(typ>>8), byte(typ), 0, 1)
	// OPT (RFC 6891): root name, type 41, UDP size 1232, ext-rcode 0, version 0, DO (RFC 4035 §3.2.1).
	return append(m, 0, byte(dnsTypeOPT>>8), byte(dnsTypeOPT), 0x04, 0xd0, 0, 0, 0x80, 0, 0, 0)
}

// readDNSName decodes a possibly compressed name (RFC 1035 §4.1.4).
func readDNSName(msg []byte, off int) (string, int, error) {
	var labels []string
	next, jumped, hops := 0, false, 0
	for {
		if off >= len(msg) {
			return "", 0, errors.New("dns: name runs past the message")
		}
		l := int(msg[off])
		switch {
		case l == 0:
			off++
			if !jumped {
				next = off
			}
			return strings.Join(labels, "."), next, nil
		case l&0xc0 == 0xc0:
			if off+1 >= len(msg) {
				return "", 0, errors.New("dns: bad pointer")
			}
			if hops++; hops > 20 {
				return "", 0, errors.New("dns: pointer loop")
			}
			if !jumped {
				next = off + 2
			}
			off, jumped = int(binary.BigEndian.Uint16(msg[off:])&0x3fff), true
		default:
			off++
			if off+l > len(msg) {
				return "", 0, errors.New("dns: label runs past the message")
			}
			labels = append(labels, string(msg[off:off+l]))
			off += l
		}
	}
}

// parseDNSResponse returns the answer-section records of type typ, the AD
// flag, and an error for a bad id or a server failure. NXDOMAIN is empty.
func parseDNSResponse(msg []byte, id uint16, typ uint16) ([]string, bool, error) {
	if len(msg) < 12 {
		return nil, false, errors.New("dns: short response")
	}
	if binary.BigEndian.Uint16(msg) != id {
		return nil, false, errors.New("dns: response id mismatch")
	}
	ad := msg[3]&0x20 != 0
	switch rcode := msg[3] & 0x0f; rcode {
	case 0:
	case 3: // NXDOMAIN
		return nil, ad, nil
	default:
		return nil, ad, fmt.Errorf("dns: rcode %d", rcode)
	}
	qd, an := int(binary.BigEndian.Uint16(msg[4:])), int(binary.BigEndian.Uint16(msg[6:]))
	off := 12
	for i := 0; i < qd; i++ {
		_, n, err := readDNSName(msg, off)
		if err != nil {
			return nil, ad, err
		}
		off = n + 4
	}
	var out []string
	for i := 0; i < an; i++ {
		_, n, err := readDNSName(msg, off)
		if err != nil {
			return nil, ad, err
		}
		if n+10 > len(msg) {
			return nil, ad, errors.New("dns: short record")
		}
		rtyp := binary.BigEndian.Uint16(msg[n:])
		rdlen := int(binary.BigEndian.Uint16(msg[n+8:]))
		rd := n + 10
		if rd+rdlen > len(msg) {
			return nil, ad, errors.New("dns: rdata runs past the message")
		}
		data := msg[rd : rd+rdlen]
		off = rd + rdlen
		if rtyp != typ {
			continue
		}
		s, err := dnsRData(msg, rd, typ, data)
		if err != nil {
			return nil, ad, err
		}
		out = append(out, s)
	}
	return out, ad, nil
}

func dnsRData(msg []byte, rd int, typ uint16, data []byte) (string, error) {
	switch typ {
	case dnsTypeA:
		if len(data) != 4 {
			return "", errors.New("dns: bad A")
		}
		return net.IP(data).String(), nil
	case dnsTypeAAAA:
		if len(data) != 16 {
			return "", errors.New("dns: bad AAAA")
		}
		return net.IP(data).String(), nil
	case dnsTypeTXT:
		var sb strings.Builder
		for i := 0; i < len(data); {
			l := int(data[i])
			if i+1+l > len(data) {
				return "", errors.New("dns: bad TXT")
			}
			sb.Write(data[i+1 : i+1+l])
			i += 1 + l
		}
		return sb.String(), nil
	case dnsTypeMX:
		if len(data) < 3 {
			return "", errors.New("dns: bad MX")
		}
		host, _, err := readDNSName(msg, rd+2)
		if err != nil {
			return "", err
		}
		return fmt.Sprintf("%d %s", binary.BigEndian.Uint16(data), dnsHost(host)), nil
	case dnsTypeCAA: // RFC 8659 §4.1
		if len(data) < 2 || 2+int(data[1]) > len(data) {
			return "", errors.New("dns: bad CAA")
		}
		tl := int(data[1])
		return fmt.Sprintf("%d %s %s", data[0], strings.ToLower(string(data[2:2+tl])), string(data[2+tl:])), nil
	case dnsTypeDS: // RFC 4034 §5.1
		if len(data) < 4 {
			return "", errors.New("dns: bad DS")
		}
		return fmt.Sprintf("%d %d %d %s", binary.BigEndian.Uint16(data), data[2], data[3], hex.EncodeToString(data[4:])), nil
	}
	return "", errDNSUnsupported
}

// ---- comparison ----

// cloudflareNets is Cloudflare's published edge list (https://www.cloudflare.com/ips/,
// read 2026-11-05). An answer outside it is "unverified", never "ok", so a
// list change makes the check more cautious, not wrong.
var cloudflareNets = parseCIDRs(
	"173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18",
	"108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17",
	"162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
	"2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32",
	"2a06:98c0::/29", "2c0f:f248::/32")

// tailnetNet is CGNAT space (RFC 6598), which Tailscale uses for 100.x addresses.
var tailnetNet = parseCIDRs("100.64.0.0/10")

func parseCIDRs(cidrs ...string) []*net.IPNet {
	var out []*net.IPNet
	for _, c := range cidrs {
		if _, n, err := net.ParseCIDR(c); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func inNets(ip net.IP, nets []*net.IPNet) bool {
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// txtPrefix picks the TXT record a spec talks about: "v=spf1", "v=DMARC1",
// "google-site-verification", so other TXT records at the same name are ignored.
func txtPrefix(v string) string {
	v = strings.TrimSpace(v)
	if strings.HasPrefix(strings.ToLower(v), "v=") {
		if i := strings.IndexAny(v, "; "); i > 0 {
			return strings.ToLower(v[:i])
		}
		return strings.ToLower(v)
	}
	if i := strings.Index(v, "="); i > 0 {
		return strings.ToLower(v[:i+1])
	}
	return strings.ToLower(v)
}

// parseTags reads a "k=v; k=v" list (DMARC/DKIM/MTA-STS/TLS-RPT syntax) keeping order.
func parseTags(s string) (keys []string, vals map[string]string) {
	vals = map[string]string{}
	for _, part := range strings.Split(s, ";") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		k, v, _ := strings.Cut(part, "=")
		k = strings.ToLower(strings.TrimSpace(k))
		if _, dup := vals[k]; !dup {
			keys = append(keys, k)
		}
		vals[k] = strings.TrimSpace(v)
	}
	return keys, vals
}

func matchTags(want, got string, require []string) (bool, string) {
	_, w := parseTags(want)
	_, g := parseTags(got)
	for k, v := range w {
		if g[k] != v {
			return false, ""
		}
	}
	for _, k := range require {
		if _, ok := g[strings.ToLower(k)]; !ok {
			return false, "tag " + k + " must be kept"
		}
	}
	return true, ""
}

// mergeTags overlays want's tags on got's, keeping got's extra tags (the rua).
func mergeTags(want, got string) string {
	wk, wv := parseTags(want)
	gk, gv := parseTags(got)
	var parts []string
	for _, k := range wk {
		parts = append(parts, k+"="+wv[k])
	}
	for _, k := range gk {
		if _, ok := wv[k]; !ok {
			parts = append(parts, k+"="+gv[k])
		}
	}
	return strings.Join(parts, "; ")
}

func normSet(vals []string, typ string) []string {
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		v = strings.TrimSpace(v)
		if typ == "MX" {
			if p, h, ok := strings.Cut(v, " "); ok {
				v = p + " " + dnsHost(h)
			}
		}
		if typ == "A" || typ == "AAAA" {
			if ip := net.ParseIP(v); ip != nil {
				v = ip.String()
			}
		}
		if typ == "CAA" {
			v = strings.Join(strings.Fields(strings.ReplaceAll(v, "\"", "")), " ")
		}
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// compareRecord decides ok / missing / differs / unverified for one record.
func compareRecord(r DNSRecord, found []string) dnsResult {
	res := dnsResult{Name: r.Name, Type: r.Type, Found: strings.Join(found, " | "), rec: &r, found: found, stage: -1}
	switch {
	case r.Present:
		res.Expected = "any value"
		if r.Prefix != "" {
			var keep []string
			for _, f := range found {
				if strings.HasPrefix(strings.ToLower(strings.TrimSpace(f)), strings.ToLower(r.Prefix)) {
					keep = append(keep, f)
				}
			}
			found, res.Found, res.Expected = keep, strings.Join(keep, " | "), r.Prefix+"…"
		}
		if len(found) == 0 {
			res.Status = "missing"
		} else {
			res.Status, res.Note = "ok", "present; exact value TBC"
		}
	case r.Proxied != nil && *r.Proxied:
		res.Expected = "proxied (Cloudflare edge)"
		if len(found) == 0 {
			res.Status = "missing"
			return res
		}
		res.Status = "ok"
		for _, f := range found {
			ip := net.ParseIP(f)
			switch {
			case ip != nil && inNets(ip, tailnetNet):
				res.Status, res.Note = "differs", "tailnet address exposed in public DNS"
				return res
			case ip == nil || !inNets(ip, cloudflareNets):
				res.Status, res.Note = "unverified", "address not in Cloudflare's published ranges (list read 2026-11-05); check the orange cloud"
			}
		}
	case r.Type == "TXT":
		want := r.Stages
		if len(want) == 0 {
			want = []string{r.Value}
		}
		res.Expected = want[len(want)-1]
		prefix := txtPrefix(want[0])
		var cands []string
		for _, f := range found {
			if strings.HasPrefix(strings.ToLower(strings.TrimSpace(f)), prefix) {
				cands = append(cands, strings.TrimSpace(f))
			}
		}
		res.Found = strings.Join(cands, " | ")
		switch {
		case len(cands) == 0:
			res.Status = "missing"
		case len(cands) > 1:
			res.Status, res.Note = "differs", fmt.Sprintf("%d records start with %s; there must be one", len(cands), prefix)
		default:
			res.Status = "differs"
			var why string
			for i, w := range want {
				var ok bool
				if r.Match == "tags" {
					var reason string
					if ok, reason = matchTags(w, cands[0], r.Require); why == "" {
						why = reason
					}
				} else {
					ok = strings.TrimSpace(w) == cands[0]
				}
				if ok {
					res.Status, res.stage = "ok", i
					if len(want) > 1 && i < len(want)-1 {
						res.Note = fmt.Sprintf("stage %d of %d; target: %s", i+1, len(want), want[len(want)-1])
					} else if len(want) > 1 {
						res.Note = "target stage"
					}
					break
				}
			}
			if res.Status == "differs" && why != "" {
				res.Note = why
			}
		}
	default: // A, AAAA, MX, CAA: the whole set must match
		want := r.Values
		if len(want) == 0 {
			want = []string{r.Value}
		}
		res.Expected = strings.Join(want, " | ")
		switch {
		case len(found) == 0:
			res.Status = "missing"
		case sameSet(normSet(want, r.Type), normSet(found, r.Type)):
			res.Status = "ok"
		default:
			res.Status = "differs"
		}
	}
	return res
}

var dnsRank = map[string]int{"unverified": 0, "ok": 1, "missing": 2, "differs": 3}

// combineResults merges the two resolvers' views: a resolver that cannot answer
// (unsupported type, timeout) defers to the other; two definite answers that
// disagree report the worse one and say so (usually propagation).
func combineResults(a, b dnsResult, an, bn string) dnsResult {
	switch {
	case a.Status == "unverified" && b.Status == "unverified":
		a.Note = an + ": " + a.Note + "; " + bn + ": " + b.Note
		return a
	case a.Status == "unverified":
		b.Note = joinNotes(bn+" only ("+an+": "+a.Note+")", b.Note)
		return b
	case b.Status == "unverified":
		a.Note = joinNotes(an+" only ("+bn+": "+b.Note+")", a.Note)
		return a
	case a.Status == b.Status:
		return a
	}
	worse, other, wn, on := a, b, an, bn
	if dnsRank[b.Status] > dnsRank[a.Status] {
		worse, other, wn, on = b, a, bn, an
	}
	worse.Note = joinNotes(fmt.Sprintf("%s: %s, %s: %s (propagation?)", wn, worse.Status, on, other.Status), worse.Note)
	return worse
}

func joinNotes(a, b string) string {
	if b == "" {
		return a
	}
	return a + ". " + b
}

func dnsFQDN(zone, name string) string {
	if name == "@" || name == "" {
		return zone
	}
	return name + "." + zone
}

// dnsCheck resolves every record of every zone (or one zone) and returns one
// result per record, DNSSEC and HTTP check.
func dnsCheck(ctx context.Context, spec DNSSpec, zone string, env dnsEnv) []dnsResult {
	var out []dnsResult
	lookup := func(res []dnsLookup, fqdn, typ string, r DNSRecord) dnsResult {
		var combined *dnsResult
		for i, l := range res {
			one := dnsResult{Name: r.Name, Type: typ, Status: "unverified", rec: &r, stage: -1}
			if found, err := l.Lookup(ctx, fqdn, typ); err != nil {
				one.Note = Mask(err.Error())
				if i == 0 || len(res) == 1 {
					one.Note = l.Name() + ": " + one.Note
				}
			} else {
				one = compareRecord(r, found)
			}
			if combined == nil {
				combined = &one
				continue
			}
			c := combineResults(*combined, one, res[0].Name(), l.Name())
			combined = &c
		}
		if combined == nil {
			return dnsResult{Name: r.Name, Type: typ, Status: "unverified", Note: "no resolver", rec: &r, stage: -1}
		}
		return *combined
	}
	for _, z := range spec.Zones {
		if zone != "" && !strings.EqualFold(z.Name, zone) {
			continue
		}
		for _, r := range z.Records {
			res := lookup(env.Resolvers, dnsFQDN(z.Name, r.Name), r.Type, r)
			res.Zone = z.Name
			out = append(out, res)
		}
		if z.DNSSEC {
			ds := DNSRecord{Name: "@", Type: "DS", Present: true}
			res := lookup(env.Resolvers, z.Name, "DS", ds)
			res.Zone, res.Type, res.Name, res.Expected = z.Name, "DNSSEC", "", "DS at the parent"
			switch res.Status {
			case "ok":
				res.Note = "DS published at the parent (chain itself not validated here)"
			case "missing":
				res.Note = "no DS at the parent: DNSSEC off, or the DS not published at the registrar"
			}
			out = append(out, res)
		}
		for _, h := range z.HTTP {
			res := dnsResult{Zone: z.Name, Type: "HTTP", Name: h.URL, Expected: fmt.Sprintf("%d -> %s", h.Status, h.Location), stage: -1}
			if env.HTTP == nil {
				res.Status, res.Note = "unverified", "no HTTP probe"
			} else if st, loc, err := env.HTTP(ctx, h.URL); err != nil {
				res.Status, res.Note = "unverified", Mask(err.Error())
			} else {
				res.Found = fmt.Sprintf("%d -> %s", st, loc)
				if st == h.Status && strings.HasPrefix(loc, h.Location) {
					res.Status = "ok"
				} else {
					res.Status = "differs"
				}
			}
			out = append(out, res)
		}
	}
	return out
}

func dnsCounts(rs []dnsResult) (ok, missing, differs, unverified int) {
	for _, r := range rs {
		switch r.Status {
		case "ok":
			ok++
		case "missing":
			missing++
		case "differs":
			differs++
		default:
			unverified++
		}
	}
	return
}

func dnsDrift(rs []dnsResult) int {
	_, m, d, _ := dnsCounts(rs)
	return m + d
}

func truncateRunes(s string, n int) string {
	if r := []rune(s); len(r) > n {
		return string(r[:n-1]) + "…"
	}
	return s
}

// dnsPrint writes the report (text or JSON) and returns the exit code: 0 when
// nothing is missing or differs, 2 on drift.
func dnsPrint(w io.Writer, rs []dnsResult, asJSON bool) int {
	ok, missing, differs, unverified := dnsCounts(rs)
	zones := map[string]bool{}
	for _, r := range rs {
		zones[r.Zone] = true
	}
	code := 0
	if missing+differs > 0 {
		code = 2
	}
	if asJSON {
		b, _ := json.MarshalIndent(map[string]any{
			"zones": len(zones), "results": rs, "ok": ok, "missing": missing, "differs": differs,
			"unverified": unverified, "drift": code == 2,
		}, "", "  ")
		fmt.Fprintln(w, string(b))
		return code
	}
	for _, r := range rs {
		detail := ""
		switch r.Status {
		case "ok":
			if r.Type != "HTTP" && r.Type != "DNSSEC" {
				detail = truncateRunes(r.Found, 60)
			}
		case "missing":
			detail = "expected " + truncateRunes(r.Expected, 60)
		case "differs":
			detail = fmt.Sprintf("expected %s; found %s", truncateRunes(r.Expected, 60), truncateRunes(Mask(r.Found), 60))
		}
		if r.Note != "" {
			detail = strings.TrimSpace(detail + " [" + r.Note + "]")
		}
		fmt.Fprintf(w, "%-18s %-6s %-20s %-10s %s\n", r.Zone, r.Type, r.Name, r.Status, detail)
	}
	plural := "zones"
	if len(zones) == 1 {
		plural = "zone"
	}
	fmt.Fprintf(w, "dns: %d %s, %d checks: %d ok, %d missing, %d differs, %d unverified\n", len(zones), plural, len(rs), ok, missing, differs, unverified)
	return code
}

// ---- plan ----

// cfRecord is the body of a Cloudflare DNS record request (API v4). TTL 1 = automatic.
type cfRecord struct {
	Type     string `json:"type"`
	Name     string `json:"name"`
	Content  string `json:"content,omitempty"`
	Priority *int   `json:"priority,omitempty"`
	Data     *cfCAA `json:"data,omitempty"`
	Proxied  *bool  `json:"proxied,omitempty"`
	TTL      int    `json:"ttl"`
	Comment  string `json:"comment,omitempty"`
}

type cfCAA struct {
	Flags int    `json:"flags"`
	Tag   string `json:"tag"`
	Value string `json:"value"`
}

func cfBody(typ, fqdn, value string, proxied *bool) string {
	rec := cfRecord{Type: typ, Name: fqdn, Content: value, TTL: 1, Proxied: proxied}
	switch typ {
	case "MX":
		if p, h, ok := strings.Cut(value, " "); ok {
			var pri int
			fmt.Sscanf(p, "%d", &pri)
			rec.Priority, rec.Content = &pri, h
		}
	case "CAA":
		f := strings.Fields(strings.ReplaceAll(value, "\"", ""))
		if len(f) >= 3 {
			var flags int
			fmt.Sscanf(f[0], "%d", &flags)
			rec.Data, rec.Content = &cfCAA{Flags: flags, Tag: f[1], Value: strings.Join(f[2:], " ")}, ""
		}
	}
	var sb strings.Builder
	enc := json.NewEncoder(&sb)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(rec)
	return strings.TrimSpace(sb.String())
}

// dnsPlanPrint lists the Cloudflare API requests that would close the drift.
// Ids are placeholders: `apply` would look them up with the zone's token.
func dnsPlanPrint(w io.Writer, rs []dnsResult) {
	var now, later []string
	for _, r := range rs {
		zp := "/client/v4/zones/{zone_id:" + r.Zone + "}"
		fqdn := dnsFQDN(r.Zone, r.Name)
		switch r.Type {
		case "DNSSEC":
			if r.Status == "missing" {
				now = append(now, fmt.Sprintf("PATCH %s/dnssec {\"status\":\"active\"}   # then publish the DS at the registrar (automatic for Cloudflare Registrar; manual elsewhere)", zp))
			}
			continue
		case "HTTP":
			if r.Status == "differs" {
				now = append(now, fmt.Sprintf("MANUAL Rules > Redirect Rules on %s: %s should answer %s (found %s); rulesets API phase http_request_dynamic_redirect", r.Zone, r.Name, r.Expected, r.Found))
			}
			continue
		}
		rec := r.rec
		if rec == nil {
			continue
		}
		switch {
		case rec.Present:
			if r.Status == "missing" {
				now = append(now, fmt.Sprintf("POST %s/dns_records %s   # TBC: %s", zp, cfBody(rec.Type, fqdn, "<TBC>", nil), firstNonEmpty(rec.Note, "value comes from the provider")))
			}
		case rec.Proxied != nil:
			if r.Status == "missing" {
				if rec.Type == "AAAA" { // a proxied AAAA 100:: is enough: the edge then answers A and AAAA
					now = append(now, fmt.Sprintf("POST %s/dns_records %s", zp, cfBody(rec.Type, fqdn, "100::", rec.Proxied)))
				} else {
					now = append(now, fmt.Sprintf("# A %s: answered by the edge once a proxied record exists (AAAA 100:: or the Worker custom domain); no request of its own", fqdn))
				}
			} else if r.Status == "differs" {
				for _, f := range r.found {
					if ip := net.ParseIP(f); ip != nil && inNets(ip, tailnetNet) {
						now = append(now, fmt.Sprintf("DELETE %s/dns_records/{record_id:%s %s %s}   # DNS-only record exposing a tailnet address", zp, rec.Type, fqdn, f))
					}
				}
			}
		case rec.Type == "TXT":
			want := rec.Stages
			if len(want) == 0 {
				want = []string{rec.Value}
			}
			switch r.Status {
			case "missing":
				now = append(now, fmt.Sprintf("POST %s/dns_records %s", zp, cfBody("TXT", fqdn, want[0], nil)))
			case "differs":
				content := want[0]
				if rec.Match == "tags" && len(r.found) > 0 {
					content = mergeTags(want[0], r.found[0])
				}
				if len(r.found) > 1 {
					for _, f := range r.found[1:] {
						now = append(now, fmt.Sprintf("DELETE %s/dns_records/{record_id:TXT %s %s}   # duplicate", zp, fqdn, truncateRunes(f, 40)))
					}
				}
				now = append(now, fmt.Sprintf("PATCH %s/dns_records/{record_id:TXT %s} %s", zp, fqdn, cfBody("TXT", fqdn, content, nil)))
			case "ok":
				if r.stage >= 0 && r.stage < len(want)-1 {
					next := want[r.stage+1]
					if rec.Match == "tags" && len(r.found) > 0 {
						next = mergeTags(next, r.found[0])
					}
					later = append(later, fmt.Sprintf("PATCH %s/dns_records/{record_id:TXT %s} %s   # stage %d of %d", zp, fqdn, cfBody("TXT", fqdn, next, nil), r.stage+2, len(want)))
				}
			}
		default: // A, AAAA, MX, CAA sets
			want := rec.Values
			if len(want) == 0 {
				want = []string{rec.Value}
			}
			if r.Status != "missing" && r.Status != "differs" {
				continue
			}
			wantN, foundN := normSet(want, rec.Type), normSet(r.found, rec.Type)
			for _, f := range foundN {
				if !slices.Contains(wantN, f) {
					now = append(now, fmt.Sprintf("DELETE %s/dns_records/{record_id:%s %s %s}", zp, rec.Type, fqdn, f))
				}
			}
			for _, v := range wantN {
				if !slices.Contains(foundN, v) {
					now = append(now, fmt.Sprintf("POST %s/dns_records %s", zp, cfBody(rec.Type, fqdn, v, nil)))
				}
			}
		}
	}
	fmt.Fprintln(w, "# Cloudflare API v4 requests to close the drift (read-only plan: no token, nothing sent).")
	fmt.Fprintln(w, "# {zone_id:…} and {record_id:…} are placeholders apply would resolve with the zone's token.")
	if len(now) == 0 {
		fmt.Fprintln(w, "nothing to change now")
	}
	for _, l := range now {
		fmt.Fprintln(w, l)
	}
	if len(later) > 0 {
		fmt.Fprintln(w, "\nLater (staged; move on only when the reports are clean):")
		for _, l := range later {
			fmt.Fprintln(w, l)
		}
	}
}

// ---- alert ----

type dnsZoneState struct {
	Checked time.Time `json:"checked"`
	Drift   int       `json:"drift"`
}

const dnsAlertEvery = 24 * time.Hour

// dnsAlert texts once when a zone that was clean on the previous run now
// drifts: never on the first run, never twice for the same drift, at most
// once per 24 h per zone, and not while Argo is paused. Values never go in
// the text (SMS is not end-to-end encrypted); the count and zone do.
func dnsAlert(s Store, phone *Phone, zone string, drift int, now time.Time, out io.Writer) {
	path := s.path("dns-state.json")
	st := map[string]dnsZoneState{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	prev, seen := st[zone]
	st[zone] = dnsZoneState{Checked: now, Drift: drift}
	b, _ := json.Marshal(st)
	_ = os.MkdirAll(s.Dir, 0o700)
	_ = os.WriteFile(path, b, 0o600)
	if drift == 0 || !seen || prev.Drift > 0 || s.Disabled() {
		return
	}
	if !shouldNotify(s, "dns-"+zone, dnsAlertEvery, now) {
		return
	}
	msg := fmt.Sprintf("%d DNS record(s) on %s differ from the desired state. At the Mac: argo dns check --zone %s", drift, zone, zone)
	if phone == nil {
		fmt.Fprintln(out, "alert:", msg)
		return
	}
	phone.Send("Argo DNS drift", msg, now)
}

// ---- command ----

const dnsApplyRefusal = "apply needs ARGO_CF_TOKEN_<ZONE> from the Keychain and an explicit --yes; not enabled"

// dnsCmd: `argo dns check|plan|apply [--zone Z] [--file F] [--json] [--alert]`.
func dnsCmd(args []string, s Store, phone *Phone, env dnsEnv, out io.Writer, now time.Time) (int, error) {
	sub := "check"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("dns "+sub, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	zone := fs.String("zone", "", "only this zone")
	file := fs.String("file", dnsSpecPath(), "desired-state file")
	asJSON := fs.Bool("json", false, "machine-readable output")
	alert := fs.Bool("alert", false, "text once per zone when a clean zone starts to drift")
	fs.Bool("yes", false, "(apply) confirm")
	if err := fs.Parse(args); err != nil {
		return 1, err
	}
	switch sub {
	case "apply":
		return 1, errors.New(dnsApplyRefusal)
	case "check", "plan":
	default:
		return 1, errors.New("usage: argo dns check|plan [--zone Z] [--file F] [--json] [--alert] | argo dns apply (gated)")
	}
	spec, err := loadDNSSpec(*file)
	if errors.Is(err, os.ErrNotExist) {
		return 1, fmt.Errorf("no desired state at %s; start from tools/argo/examples/dns.json", *file)
	}
	if err != nil {
		return 1, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	rs := dnsCheck(ctx, spec, *zone, env)
	if sub == "plan" {
		dnsPlanPrint(out, rs)
		return 0, nil
	}
	code := dnsPrint(out, rs, *asJSON)
	if *alert {
		byZone := map[string]int{}
		var order []string
		for _, r := range rs {
			if _, ok := byZone[r.Zone]; !ok {
				order = append(order, r.Zone)
			}
			if r.Status == "missing" || r.Status == "differs" {
				byZone[r.Zone]++
			}
		}
		for _, z := range order {
			dnsAlert(s, phone, z, byZone[z], now, out)
		}
	}
	return code, nil
}
