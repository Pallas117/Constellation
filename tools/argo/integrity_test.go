package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// ---- Meshtastic ----

func fromRadioWithPort(port uint64, payload []byte) []byte {
	data := pbBytes(pbVarint(pbTag(nil, 1, 0), port), 2, payload)
	pkt := pbBytes(pbFixed32(nil, 2, 0xffffffff), 4, data)
	return pbBytes(pbVarint(pbTag(nil, 1, 0), 7), 2, pkt)
}

func TestMeshtasticProtobufRoundTrip(t *testing.T) {
	payload := randBytes(190)
	to := toRadioPacket(0xffffffff, 42, payload)
	r := pbReader{b: to}
	num, pkt, ok := r.field() // ToRadio.packet = 1
	if !ok || num != 1 || len(r.b) != 0 {
		t.Fatalf("ToRadio: %d %v", num, ok)
	}
	// The same MeshPacket inside a FromRadio (packet = 2) must yield the payload back.
	from := pbBytes(pbVarint(pbTag(nil, 1, 0), 9), 2, pkt)
	if got, ok := privatePayload(from); !ok || !bytes.Equal(got, payload) {
		t.Fatalf("privatePayload: %v", ok)
	}
	if _, ok := privatePayload(fromRadioWithPort(1, payload)); ok { // TEXT_MESSAGE_APP is not ours
		t.Fatal("other ports must be ignored")
	}
	if got, ok := privatePayload(fromRadioWithPort(portPrivateApp, []byte("hi"))); !ok || string(got) != "hi" {
		t.Fatal("private port")
	}
	for _, junk := range [][]byte{nil, {0x12}, {0x12, 0xff}, {0x12, 0x05, 1}, bytes.Repeat([]byte{0xff}, 20)} {
		if _, ok := privatePayload(junk); ok {
			t.Fatalf("junk %x accepted", junk)
		}
	}
}

func TestMeshtasticSerialFraming(t *testing.T) {
	pb := randBytes(100)
	fr, err := serialFrame(pb)
	if err != nil || fr[0] != 0x94 || fr[1] != 0xc3 || int(fr[2])<<8|int(fr[3]) != 100 {
		t.Fatalf("frame header % x", fr[:4])
	}
	// Garbage, a false start (0x94 then not 0xC3) and an absurd length are skipped to the real frame.
	stream := append([]byte{1, 2, 0x94, 0x00, 0x94, 0xc3, 0xff, 0xff}, fr...)
	got, err := readSerialFrame(bytes.NewReader(stream))
	if err != nil || !bytes.Equal(got, pb) {
		t.Fatalf("resync: %v", err)
	}
	if _, err := serialFrame(make([]byte, 513)); err == nil {
		t.Fatal("frames over 512 bytes are refused")
	}
	if _, err := readSerialFrame(bytes.NewReader(fr[:50])); err == nil {
		t.Fatal("a truncated frame must error")
	}
}

func TestMeshtasticOverLocalHTTP(t *testing.T) {
	var put [][]byte
	var queue [][]byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPut && r.URL.Path == "/api/v1/toradio":
			b, _ := io.ReadAll(r.Body)
			put = append(put, b)
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/fromradio":
			if len(queue) > 0 {
				w.Write(queue[0])
				queue = queue[1:]
			}
		default:
			http.Redirect(w, r, "https://elsewhere.example/", http.StatusFound)
		}
	}))
	defer srv.Close()
	m, err := meshtasticFor(srv.URL) // 127.0.0.1: loopback is local
	if err != nil || m == nil {
		t.Fatal(err)
	}
	if m.MTU() != meshMTU || m.MTU() > 233 || m.Duty() != 0.01 || m.Name() != "meshtastic" {
		t.Fatalf("MTU %d duty %v", m.MTU(), m.Duty())
	}
	frame := randBytes(150)
	if err := m.Send(context.Background(), frame); err != nil || len(put) != 1 {
		t.Fatalf("send: %v (%d puts)", err, len(put))
	}
	if !bytes.Contains(put[0], frame) {
		t.Fatal("the frame should be inside the ToRadio protobuf")
	}
	if err := m.Send(context.Background(), make([]byte, meshMTU+1)); err == nil {
		t.Fatal("frames over the MTU are refused")
	}
	queue = [][]byte{fromRadioWithPort(1, []byte("chat")), fromRadioWithPort(portPrivateApp, frame)}
	got, err := m.Recv(context.Background())
	if err != nil || len(got) != 1 || !bytes.Equal(got[0], frame) {
		t.Fatalf("recv: %d frames, %v", len(got), err)
	}
	m.Base.Path = "/other"
	if _, code, err := m.call(context.Background(), http.MethodPost, "/redirect", nil); err != nil || code != http.StatusFound {
		t.Fatalf("redirects must not be followed (token-less here, but never to another host): %d %v", code, err)
	}
}

