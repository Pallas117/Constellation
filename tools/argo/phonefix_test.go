package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestRunnableOnlyAllowlistedNoSudoSteps(t *testing.T) {
	cases := []struct {
		a    Action
		want bool
	}{
		{Action{ID: "check-magicdns", Command: "tailscale set --accept-dns=false"}, true},
		{Action{ID: "restart-daemon", Command: "claude daemon stop --any"}, true},
		{Action{ID: "flush-dns", Command: "sudo dscacheutil -flushcache", Admin: true}, false},
		{Action{ID: "wpad-off", Command: "sudo networksetup -setproxyautodiscovery Wi-Fi off", Admin: true}, false},
		{Action{ID: "switch-network", Say: "Switch network."}, false},                                // advice only
		{Action{ID: "check-magicdns", Command: "tailscale set --accept-dns=false; rm -rf ~"}, false}, // no shell tricks
		{Action{ID: "exit-node", Command: "tailscale set --exit-node=$(evil) --exit-node-allow-lan-access"}, false},
	}
	for _, c := range cases {
		if got := runnable(c.a); got != c.want {
			t.Errorf("%s %q: runnable=%v, want %v", c.a.ID, c.a.Command, got, c.want)
		}
	}
}

func TestFixListMarksWhatThePhoneCanRun(t *testing.T) {
	plan := []Action{
		{ID: "check-magicdns", Say: "Tailscale's DNS is failing.", Command: "tailscale set --accept-dns=false"},
		{ID: "flush-dns", Say: "Flush DNS.", Command: "sudo dscacheutil -flushcache", Admin: true},
		{ID: "switch-network", Say: "Switch network."},
	}
	var b bytes.Buffer
	fixList(&b, DNS, "DNS fails", plan)
	out := b.String()
	for _, want := range []string{"1. Tailscale's DNS", "[run: argo fix check-magicdns]", "[needs sudo at the Mac]", "3. Switch network.\n   [advice]"} {
		if !strings.Contains(out, want) {
			t.Errorf("list misses %q:\n%s", want, out)
		}
	}
}

func TestFixStepRunsOnlyACurrentRunnableStep(t *testing.T) {
	plan := []Action{
		{ID: "check-magicdns", Command: "tailscale set --accept-dns=false"},
		{ID: "flush-dns", Command: "sudo dscacheutil -flushcache", Admin: true},
	}
	var ran []string
	run := func(name string, args ...string) error {
		ran = append(ran, name+" "+strings.Join(args, " "))
		return nil
	}
	var b bytes.Buffer
	if err := fixStep(context.Background(), &b, plan, "check-magicdns", run); err != nil || strings.Join(ran, ";") != "tailscale set --accept-dns=false" {
		t.Fatalf("runnable step: err=%v ran=%v", err, ran)
	}
	if err := fixStep(context.Background(), &b, plan, "flush-dns", run); err == nil || !strings.Contains(err.Error(), "sudo") {
		t.Fatalf("sudo step ran or wrong error: %v", err)
	}
	if err := fixStep(context.Background(), &b, plan, "restart-daemon", run); err == nil || !strings.Contains(err.Error(), "not a step") {
		t.Fatalf("a step not in the current plan ran: %v", err)
	}
	if len(ran) != 1 {
		t.Fatalf("ran more than the one allowed step: %v", ran)
	}
}

func TestIncidentTextSaysHowToFixFromThePhone(t *testing.T) {
	if h := fixHint([]Action{{ID: "check-magicdns", Command: "tailscale set --accept-dns=false"}}); !strings.Contains(h, "gauss-phone fix") {
		t.Fatalf("hint missing: %q", h)
	}
	if h := fixHint([]Action{{ID: "switch-network", Say: "Switch network."}}); h != "" {
		t.Fatalf("hint for advice-only plan: %q", h)
	}
}
