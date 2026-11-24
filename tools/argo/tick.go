package main

import (
	"encoding/json"
	"os"
	"syscall"
	"time"
)

// A tick that finds another argo run holding the lock. 2026-11-05: every blocking tick ran
// 100-130 s (two full probes of serial timeouts), launchd only re-fires after the exit, and an
// overlapping manual run was logged as an error with no record of how often. Now the second
// run exits quietly within milliseconds, counts itself in skipped.json, and when the default
// gateway is not the one the holder last saved it tells the holder to drop its probe and look
// again (SIGUSR1; Loop.probe), so a network change is classified within one probe budget
// instead of after the old probe's timeouts.

// Skipped is the record of ticks that found a run in progress.
type Skipped struct {
	Count     int       `json:"count"`
	Preempted int       `json:"preempted"` // of those, how many told the holder to re-probe
	LastAt    time.Time `json:"last_at"`
}

func (s Store) loadSkipped() Skipped {
	var k Skipped
	if b, err := os.ReadFile(s.path("skipped.json")); err == nil {
		_ = json.Unmarshal(b, &k)
	}
	return k
}

// tickBusy records the skip and decides whether to preempt the holder. gwNow is the default
// gateway right now (""; no route); the holder's saved gateway is in state.json. Only a holder
// whose lock advertises lockPreempt is signalled (store.go). kill is syscall.Kill in production.
func tickBusy(s Store, gwNow string, now time.Time, kill func(pid int, sig syscall.Signal) error) (preempted bool) {
	k := s.loadSkipped()
	k.Count++
	k.LastAt = now
	pid, ok := s.lockHolder()
	if ok && pid > 0 && pid != os.Getpid() && gwNow != s.Load().Gateway {
		if kill(pid, syscall.SIGUSR1) == nil {
			k.Preempted++
			preempted = true
		}
	}
	if b, err := json.Marshal(k); err == nil {
		_ = os.WriteFile(s.path("skipped.json"), b, 0o600)
	}
	return preempted
}
