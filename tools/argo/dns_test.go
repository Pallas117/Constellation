package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// fakeLookup answers from a map keyed "TYPE fqdn"; a missing key is NODATA.
type fakeLookup struct {
	name    string
	answers map[string][]string
	errs    map[string]error
}

func (f fakeLookup) Name() string { return f.name }
func (f fakeLookup) Lookup(_ context.Context, fqdn, qtype string) ([]string, error) {
	k := qtype + " " + fqdn
	if err, ok := f.errs[k]; ok {
		return nil, err
	}
	return f.answers[k], nil
}

func boolp(b bool) *bool { return &b }

func TestDNSCompareTable(t *testing.T) {
	spf := DNSRecord{Name: "@", Type: "TXT", Value: "v=spf1 include:_spf.google.com ~all"}
	spfStaged := DNSRecord{Name: "@", Type: "TXT", Stages: []string{"v=spf1 include:_spf.google.com ~all", "v=spf1 include:_spf.google.com -all"}}
	dmarc := DNSRecord{Name: "_dmarc", Type: "TXT", Match: "tags", Require: []string{"rua"},
		Stages: []string{"v=DMARC1; p=none", "v=DMARC1; p=quarantine; pct=25", "v=DMARC1; p=reject"}}
	mx := DNSRecord{Name: "@", Type: "MX", Values: []string{"1 smtp.google.com"}}
	nullMX := DNSRecord{Name: "@", Type: "MX", Value: "0 ."}
	caa := DNSRecord{Name: "@", Type: "CAA", Values: []string{"0 issue letsencrypt.org", "0 issue pki.goog", "0 iodef mailto:security@lightbound.uk"}}
	proxied := DNSRecord{Name: "@", Type: "A", Proxied: boolp(true)}
	ops := DNSRecord{Name: "ops", Type: "A", Value: "100.73.232.74"}
	dkim := DNSRecord{Name: "google._domainkey", Type: "TXT", Present: true}

	cases := []struct {
		name   string
		rec    DNSRecord
		found  []string
		status string
		note   string
	}{
		{"txt ok", spf, []string{"google-site-verification=abc", "v=spf1 include:_spf.google.com ~all"}, "ok", ""},
		{"txt missing", spf, []string{"google-site-verification=abc"}, "missing", ""},
		{"txt differs", spf, []string{"v=spf1 -all"}, "differs", ""},
		{"txt two spf", spf, []string{"v=spf1 -all", "v=spf1 include:_spf.google.com ~all"}, "differs", "2 records"},
		{"staged stage 1", spfStaged, []string{"v=spf1 include:_spf.google.com ~all"}, "ok", "stage 1 of 2"},
		{"staged target", spfStaged, []string{"v=spf1 include:_spf.google.com -all"}, "ok", "target"},
		{"tags stage 1 keeps rua", dmarc, []string{"v=DMARC1; p=none; rua=mailto:x@dmarc-reports.cloudflare.net"}, "ok", "stage 1 of 3"},
		{"tags rua lost", dmarc, []string{"v=DMARC1; p=none"}, "differs", "rua"},
		{"tags wrong p", dmarc, []string{"v=DMARC1; p=none; pct=50; rua=mailto:x@y"}, "ok", ""},
		{"tags differs", dmarc, []string{"v=DMARC1; p=quarantine; pct=100; rua=mailto:x@y"}, "differs", ""},
		{"mx ok trailing dot", mx, []string{"1 smtp.google.com."}, "ok", ""},
		{"mx missing", mx, nil, "missing", ""},
		{"mx extra", mx, []string{"1 smtp.google.com", "10 aspmx.l.google.com"}, "differs", ""},
		{"null mx ok", nullMX, []string{"0 ."}, "ok", ""},
		{"caa ok any order", caa, []string{"0 iodef mailto:security@lightbound.uk", "0 issue pki.goog", "0 issue letsencrypt.org"}, "ok", ""},
		{"caa extra issuer", caa, []string{"0 issue letsencrypt.org", "0 issue pki.goog", "0 iodef mailto:security@lightbound.uk", "0 issue evil.example"}, "differs", ""},
		{"caa missing", caa, nil, "missing", ""},
		{"proxied ok", proxied, []string{"104.21.5.6", "172.67.1.2"}, "ok", ""},
		{"proxied tailnet leak", proxied, []string{"104.21.5.6", "100.73.232.74"}, "differs", "tailnet"},
		{"proxied missing", proxied, nil, "missing", ""},
		{"proxied unknown range", proxied, []string{"203.0.113.9"}, "unverified", "published ranges"},
		{"ops exact", ops, []string{"100.73.232.74"}, "ok", ""},
		{"ops proxied by mistake", ops, []string{"104.21.5.6"}, "differs", ""},
		{"dkim present", dkim, []string{"v=DKIM1; k=rsa; p=MIIB"}, "ok", "TBC"},
		{"dkim missing", dkim, nil, "missing", ""},
	}
	for _, c := range cases {
		r := compareRecord(c.rec, c.found)
		if r.Status != c.status {
			t.Errorf("%s: status %q, want %q (note %q)", c.name, r.Status, c.status, r.Note)
		}
		if c.note != "" && !strings.Contains(r.Note, c.note) {
			t.Errorf("%s: note %q lacks %q", c.name, r.Note, c.note)
		}
	}
}

