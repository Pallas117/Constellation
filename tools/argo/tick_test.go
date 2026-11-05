package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

// A stalled uplink: every check hangs until its context ends. The four checks must run together
// under the one budget, so the probe costs one budget, not the sum of the timeouts.
func TestNetChecksShareOneDeadline(t *testing.T) {
	var mu sync.Mutex
	var starts, ends []time.Time
	stall := func(ctx context.Context) {
		mu.Lock()
		starts = append(starts, time.Now())
		mu.Unlock()
		<-ctx.Done()
		mu.Lock()
		ends = append(ends, time.Now())
		mu.Unlock()
	}
	c := netChecks{
		lookup: func(ctx context.Context, _ string) error { stall(ctx); return ctx.Err() },
		direct: func(context.Context, string) bool { return false },
		get: func(ctx context.Context, _ string) (Result, string) {
			stall(ctx)
			return Result{Err: ErrTimeout, Detail: ctx.Err().Error()}, ""
		},
	}
	s := Snapshot{Online: true}
	t0 := time.Now()
	c.run(context.Background(), &s, 200*time.Millisecond)
	took := time.Since(t0)
	if took > time.Second {
		t.Fatalf("probe took %s with a 200 ms budget", took)
	}
	if len(starts) != 4 || len(ends) != 4 {
		t.Fatalf("checks started %d, ended %d; want 4 and 4", len(starts), len(ends))
	}
	last := starts[0]
	for _, x := range starts {
		if x.After(last) {
			last = x
		}
	}
	for _, e := range ends {
		if e.Before(last) {
			t.Fatalf("a check ended (%s) before all had started (%s): they ran in series", e.Sub(t0), last.Sub(t0))
		}
	}
	if s.DNS.Err != ErrDNS || s.API.Err != ErrTimeout || s.Captive.Err != ErrTimeout || s.PublicIP != "" {
		t.Fatalf("snapshot after a stall: %+v", s)
	}
}

// A healthy link: the checks fill the snapshot as before, and the captive check reads the body.
func TestNetChecksFillSnapshot(t *testing.T) {
	c := netChecks{
		lookup: func(context.Context, string) error { return nil },
		direct: func(context.Context, string) bool { return true },
		get: func(_ context.Context, u string) (Result, string) {
			switch u {
			case captiveURL:
				return Result{OK: true, Status: 200}, "<HTML><BODY>Success</BODY></HTML>"
			case apiURL:
				return Result{OK: true, Status: 405, ConnectMs: 40}, ""
			}
			return Result{OK: true, Status: 200}, "ip=203.0.113.9\nloc=my\n"
		},
	}
	s := Snapshot{Online: true}
	c.run(context.Background(), &s, time.Second)
	if !s.DNS.OK || s.DNSDirectOK || !s.Captive.OK || s.API.Status != 405 || s.PublicIP != "203.0.113.9" || s.Loc != "MY" {
		t.Fatalf("snapshot: %+v", s)
	}
	if c, _ := Classify(s); c != OK {
		t.Fatalf("class %s, want OK", c)
	}
}

// ctxProber answers from a function that sees the probe context, so a test can stall a probe
// until it is cancelled.
type ctxProber struct {
	n     int
	probe func(ctx context.Context, n int) Snapshot
}

func (p *ctxProber) Probe(ctx context.Context) Snapshot { p.n++; return p.probe(ctx, p.n) }

