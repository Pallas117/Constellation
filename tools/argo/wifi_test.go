package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseRouteAndWiFiSecurity(t *testing.T) {
	route := "   route to: default\ndestination: default\n    gateway: 192.168.1.1\n  interface: en0\n"
	if got := parseRouteIface(route); got != "en0" {
		t.Fatalf("iface %q", got)
	}
	summary := "<dictionary> {\n  BSSID : aa:bb\n  SSID : Cafe\n  Security : WPA2_PSK\n}"
	if got := parseWiFiSecurity(summary); got != "WPA2_PSK" {
		t.Fatalf("security %q", got)
	}
	if got := parseWiFiSecurity("<dictionary> {\n  InterfaceType : Ethernet\n}"); got != "" {
		t.Fatalf("wired gave %q", got)
	}
}

func TestWeakWiFi(t *testing.T) {
	for sec, weak := range map[string]bool{"NONE": true, "OPEN": true, "WEP": true, "WPA_PSK": true, "WPA2_PSK": false, "WPA3_SAE": false, "WPA2_ENTERPRISE": false, "OWE": false, "": false} {
		if got := weakWiFi(sec); got != weak {
			t.Errorf("weakWiFi(%q) = %v, want %v", sec, got, weak)
		}
	}
}

func TestExposedServicesNamesWhatAnswers(t *testing.T) {
	open := map[string]bool{"192.168.1.18:22": true, "192.168.1.18:445": true, "192.168.1.18:7000": true}
	got := exposedServices("192.168.1.18", func(a string) bool { return open[a] })
	want := []string{"Remote Login (SSH)", "File Sharing (SMB)", "AirPlay Receiver"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	if got := exposedServices("", func(string) bool { return true }); got != nil {
		t.Fatalf("no LAN address gave %v", got)
	}
}

func TestWiFiRiskIsAWarningWithAdviceOnly(t *testing.T) {
	ok := Snapshot{Online: true, API: Result{Status: 200}, Loc: "MY"}
	if c, _ := Classify(ok); c != OK {
		t.Fatalf("baseline %s", c)
	}
	weak := ok
	weak.WiFiSec = "WEP"
	c, reason := Classify(weak)
	if c != WiFiRisk || c.Blocking() || !strings.Contains(reason, "WEP") {
		t.Fatalf("weak Wi-Fi: %s %q", c, reason)
	}
	exposed := ok
	exposed.WiFiSec, exposed.Exposed = "WPA2_PSK", []string{"Remote Login (SSH)"}
	if c, reason = Classify(exposed); c != WiFiRisk || !strings.Contains(reason, "Remote Login") {
		t.Fatalf("exposed: %s %q", c, reason)
	}
	for _, a := range Plan(WiFiRisk, exposed, "") {
		if a.Auto || a.Admin || a.Command != "" {
			t.Fatalf("Argo must only advise on Wi-Fi risk, got %+v", a)
		}
	}
}

func TestLoopInterval(t *testing.T) {
	for in, want := range map[string]string{"": "1m0s", "2m": "2m0s", "5s": "15s", "junk": "1m0s", "-1m": "1m0s"} {
		if got := loopInterval(in).String(); got != want {
			t.Errorf("loopInterval(%q) = %s, want %s", in, got, want)
		}
	}
}