func TestDNSTagMerge(t *testing.T) {
	got := mergeTags("v=DMARC1; p=quarantine; pct=25", "v=DMARC1; p=none; rua=mailto:x@y")
	if got != "v=DMARC1; p=quarantine; pct=25; rua=mailto:x@y" {
		t.Fatalf("merge: %q", got)
	}
}

func testSpec() DNSSpec {
	return DNSSpec{Zones: []DNSZone{{
		Name:   "lightbound.uk",
		DNSSEC: true,
		Records: []DNSRecord{
			{Name: "@", Type: "MX", Values: []string{"1 smtp.google.com"}},
			{Name: "@", Type: "TXT", Stages: []string{"v=spf1 include:_spf.google.com ~all", "v=spf1 include:_spf.google.com -all"}},
			{Name: "_dmarc", Type: "TXT", Match: "tags", Require: []string{"rua"},
				Stages: []string{"v=DMARC1; p=none", "v=DMARC1; p=quarantine; pct=25", "v=DMARC1; p=reject"}},
			{Name: "google._domainkey", Type: "TXT", Present: true, Note: "Google Admin generates it"},
		},
		HTTP: []DNSHTTP{{URL: "https://lightbound.uk/", Status: 301, Location: "https://lightbound.space/"}},
	}}}
}

func testEnv(cf, sys fakeLookup, httpStatus int, loc string, httpErr error) dnsEnv {
	return dnsEnv{
		Resolvers: []dnsLookup{cf, sys},
		HTTP: func(_ context.Context, _ string) (int, string, error) {
			return httpStatus, loc, httpErr
		},
	}
}

func TestDNSCheckFakeResolver(t *testing.T) {
	cf := fakeLookup{name: "1.1.1.1", answers: map[string][]string{
		"MX lightbound.uk":         {"1 smtp.google.com."},
		"TXT lightbound.uk":        {"google-site-verification=abc"},
		"TXT _dmarc.lightbound.uk": {"v=DMARC1; p=quarantine; rua=mailto:x@y"}, // wrong: pct missing, not a stage
		"DS lightbound.uk":         {"2371 13 2 abcd"},
	}}
	sys := fakeLookup{name: "system", answers: map[string][]string{
		"MX lightbound.uk":         {"1 smtp.google.com"},
		"TXT lightbound.uk":        {"google-site-verification=abc"},
		"TXT _dmarc.lightbound.uk": {"v=DMARC1; p=quarantine; rua=mailto:x@y"},
	}, errs: map[string]error{"DS lightbound.uk": errDNSUnsupported}}
	var out bytes.Buffer
	rs := dnsCheck(context.Background(), testSpec(), "", testEnv(cf, sys, 301, "https://lightbound.space/", nil))
	code := dnsPrint(&out, rs, false)
	if code != 2 {
		t.Fatalf("exit %d, want 2:\n%s", code, out.String())
	}
	text := out.String()
	for _, want := range []string{
		"MX     @                    ok",
		"TXT    @                    missing",
		"TXT    _dmarc               differs",
		"TXT    google._domainkey    missing",
		"DNSSEC                      ok",
		"HTTP   https://lightbound.uk/ ok",
		"dns: 1 zone, 6 checks: 3 ok, 2 missing, 1 differs, 0 unverified",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("output lacks %q:\n%s", want, text)
		}
	}
	// JSON for machines.
	out.Reset()
	if code := dnsPrint(&out, rs, true); code != 2 {
		t.Fatalf("json exit %d", code)
	}
	var doc struct {
		Drift   bool `json:"drift"`
		Results []struct {
			Zone, Name, Type, Status string
		} `json:"results"`
	}
	if err := json.Unmarshal(out.Bytes(), &doc); err != nil || !doc.Drift || len(doc.Results) != 6 {
		t.Fatalf("json: %v %+v", err, doc)
	}
}