// A SystemConfiguration change arrives while the probe is stuck in the old network's timeouts:
// the newer tick sends SIGUSR1, the probe is dropped and run again, and the new network is
// classified right away.
func TestPreemptCancelsRunningProbe(t *testing.T) {
	ok := fixture(t, "my_sim_ok.json")
	ok.GatewayMAC, ok.PublicIP = "aa:bb:cc:dd:ee:ff", "203.0.113.9"
	pre := make(chan os.Signal, 1)
	var cancelledAfter time.Duration
	p := &ctxProber{probe: func(ctx context.Context, n int) Snapshot {
		if n == 1 {
			t0 := time.Now()
			select {
			case <-ctx.Done():
				cancelledAfter = time.Since(t0)
			case <-time.After(5 * time.Second):
				t.Error("first probe was never cancelled")
			}
			return Snapshot{Online: true, API: Result{Err: ErrTimeout}, Captive: Result{Err: ErrTimeout}}
		}
		return ok
	}}
	fx := &fakeFx{now: time.Date(2026, 11, 5, 11, 13, 50, 0, time.UTC)}
	l := Loop{Prober: p, Store: Store{Dir: t.TempDir()}, Fx: fx, Preempt: pre}
	go func() { time.Sleep(30 * time.Millisecond); pre <- syscall.SIGUSR1 }()
	t0 := time.Now()
	st := l.Tick(context.Background())
	if st.Class != OK || p.n != 2 {
		t.Fatalf("class %s after %d probes, want OK after 2", st.Class, p.n)
	}
	if took := time.Since(t0); took > time.Second || cancelledAfter > time.Second {
		t.Fatalf("tick took %s, probe cancelled after %s", took, cancelledAfter)
	}
	// Only one retry: a second preemption during the retry does not loop.
	p2 := &ctxProber{probe: func(ctx context.Context, n int) Snapshot { <-ctx.Done(); return Snapshot{} }}
	pre2 := make(chan os.Signal, 2)
	pre2 <- syscall.SIGUSR1
	pre2 <- syscall.SIGUSR1
	l2 := Loop{Prober: p2, Store: Store{Dir: t.TempDir()}, Fx: fx, Preempt: pre2}
	if s := l2.probe(context.Background()); s.Online || p2.n != 2 {
		t.Fatalf("probes = %d, want 2 (one retry)", p2.n)
	}
	// Without a preempt channel the probe is plain.
	l3 := Loop{Prober: &seqProber{snaps: []Snapshot{ok}}, Store: Store{Dir: t.TempDir()}, Fx: fx}
	if s := l3.probe(context.Background()); s.PublicIP != ok.PublicIP {
		t.Fatal("plain probe did not run")
	}
}

func TestLockNamesHolderAndAdvertisesPreempt(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	unlock, err := s.Lock()
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	if pid, ok := s.lockHolder(); pid != os.Getpid() || !ok {
		t.Fatalf("lockHolder = %d %v, want %d true", pid, ok, os.Getpid())
	}
	if _, err := s.Lock(); err == nil || err.Error() != "another argo run is in progress" {
		t.Fatalf("second Lock: %v", err)
	}
	// An older binary's lock (pid only) is honoured but never signalled.
	old := Store{Dir: t.TempDir()}
	_ = os.WriteFile(old.path("lock"), []byte("4242\n"), 0o600)
	if pid, ok := old.lockHolder(); pid != 4242 || ok {
		t.Fatalf("old-style lock: %d %v", pid, ok)
	}
	_ = os.WriteFile(old.path("lock"), []byte("junk\n"), 0o600)
	if pid, _ := old.lockHolder(); pid != 0 {
		t.Fatalf("junk lock parsed as pid %d", pid)
	}
}

func TestTickBusyCountsAndPreemptsOnlyWhenTheGatewayMoved(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	_ = os.MkdirAll(s.Dir, 0o700)
	if err := s.Save(State{Gateway: "10.0.0.1", CheckedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	var killed []int
	kill := func(pid int, sig syscall.Signal) error {
		if sig != syscall.SIGUSR1 {
			t.Fatalf("signal %v, want SIGUSR1", sig)
		}
		killed = append(killed, pid)
		return nil
	}
	now := time.Date(2026, 11, 5, 11, 24, 1, 0, time.UTC)
	write := func(content string) { _ = os.WriteFile(filepath.Join(s.Dir, "lock"), []byte(content), 0o600) }

	write("777\npreempt\n")
	if tickBusy(s, "10.0.0.1", now, kill) || len(killed) != 0 { // same gateway: the holder is probing the right network
		t.Fatalf("preempted with the gateway unchanged; killed %v", killed)
	}
	if !tickBusy(s, "10.0.0.2", now, kill) || len(killed) != 1 || killed[0] != 777 { // moved: tell the holder
		t.Fatalf("not preempted on a gateway change; killed %v", killed)
	}
	if !tickBusy(s, "", now, kill) || len(killed) != 2 { // route gone: also a change
		t.Fatalf("not preempted when the route vanished; killed %v", killed)
	}
	write("777\n") // older binary: SIGUSR1 would kill it
	if tickBusy(s, "10.0.0.2", now, kill) || len(killed) != 2 {
		t.Fatalf("signalled a holder that cannot handle it; killed %v", killed)
	}
	write("778\npreempt\n")
	if tickBusy(s, "10.0.0.2", now, func(int, syscall.Signal) error { return errors.New("gone") }) {
		t.Fatal("counted a failed signal as a preemption")
	}
	k := s.loadSkipped()
	if k.Count != 5 || k.Preempted != 2 || !k.LastAt.Equal(now) {
		t.Fatalf("skipped = %+v, want count 5 preempted 2", k)
	}
}
