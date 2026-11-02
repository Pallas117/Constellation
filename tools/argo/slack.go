package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Slack is a second alert sink beside SMS (GAU-197): a Slack app's incoming
// webhook, posting as a bot so it notifies (your own messages never do). It
// reuses Phone's mask, format and offline queue; only the send differs.
//
// The webhook URL is a secret. It lives in ~/.config/argo/slack-webhook (0600),
// is only accepted for hooks.slack.com, and never appears in errors or output.

const slackFile = "slack-webhook"

var slackURLRe = regexp.MustCompile(`^https://hooks\.slack\.com/services/[A-Za-z0-9_/-]{20,200}$`)

// readSlackURL returns the webhook URL, or an error that never contains it.
func readSlackURL(dir string) (string, error) {
	path := filepath.Join(dir, slackFile)
	fi, err := os.Stat(path)
	if err != nil {
		return "", errors.New("no Slack webhook set up")
	}
	if fi.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("%s must be private: chmod 600 it", path)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("cannot read the Slack webhook file")
	}
	u := strings.TrimSpace(string(b))
	if !slackURLRe.MatchString(u) {
		return "", errors.New("the Slack webhook file must hold one https://hooks.slack.com/services/… URL")
	}
	return u, nil
}

// slackPoster posts text to the webhook. Errors are generic on purpose:
// net/http errors embed the request URL, which is the secret.
func slackPoster(webhook string, client *http.Client) func(string, string) error {
	return func(_ string, text string) error {
		body, _ := json.Marshal(map[string]string{"text": text})
		req, err := http.NewRequest(http.MethodPost, webhook, bytes.NewReader(body))
		if err != nil {
			return errors.New("slack: bad request")
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return errors.New("slack: post failed (offline?)")
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return fmt.Errorf("slack: HTTP %d", resp.StatusCode)
		}
		return nil
	}
}

// newSlack builds the Slack sink from the config dir, or nil when none is set up.
func newSlack(cfgDir, stateDir, device string) *Phone {
	u, err := readSlackURL(cfgDir)
	if err != nil {
		return nil
	}
	if device == "" {
		device, _ = os.Hostname()
		device = strings.TrimSuffix(device, ".local")
	}
	return &Phone{
		Queue:  filepath.Join(stateDir, "slack-queue.jsonl"),
		Device: device,
		send:   slackPoster(u, &http.Client{Timeout: 10 * time.Second}),
	}
}

// slackCmd: `argo slack test` sends one test message to Slack only.
func slackCmd(args []string, now time.Time) error {
	if len(args) != 1 || args[0] != "test" {
		return errors.New("usage: argo slack test   (webhook URL goes in ~/.config/argo/slack-webhook, chmod 600)")
	}
	if _, err := readSlackURL(configDir()); err != nil {
		return err
	}
	s := newSlack(configDir(), DefaultStore().Dir, loadConfig().Device)
	text := fmt.Sprintf("%s on %s (%s)\n%s", "Argo test", s.Device, now.Local().Format("15:04"), "Slack alerts are wired up.")
	if err := s.send("", text); err != nil {
		return err
	}
	fmt.Println("sent a test message to Slack")
	return nil
}
