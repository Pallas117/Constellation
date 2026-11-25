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
		`PATCH /client/v4/zones/{zone_id:lightbound.uk}/dns_records/{record_id:TXT _dmarc.lightbound.uk v=DMARC1; p=quarantine; rua=mailto:x@y} {"type":"TXT","name":"_dmarc.lightbound.uk","content":"v=DMARC1; p=none; rua=mailto:x@y","ttl":1}`,
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

// alertRun builds one zone's results for dnsAlert: one check per status, in
// the order of three fixed records (SPF, DMARC, DKIM).
func alertRun(statuses ...string) []dnsResult {
	recs := []DNSRecord{
		{Name: "@", Type: "TXT", Value: "v=spf1 include:_spf.google.com ~all"},
		{Name: "_dmarc", Type: "TXT", Match: "tags", Value: "v=DMARC1; p=none"},
		{Name: "google._domainkey", Type: "TXT", Present: true},
	}
	var rs []dnsResult
	for i, st := range statuses {
		r := recs[i]
		rs = append(rs, dnsResult{Zone: "lightbound.uk", Name: r.Name, Type: r.Type, Status: st, rec: &r, stage: -1})
	}
	return rs
}

func TestDNSAlertOnlyAfterACleanRun(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	var sent []string
	p := testPhone(t, func(_, text string) error { sent = append(sent, text); return nil })
	at := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	var out bytes.Buffer
	clean, one := alertRun("ok", "ok", "ok"), alertRun("missing", "ok", "ok")
	// First run with drift: nothing to compare with, no text.
	dnsAlert(s, p, "lightbound.uk", alertRun("missing", "differs", "ok"), at, &out)
	if len(sent) != 0 {
		t.Fatalf("first run alerted: %v", sent)
	}
	dnsAlert(s, p, "lightbound.uk", clean, at.Add(time.Hour), &out)
	dnsAlert(s, p, "lightbound.uk", one, at.Add(2*time.Hour), &out)
	if len(sent) != 1 || strings.Contains(sent[0], "mailto") || !strings.Contains(sent[0], "lightbound.uk") {
		t.Fatalf("after clean run: %v", sent)
	}
	dnsAlert(s, p, "lightbound.uk", one, at.Add(3*time.Hour), &out) // still drifting: no repeat
	dnsAlert(s, p, "lightbound.uk", clean, at.Add(4*time.Hour), &out)
	dnsAlert(s, p, "lightbound.uk", one, at.Add(5*time.Hour), &out) // flapped back within 24 h: deduped
	if len(sent) != 1 {
		t.Fatalf("dedupe: %v", sent)
	}
	dnsAlert(s, p, "lightbound.uk", clean, at.Add(30*time.Hour), &out)
	dnsAlert(s, p, "lightbound.uk", one, at.Add(31*time.Hour), &out)
	if len(sent) != 2 {
		t.Fatalf("after 24 h: %v", sent)
	}
	// Paused Argo stays quiet.
	_ = os.WriteFile(s.path("disabled"), nil, 0o600)
	dnsAlert(s, p, "lightbound.uk", clean, at.Add(60*time.Hour), &out)
	dnsAlert(s, p, "lightbound.uk", one, at.Add(61*time.Hour), &out)
	if len(sent) != 2 {
		t.Fatalf("disabled: %v", sent)
	}
}

// A drop-out between two runs that see the same drift must not re-arm the
// alert: an all-unverified run keeps the state, and a check unverified this run
// keeps its previous drift. Only a new drifting record texts.
func TestDNSAlertOfflineRunKeepsState(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	var sent []string
	p := testPhone(t, func(_, text string) error { sent = append(sent, text); return nil })
	at := time.Date(2026, 11, 5, 9, 0, 0, 0, time.UTC)
	var out bytes.Buffer
	two := alertRun("missing", "differs", "ok")
	dnsAlert(s, p, "lightbound.uk", alertRun("ok", "ok", "ok"), at, &out)
	dnsAlert(s, p, "lightbound.uk", two, at.Add(time.Hour), &out)
	if len(sent) != 1 || !strings.Contains(sent[0], "2 DNS record(s)") {
		t.Fatalf("clean -> drift 2: %v", sent)
	}
	before, _ := os.ReadFile(s.path("dns-state.json"))
	// Offline: both resolvers fail on every record, through the real check.
	spec := DNSSpec{Zones: []DNSZone{{Name: "lightbound.uk", Records: []DNSRecord{{Name: "@", Type: "TXT", Value: "v=spf1 -all"}}}}}
	down := errors.New("dial udp 1.1.1.1:53: connect: network is unreachable")
	off := fakeLookup{name: "1.1.1.1", errs: map[string]error{"TXT lightbound.uk": down}}
	offRun := dnsCheck(context.Background(), spec, "", dnsEnv{Resolvers: []dnsLookup{off, off}})
	if offRun[0].Status != "unverified" {
		t.Fatalf("offline run: %+v", offRun[0])
	}
	dnsAlert(s, p, "lightbound.uk", offRun, at.Add(30*time.Hour), &out)
	if after, _ := os.ReadFile(s.path("dns-state.json")); !bytes.Equal(before, after) {
		t.Fatalf("offline run rewrote the state:\n%s\n%s", before, after)
	}
	dnsAlert(s, p, "lightbound.uk", two, at.Add(31*time.Hour), &out)
	if len(sent) != 1 {
		t.Fatalf("drift 2, offline, drift 2 texted again: %v", sent)
	}
	// One check unverified (timeout), the other still drifting: its drift is
	// carried, so the next full run is not "new".
	dnsAlert(s, p, "lightbound.uk", alertRun("unverified", "differs", "ok"), at.Add(56*time.Hour), &out)
	dnsAlert(s, p, "lightbound.uk", two, at.Add(57*time.Hour), &out)
	if len(sent) != 1 {
		t.Fatalf("partly unverified run re-armed the alert: %v", sent)
	}
	// A record that starts drifting while others already drift does text.
	dnsAlert(s, p, "lightbound.uk", alertRun("missing", "differs", "missing"), at.Add(82*time.Hour), &out)
	if len(sent) != 2 || !strings.Contains(sent[1], "(1 new)") {
		t.Fatalf("new drifting record: %v", sent)
	}
	// State written before per-record keys (drift count only) is treated as known.
	_ = os.WriteFile(s.path("dns-state.json"), []byte(`{"lightbound.uk":{"checked":"2026-11-01T00:00:00Z","drift":2}}`), 0o600)
	dnsAlert(s, p, "lightbound.uk", two, at.Add(120*time.Hour), &out)
	if len(sent) != 2 {
		t.Fatalf("legacy state re-alerted: %v", sent)
	}
}

