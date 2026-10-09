package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Slack alerts go to an incoming webhook stored 0600 in ~/.config/argo/slack_webhook.
// Only hooks.slack.com over HTTPS is accepted, and only the masked title and
// message are sent. Alerts that fail (e.g. while offline) are queued and sent
// on the next successful alert or tick.

const maxQueued = 20

type Slack struct {
	Webhook string
	Queue   string // jsonl file of pending alerts
	Device  string
	Client  *http.Client
}

func validWebhook(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme != "https" || u.Host != "hooks.slack.com" || !strings.HasPrefix(u.Path, "/services/") {
		return errors.New("not a Slack incoming webhook (https://hooks.slack.com/services/...)")
	}
	return nil
}

func loadSlack(device string) *Slack {
	b, err := os.ReadFile(filepath.Join(configDir(), "slack_webhook"))
	if err != nil || validWebhook(string(b)) != nil {
		return nil
	}
	if device == "" {
		device, _ = os.Hostname()
	}
	return &Slack{
		Webhook: strings.TrimSpace(string(b)),
		Queue:   filepath.Join(DefaultStore().Dir, "slack-queue.jsonl"),
		Device:  device,
		Client:  &http.Client{Timeout: 6 * time.Second, Transport: &http.Transport{Proxy: nil}},
	}
}

type slackMsg struct {
	Text string `json:"text"`
}

// Send delivers any queued alerts first, then this one; failures are queued.
func (s *Slack) Send(title, msg string, at time.Time) {
	text := fmt.Sprintf("*%s* on `%s` (%s)\n%s", Mask(title), s.Device, at.Local().Format("15:04"), Mask(msg))
	pending := append(s.readQueue(), text)
	var failed []string
	for _, t := range pending {
		if len(failed) > 0 || s.post(t) != nil {
			failed = append(failed, t)
		}
	}
	s.writeQueue(failed)
}

// Flush retries queued alerts; called every tick so offline alerts arrive once back online.
func (s *Slack) Flush() {
	q := s.readQueue()
	if len(q) == 0 {
		return
	}
	var failed []string
	for _, t := range q {
		if len(failed) > 0 || s.post(t) != nil {
			failed = append(failed, t)
		}
	}
	s.writeQueue(failed)
}

func (s *Slack) post(text string) error {
	body, _ := json.Marshal(slackMsg{Text: text})
	resp, err := s.Client.Post(s.Webhook, "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("slack returned %d", resp.StatusCode)
	}
	return nil
}

func (s *Slack) readQueue() []string {
	f, err := os.Open(s.Queue)
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var t string
		if json.Unmarshal(sc.Bytes(), &t) == nil {
			out = append(out, t)
		}
	}
	return out
}

func (s *Slack) writeQueue(q []string) {
	if len(q) > maxQueued {
		q = q[len(q)-maxQueued:]
	}
	if len(q) == 0 {
		os.Remove(s.Queue)
		return
	}
	_ = os.MkdirAll(filepath.Dir(s.Queue), 0o700)
	var b bytes.Buffer
	for _, t := range q {
		j, _ := json.Marshal(t)
		b.Write(append(j, '\n'))
	}
	_ = os.WriteFile(s.Queue, b.Bytes(), 0o600)
}

// slackSetup reads the webhook from stdin so it never lands in shell history.
func slackSetup(args []string, device string) error {
	if len(args) > 0 && args[0] == "test" {
		s := loadSlack(device)
		if s == nil {
			return errors.New("no Slack webhook configured; run `argo slack` first")
		}
		if err := s.post(fmt.Sprintf("*Argo test* from `%s`: Slack alerts are working.", s.Device)); err != nil {
			return err
		}
		fmt.Println("sent a test message to Slack")
		return nil
	}
	if len(args) > 0 && args[0] == "off" {
		err := os.Remove(filepath.Join(configDir(), "slack_webhook"))
		if errors.Is(err, os.ErrNotExist) {
			err = nil
		}
		fmt.Println("Slack alerts off.")
		return err
	}
	fmt.Fprint(os.Stderr, "Paste the Slack incoming webhook URL, then Enter: ")
	var hook string
	if _, err := fmt.Fscanln(os.Stdin, &hook); err != nil {
		return errors.New("no webhook read")
	}
	if err := validWebhook(hook); err != nil {
		return err
	}
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(configDir(), "slack_webhook"), []byte(strings.TrimSpace(hook)+"\n"), 0o600); err != nil {
		return err
	}
	fmt.Println("saved. Run `argo slack test` to check it.")
	return nil
}