func TestMeshtasticNodeMustBeLocal(t *testing.T) {
	for _, bad := range []string{"http://example.com", "http://8.8.8.8", "ftp://192.168.1.5", "http://user:pw@192.168.1.5", "192.168.1.5", "http://"} {
		if m, err := meshtasticFor(bad); err == nil || m != nil {
			t.Errorf("%q should be refused", bad)
		}
	}
	for _, ok := range []string{"http://192.168.1.5", "http://10.0.0.7:8080", "https://meshtastic.local", "http://172.20.10.4", "http://[fe80::1]"} {
		if m, err := meshtasticFor(ok); err != nil || m == nil {
			t.Errorf("%q should be accepted: %v", ok, err)
		}
	}
	if m, err := meshtasticFor(""); m != nil || err != nil {
		t.Error("flag unset means no bearer")
	}
}

// ---- time integrity ----

func TestJudgeClockNeedsMostSourcesToAgree(t *testing.T) {
	mk := func(secs ...int) []ClockSample {
		var s []ClockSample
		for i, v := range secs {
			s = append(s, ClockSample{Source: string(rune('a' + i)), Skew: time.Duration(v) * time.Second})
		}
		return s
	}
	if v := judgeClock(mk(1, -2, 0, 1), lsT0); !v.Checked || v.Fault || v.Agree != 4 {
		t.Fatalf("all agree: %+v", v)
	}
	if v := judgeClock(mk(1, -2, 0, 900), lsT0); v.Fault {
		t.Fatalf("one odd source (a bad path or server) is not a fault: %+v", v)
	}
	v := judgeClock(mk(600, 610, 590, 2), lsT0)
	if !v.Fault || v.SkewSecs < 590 || !strings.Contains(v.String(), "time source disagreement") || !strings.Contains(v.String(), "does not change the clock") {
		t.Fatalf("this clock 10 minutes off from most sources: %+v %q", v, v.String())
	}
	if v := judgeClock(mk(900, 900), lsT0); v.Checked || v.Fault {
		t.Fatalf("two sources are not enough to tell: %+v", v)
	}
	if (ClockVerdict{}).String() != "" {
		t.Fatal("no fault, no text")
	}
}

func TestClockSampleReadsDateHeaderOverVerifiedTLS(t *testing.T) {
	ahead := time.Now().Add(10 * time.Minute).UTC()
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Date", ahead.Format(http.TimeFormat))
	}))
	defer srv.Close()
	s, ok := clockSample(context.Background(), srv.Client(), srv.URL)
	if !ok || s.Skew < 9*time.Minute || s.Skew > 11*time.Minute {
		t.Fatalf("skew %v ok=%v", s.Skew, ok)
	}
	// The default client (system roots) must refuse this server's self-signed certificate:
	// verification is never turned off.
	c := &http.Client{Timeout: 3 * time.Second}
	if _, ok := clockSample(context.Background(), c, srv.URL); ok {
		t.Fatal("an untrusted certificate must fail the check")
	}
	noDate := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Header()["Date"] = nil }))
	defer noDate.Close()
	if _, ok := clockSample(context.Background(), noDate.Client(), noDate.URL); ok {
		t.Fatal("a response without Date is no sample")
	}
}

// ---- wired phone link, link sample ----

const hwPorts = `Hardware Port: Ethernet Adapter (en4)
Device: en4
Ethernet Address: aa:bb:cc:dd:ee:01

Hardware Port: iPhone USB
Device: en5
Ethernet Address: aa:bb:cc:dd:ee:02

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: aa:bb:cc:dd:ee:03
`