// Several TXT records share @ (site verification, SPF). With two SPF records
// the plan deletes only the extra SPF and never the verification record, and
// the SPF that already matches is kept rather than patched.
func TestDNSPlanTouchesOnlyItsOwnTXT(t *testing.T) {
	spec := DNSSpec{Zones: []DNSZone{{Name: "z.example", Records: []DNSRecord{
		{Name: "@", Type: "TXT", Present: true, Prefix: "google-site-verification="},
		{Name: "@", Type: "TXT", Stages: []string{"v=spf1 include:_spf.google.com ~all", "v=spf1 include:_spf.google.com -all"}},
	}}}}
	for _, order := range [][]string{
		{"google-site-verification=abc", "v=spf1 include:_spf.google.com ~all", "v=spf1 -all"},
		{"v=spf1 -all", "google-site-verification=abc", "v=spf1 include:_spf.google.com ~all"},
	} {
		cf := fakeLookup{name: "1.1.1.1", answers: map[string][]string{"TXT z.example": order}}
		rs := dnsCheck(context.Background(), spec, "", dnsEnv{Resolvers: []dnsLookup{cf}})
		if rs[0].Status != "ok" || rs[1].Status != "differs" {
			t.Fatalf("%v: statuses %s %s", order, rs[0].Status, rs[1].Status)
		}
		if len(rs[1].found) != 2 {
			t.Errorf("%v: SPF entry holds %d records, want only the 2 SPF: %q", order, len(rs[1].found), rs[1].found)
		}
		var out bytes.Buffer
		dnsPlanPrint(&out, rs)
		var deletes, patches []string
		for _, l := range strings.Split(out.String(), "\n") {
			switch {
			case strings.HasPrefix(l, "DELETE"):
				deletes = append(deletes, l)
			case strings.HasPrefix(l, "PATCH"), strings.HasPrefix(l, "POST"):
				patches = append(patches, l)
			}
		}
		if len(deletes) != 1 || !strings.Contains(deletes[0], "v=spf1 -all") {
			t.Errorf("%v: deletes %q, want only the extra SPF", order, deletes)
		}
		if strings.Contains(out.String(), "google-site-verification") {
			t.Errorf("%v: plan touches the verification record:\n%s", order, out.String())
		}
		if len(patches) != 0 {
			t.Errorf("%v: the matching SPF should be kept, not changed: %q", order, patches)
		}
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
	long := DNSSpec{Zones: []DNSZone{{Name: "z.example", Records: []DNSRecord{{Name: strings.Repeat("a", 64), Type: "TXT", Value: "x"}}}}}
	if err := validateDNSSpec(long); err == nil || !strings.Contains(err.Error(), "63") {
		t.Errorf("64-byte label: %v", err)
	}
	notProxied := DNSSpec{Zones: []DNSZone{{Name: "z.example", Records: []DNSRecord{{Name: "@", Type: "A", Proxied: boolp(false)}}}}}
	if err := validateDNSSpec(notProxied); err == nil || !strings.Contains(err.Error(), "proxied") {
		t.Errorf("proxied false: %v", err)
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
	if _, _, err := parseDNSResponse(wireMsg(1, 0x0180, q), 1, dnsTypeTXT); err == nil {
		t.Error("QR=0 (a query, not a response) accepted")
	}
	// The reply must echo our question (RFC 5452 section 9.1); case may differ.
	query := buildDNSQuery(0x1234, "lightbound.uk", dnsTypeTXT)
	upper := append(append([]byte{}, encodeDNSName("LightBound.UK")...), byte(dnsTypeTXT>>8), byte(dnsTypeTXT), 0, 1)
	if !sameQuestion(query, msg) || !sameQuestion(query, wireMsg(0x1234, 0x8180, upper)) {
		t.Error("matching question refused")
	}
	other := append(append([]byte{}, encodeDNSName("lightbound.uk")...), byte(dnsTypeA>>8), byte(dnsTypeA), 0, 1)
	if sameQuestion(query, wireMsg(0x1234, 0x8180, other)) || sameQuestion(query, wireMsg(0x1234, 0x8180, append(encodeDNSName("evil.example"), 0, 16, 0, 1))) {
		t.Error("a different question accepted")
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
