//go:build darwin

package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// macOS host probing and effects: the system tools Argo has always used.

const phoneSupported = true

const (
	hostNoun      = "Mac"
	sharingAdvice = "Turn off what you don't need in System Settings > General > Sharing"
)

func hostProbe(ctx context.Context, s *Snapshot) {
	route := run(ctx, "route", "-n", "get", "default")
	s.Gateway, s.Online = parseDefaultRoute(route)
	if s.Online {
		s.GatewayMAC = parseARP(run(ctx, "arp", "-n", s.Gateway))
		probeWiFi(ctx, s, route)
	}
	s.WPAD, s.PAC = parseScutilAuto(run(ctx, "scutil", "--proxy"))
	for _, pr := range parseScutilProxies(run(ctx, "scutil", "--proxy")) {
		pr.Alive = dialAlive(pr.URL)
		s.Proxies = append(s.Proxies, pr)
	}
}

// pingArgs: five pings 0.2 s apart (allowed without root), whole run capped at 4 s.
func pingArgs(host string) []string { return []string{"-n", "-c", "5", "-i", "0.2", "-t", "4", host} }

// wifiSignalInfo is slow (~5 s), so the prober caches what it parses from it.
func wifiSignalInfo(ctx context.Context) string {
	return run(ctx, "system_profiler", "SPAirPortDataType")
}

func staleProcs(ctx context.Context) []StaleProc {
	return findStaleProcs(run(ctx, "ps", "-E", "-ww", "-x", "-o", "pid=,command="), dialAlive)
}

func localGateway(ctx context.Context) (string, string) {
	gw, ok := parseDefaultRoute(run(ctx, "route", "-n", "get", "default"))
	if !ok {
		return "", ""
	}
	return gw, parseARP(run(ctx, "arp", "-n", gw))
}

func desktopNotify(title, msg string) {
	// Message is passed as an argv item, never interpolated into AppleScript.
	_ = exec.Command("osascript",
		"-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run",
		title, msg).Run()
}

func openURL(u string) error { return exec.Command("open", u).Run() }

func messagesSend(service, to, text string) error {
	ctx, cancel := context.WithTimeout(context.Background(), sendTimeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "osascript",
		"-e", "on run argv",
		"-e", `tell application "Messages"`,
		"-e", "set svc to 1st account whose service type = "+service, // constant, not user input
		"-e", "send (item 2 of argv) to participant (item 1 of argv) of svc",
		"-e", "end tell",
		"-e", "end run",
		to, text).CombinedOutput()
	if err != nil {
		return fmt.Errorf("Messages (%s): %s", service, strings.TrimSpace(string(out)))
	}
	return nil
}