func TestParseHardwarePortsAndKinds(t *testing.T) {
	ps := parseHardwarePorts(hwPorts)
	if len(ps) != 3 || ps[1].Name != "iPhone USB" || ps[1].Device != "en5" || ps[2].Device != "en0" {
		t.Fatalf("%+v", ps)
	}
	if portKind("iPhone USB") != "usb" || portKind("Wi-Fi") != "wifi" || portKind("Thunderbolt Bridge") != "ethernet" || portKind("VPN") != "other" {
		t.Fatal("kinds")
	}
}

func TestChooseLinkRanksWiredPhoneAboveWiFi(t *testing.T) {
	ports := parseHardwarePorts(hwPorts)
	up := func(d string) bool { return d == "en5" || d == "en0" }
	v := chooseLink(ports, "en0", up, true)
	if v.Via != "wifi" || !strings.Contains(v.Advice, "iPhone USB") || !strings.Contains(v.Advice, "Service Order") || !strings.Contains(v.Advice, "never changes network settings") || !strings.Contains(v.Advice, "weak") {
		t.Fatalf("wifi in use while USB is up: %+v", v)
	}
	if v := chooseLink(ports, "en5", up, true); v.Via != "usb" || v.Advice != "" {
		t.Fatalf("already on USB: %+v", v)
	}
	if v := chooseLink(ports, "en0", func(d string) bool { return d == "en0" }, false); v.Via != "wifi" || v.Advice != "" {
		t.Fatalf("USB not connected: %+v", v)
	}
	if v := chooseLink(ports, "", up, false); v.Advice != "" {
		t.Fatalf("no default route: nothing to say %+v", v)
	}
}

func TestStatusShowsWiredAdvice(t *testing.T) {
	st := State{CheckedAt: time.Now(), Class: OK, Loc: "MY", Via: "wifi", Advice: "\"iPhone USB\" is connected but traffic uses wifi."}
	if line := statusLine(st, time.Now()); !strings.Contains(line, "iPhone USB") || !strings.Contains(line, "via:wifi") {
		t.Fatalf("status: %q", line)
	}
}

func TestLinkSampleIsAllowlistedAndPrivate(t *testing.T) {
	st := State{Class: OK, Fingerprint: "0123456789ab", Via: "usb", Low: LowSignal{On: true, Recent: []bool{true, true, false, true}},
		Net: NetScore{RTTMs: 140, Signal: "good", RSSI: -62, Noise: -92}}
	s := linkSample(Config{Place: "Hostel roof! <script>"}, st)
	want := map[string]any{"class": "usb", "bearer": "https", "lossPct": 25, "rttMs": 140, "low": true, "network": "0123456789ab", "place": "Hostel roof script", "signalDbm": -62, "noiseDbm": -92}
	if len(s) != len(want) {
		t.Fatalf("fields %v", s)
	}
	for k, v := range want {
		if s[k] != v {
			t.Errorf("%s = %v, want %v", k, s[k], v)
		}
	}
	for k := range s {
		if strings.Contains(strings.ToLower(k), "ssid") || strings.Contains(strings.ToLower(k), "gps") || strings.Contains(strings.ToLower(k), "lat") {
			t.Errorf("field %s must not exist", k)
		}
	}
	off := linkSample(Config{}, State{Class: OK, Net: NetScore{RTTMs: -1, Signal: "n/a"}})
	if _, has := off["signalDbm"]; has || off["class"] != "other" {
		t.Fatalf("no signal off Wi-Fi: %v", off)
	}
	if placeLabel("a very long place label that goes on and on and on") != "a very long place label" && len(placeLabel("a very long place label that goes on and on and on")) > 24 {
		t.Fatal("labels are short")
	}
}

func TestAdviceSuffixInAlertText(t *testing.T) {
	if adviceSuffix(State{}) != "" {
		t.Fatal("no advice, no text")
	}
	if got := adviceSuffix(State{Advice: "Move iPhone USB up."}); got != "\nMove iPhone USB up." {
		t.Fatalf("%q", got)
	}
}
