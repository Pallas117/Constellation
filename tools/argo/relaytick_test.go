package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// statusHub answers only Status; relayReady calls nothing else.
type statusHub struct {
	Hub
	err   error
	calls int
}

func (h *statusHub) Status(context.Context, []string) (map[string]string, error) {
	h.calls++
	return map[string]string{}, h.err
}

// A device enrolled before the relay existed has no node.key; it must join
// once its Gauss has the bundle routes, and stay out while it doesn't.
func TestRelayReadyJoinsWithoutKeysOnlyWhenHubAnswers(t *testing.T) {
	ctx := context.Background()
	keyFile := filepath.Join(t.TempDir(), "node.key")
	cfg := Config{GaussURL: "http://127.0.0.1:3001", Device: "judith"}
	hub := &statusHub{}
	hubFor := func(Config) (Hub, error) { return hub, nil }

	if !relayReady(ctx, cfg, keyFile, hubFor) {
		t.Fatal("hub with bundle routes and no keys yet: should join")
	}
	hub.err = errors.New("HTTP 404: this Gauss does not offer bundle relay yet")
	if relayReady(ctx, cfg, keyFile, hubFor) {
		t.Fatal("older Gauss without bundle routes: must not join")
	}
	if relayReady(ctx, Config{GaussURL: cfg.GaussURL}, keyFile, hubFor) {
		t.Fatal("unnamed device: must not join")
	}
	if relayReady(ctx, cfg, keyFile, func(Config) (Hub, error) { return nil, errors.New("no token") }) {
		t.Fatal("no hub (not enrolled): must not join")
	}

	if err := os.WriteFile(keyFile, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := hub.calls
	if !relayReady(ctx, cfg, keyFile, hubFor) {
		t.Fatal("device with keys: always syncs")
	}
	if hub.calls != before {
		t.Fatal("device with keys should not spend a status call on readiness")
	}
}
