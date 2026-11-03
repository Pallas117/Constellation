//go:build darwin

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
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

// chatDBStatus reads Messages' record of the SMS sent to `to` at or after `at`:
// its error code and sent/delivered flags only, never the text. Reading
// ~/Library/Messages needs Full Disk Access for argo; without it the answer is
// smsUnreadable and alerts behave as before. `to` passed handleRe (digits and a
// leading + for SMS), so it is safe inside the SQL literal.
func chatDBStatus(to string, at time.Time) smsState {
	if !strings.HasPrefix(to, "+") || !handleRe.MatchString(to) {
		return smsUnreadable
	}
	db := filepath.Join(os.Getenv("HOME"), "Library", "Messages", "chat.db")
	since := (at.Unix() - 978307200 - 2) * int64(time.Second) // Messages counts ns from 2001-01-01
	q := fmt.Sprintf("SELECT m.error, m.is_sent, m.is_delivered FROM message m JOIN handle h ON m.handle_id = h.ROWID"+
		" WHERE m.is_from_me = 1 AND m.service = 'SMS' AND h.id = '%s' AND m.date >= %d ORDER BY m.date ASC LIMIT 1;", to, since)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "/usr/bin/sqlite3", "-readonly", "-json", db, q).Output()
	if err != nil {
		return smsUnreadable
	}
	return smsOutcome(out)
}

// chatDBReadable says whether argo can read Messages' records (Full Disk Access).
func chatDBReadable() bool {
	db := filepath.Join(os.Getenv("HOME"), "Library", "Messages", "chat.db")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return exec.CommandContext(ctx, "/usr/bin/sqlite3", "-readonly", db, "SELECT 1 FROM message LIMIT 1;").Run() == nil
}