func TestDNSCheckResolverDisagreementAndErrors(t *testing.T) {
	spec := DNSSpec{Zones: []DNSZone{{Name: "z.example", Records: []DNSRecord{
		{Name: "@", Type: "TXT", Value: "v=spf1 -all"},
		{Name: "ops", Type: "A", Value: "100.73.232.74"},
	}}}}
	cf := fakeLookup{name: "1.1.1.1", answers: map[string][]string{"TXT z.example": {"v=spf1 -all"}},
		errs: map[string]error{"A ops.z.example": errors.New("i/o timeout")}}
	sys := fakeLookup{name: "system", answers: map[string][]string{"TXT z.example": {"v=spf1 ~all"}},
		errs: map[string]error{"A ops.z.example": errors.New("i/o timeout")}}
	rs := dnsCheck(context.Background(), spec, "", dnsEnv{Resolvers: []dnsLookup{cf, sys}})
	if rs[0].Status != "differs" || !strings.Contains(rs[0].Note, "system: differs") {
		t.Errorf("disagreement: %+v", rs[0])
	}
	if rs[1].Status != "unverified" || !strings.Contains(rs[1].Note, "timeout") {
		t.Errorf("errors: %+v", rs[1])
	}
	// --zone filters.
	if got := dnsCheck(context.Background(), spec, "other.example", dnsEnv{Resolvers: []dnsLookup{cf}}); len(got) != 0 {
		t.Errorf("zone filter: %d results", len(got))
	}
}

