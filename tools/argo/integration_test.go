//go:build integration

package main

import (
	"context"
	"testing"
	"time"
)

// Runs the real probes on this machine: go test -tags integration ./...
// Read-only: writes no state, sends no notifications.
func TestDoctorOnThisMachine(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	s := SystemProber{}.Probe(ctx)
	c, reason := Classify(s)
	t.Logf("class=%s loc=%s api=%d reason=%s", c, s.Loc, s.API.Status, reason)
	if c == "" {
		t.Fatal("no class")
	}
	if s.Online && s.DNS.OK && s.API.Status == 0 && s.API.Err == "" {
		t.Fatal("online with DNS but the API probe recorded nothing")
	}
}