func TestDNSPlanMissingSPFAndWrongDMARC(t *testing.T) {
	cf := fakeLookup{name: "1.1.1.1", answers: map[string][]string{
		"MX lightbound.uk":         {"1 smtp.google.com."},
		"TXT lightbound.uk":        {"google-site-verification=abc"},
		"TXT _dmarc.lightbound.uk": {"v=DMARC1; p=quarantine; rua=mailto:x@y"},
	}}
	rs := dnsCheck(context.Background(), testSpec(), "", testEnv(cf, cf, 200, "", nil))
	var out bytes.Buffer
	dnsPlanPrint(&out, rs)
	text := out.String()
	for _, want := range []string{
		`POST /client/v4/zones/{zone_id:lightbound.uk}/dns_records {"type":"TXT","name":"lightbound.uk","content":"v=spf1 include:_spf.google.com ~all","ttl":1}`,
		`PATCH /client/v4/zones/{zone_id:lightbound.uk}/dns_records/{record_id:TXT _dmarc.lightbound.uk} {"type":"TXT","name":"_dmarc.lightbound.uk","content":"v=DMARC1; p=none; rua=mailto:x@y","ttl":1}`,
		`PATCH /client/v4/zones/{zone_id:lightbound.uk}/dnssec {"status":"active"}`,
		"Redirect Rule",
		`{"type":"TXT","name":"google._domainkey.lightbound.uk","content":"<TBC>","ttl":1}   # TBC: Google Admin`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("plan lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(strings.ToLower(text), "token") && !strings.Contains(text, "no token") {
		t.Errorf("plan must not mention a token value:\n%s", text)
	}
}

func TestDNSPlanStagedLater(t *testing.T) {
	cf := fakeLookup{name: "1.1.1.1", answers: map[string][]string{
		"TXT z.example": {"v=spf1 include:_spf.google.com ~all"},
	}}
	spec := DNSSpec{Zones: []DNSZone{{Name: "z.example", Records: []DNSRecord{
		{Name: "@", Type: "TXT", Stages: []string{"v=spf1 include:_spf.google.com ~all", "v=spf1 include:_spf.google.com -all"}},
	}}}}
	rs := dnsCheck(context.Background(), spec, "", dnsEnv{Resolvers: []dnsLookup{cf}})
	var out bytes.Buffer
	dnsPlanPrint(&out, rs)
	if !strings.Contains(out.String(), "nothing to change now") || !strings.Contains(out.String(), `"content":"v=spf1 include:_spf.google.com -all"`) {
		t.Fatalf("plan:\n%s", out.String())
	}
}

func TestDNSApplyRefuses(t *testing.T) {
	var out bytes.Buffer
	code, err := dnsCmd([]string{"apply", "--yes", "--zone", "lightbound.uk"}, Store{Dir: t.TempDir()}, nil, dnsEnv{}, &out, time.Now())
	if code != 1 || err == nil || err.Error() != "apply needs ARGO_CF_TOKEN_<ZONE> from the Keychain and an explicit --yes; not enabled" {
		t.Fatalf("apply: code %d err %v", code, err)
	}
}

func TestDNSAlertOnlyAfterACleanRun(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	var sent []string
	p := testPhone(t, func(_, text string) error { sent = append(sent, text); return nil })
	at := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	var out bytes.Buffer
	// First run with drift: nothing to compare with, no text.
	dnsAlert(s, p, "lightbound.uk", 2, at, &out)
	if len(sent) != 0 {
		t.Fatalf("first run alerted: %v", sent)
	}
	dnsAlert(s, p, "lightbound.uk", 0, at.Add(time.Hour), &out) // clean
	dnsAlert(s, p, "lightbound.uk", 1, at.Add(2*time.Hour), &out)
	if len(sent) != 1 || strings.Contains(sent[0], "mailto") || !strings.Contains(sent[0], "lightbound.uk") {
		t.Fatalf("after clean run: %v", sent)
	}
	dnsAlert(s, p, "lightbound.uk", 1, at.Add(3*time.Hour), &out) // still drifting: no repeat
	dnsAlert(s, p, "lightbound.uk", 0, at.Add(4*time.Hour), &out)
	dnsAlert(s, p, "lightbound.uk", 1, at.Add(5*time.Hour), &out) // flapped back within 24 h: deduped
	if len(sent) != 1 {
		t.Fatalf("dedupe: %v", sent)
	}
	dnsAlert(s, p, "lightbound.uk", 0, at.Add(30*time.Hour), &out)
	dnsAlert(s, p, "lightbound.uk", 1, at.Add(31*time.Hour), &out)
	if len(sent) != 2 {
		t.Fatalf("after 24 h: %v", sent)
	}
	// Paused Argo stays quiet.
	_ = os.WriteFile(s.path("disabled"), nil, 0o600)
	dnsAlert(s, p, "lightbound.uk", 0, at.Add(60*time.Hour), &out)
	dnsAlert(s, p, "lightbound.uk", 1, at.Add(61*time.Hour), &out)
	if len(sent) != 2 {
		t.Fatalf("disabled: %v", sent)
	}
}

func TestDNSExampleLoadsAndValidates(t *testing.T) {
	spec, err := loadDNSSpec(filepath.Join("examples", "dns.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(spec.Zones) != 2 || spec.Zones[0].Name != "lightbound.space" || spec.Zones[1].Name != "lightbound.uk" {
		t.Fatalf("zones: %+v", spec.Zones)
	}
	b, _ := os.ReadFile(filepath.Join("examples", "dns.json"))
	for _, bad := range []string{"Bearer ", "cf_", "104.21.", "172.67."} { // no secrets, no pinned Cloudflare IPs
		if strings.Contains(string(b), bad) {
			t.Errorf("example contains %q", bad)
		}
	}
	if m := regexp.MustCompile(`[A-Za-z0-9_-]{40,}`).FindString(string(b)); m != "" {
		t.Errorf("example contains a token-like string %q", m)
	}
	// A bad spec is refused with a reason.
	bad := DNSSpec{Zones: []DNSZone{{Name: "z", Records: []DNSRecord{{Name: "@", Type: "SRV", Value: "x"}}}}}
	if err := validateDNSSpec(bad); err == nil || !strings.Contains(err.Error(), "SRV") {
		t.Errorf("validate: %v", err)
	}
}

// wireMsg builds a DNS response for the parser: header, one question, the given answers.
func wireMsg(id uint16, flags uint16, question []byte, answers ...[]byte) []byte {
	m := []byte{byte(id >> 8), byte(id), byte(flags >> 8), byte(flags), 0, 1, 0, byte(len(answers)), 0, 0, 0, 0}
	m = append(m, question...)
	for _, a := range answers {
		m = append(m, a...)
	}
	return m
}

func rr(name []byte, typ uint16, rdata []byte) []byte {
	b := append([]byte{}, name...)
	b = append(b, byte(typ>>8), byte(typ), 0, 1, 0, 0, 1, 44, byte(len(rdata)>>8), byte(len(rdata)))
	return append(b, rdata...)
}

func TestDNSWireParse(t *testing.T) {
	name := encodeDNSName("lightbound.uk")
	q := append(append([]byte{}, name...), byte(dnsTypeTXT>>8), byte(dnsTypeTXT), 0, 1)
	ptr := []byte{0xc0, 12}                    // compression pointer to the question name
	txtData := append([]byte{7}, "v=spf1 "...) // two character-strings, joined on parse
	txtData = append(append(txtData, 4), "-all"...)
	txt := rr(ptr, dnsTypeTXT, txtData)
	mxNull := rr(ptr, dnsTypeMX, []byte{0, 0, 0}) // "0 ."
	mx := rr(ptr, dnsTypeMX, append([]byte{0, 1}, encodeDNSName("smtp.google.com")...))
	caa := rr(ptr, dnsTypeCAA, append([]byte{0, 5}, "issueletsencrypt.org"...))
	ds := rr(ptr, dnsTypeDS, []byte{0x09, 0x43, 13, 2, 0xab, 0xcd})
	a := rr(ptr, dnsTypeA, []byte{104, 21, 5, 6})
	msg := wireMsg(0x1234, 0x8180|0x20, q, txt, mxNull, mx, caa, ds, a)
	for typ, want := range map[uint16][]string{
		dnsTypeTXT: {"v=spf1 -all"},
		dnsTypeMX:  {"0 .", "1 smtp.google.com"},
		dnsTypeCAA: {"0 issue letsencrypt.org"},
		dnsTypeDS:  {"2371 13 2 abcd"},
		dnsTypeA:   {"104.21.5.6"},
	} {
		got, ad, err := parseDNSResponse(msg, 0x1234, typ)
		if err != nil || !ad || strings.Join(got, "|") != strings.Join(want, "|") {
			t.Errorf("type %d: %v %v ad=%v", typ, got, err, ad)
		}
	}
	if _, _, err := parseDNSResponse(msg, 0x9999, dnsTypeA); err == nil {
		t.Error("id mismatch accepted")
	}
	// NXDOMAIN is "no records", not an error; SERVFAIL is an error.
	if got, _, err := parseDNSResponse(wireMsg(1, 0x8183, q), 1, dnsTypeA); err != nil || len(got) != 0 {
		t.Errorf("nxdomain: %v %v", got, err)
	}
	if _, _, err := parseDNSResponse(wireMsg(1, 0x8182, q), 1, dnsTypeA); err == nil {
		t.Error("servfail accepted")
	}
	// A pointer loop must not hang.
	loop := rr([]byte{0xc0, 12}, dnsTypeMX, []byte{0, 1, 0xc0, byte(len(q) + 12 + 14)})
	if _, _, err := parseDNSResponse(wireMsg(1, 0x8180, q, loop), 1, dnsTypeMX); err == nil {
		t.Error("pointer loop accepted")
	}
}
