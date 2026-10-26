package main

// A deterministic simulation of three devices and the Gauss hub over five
// days, run with the real relay code. It is the test-learn-improve loop for
// delay-tolerant delivery: each variant runs on the same link traces and
// traffic, and the test fails if the full relay loses a file, delivers one
// twice, or leaves a sender without a receipt.
//
// Links are calibrated on judith's own Argo history (24 h, 2026-10-23: 24
// drops, typical outage 3 min, p95 63 min, ~51 min between drops):
//   - judith: phone hotspot. Up ~Exp(50 min), down ~LogNormal(median 3 min, p95 ~60 min).
//   - field-2: the same hotspot model, and asleep 23:00-07:00 (no ticks at all).
//   - sat-1: an onboard computer reachable only during ground-station passes,
//     5 a day at varying times, 8-12 minutes each (the contact pattern DTN
//     was built for; the station forwards for it, modelled as the hub link).
//   - hub: wiped (bundles and tombstones lost) every ~36 h and down 10 min after.
//
// Run with -v to see the table. ARGO_SIM_SEED changes the seed.

import (
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	simStep    = 2 * time.Minute
	simDays    = 5
	simSendFor = 3 * 24 * time.Hour // traffic in the first 3 days, then 2 days to drain
	simFiles   = 60
)

type interval struct{ from, to time.Time }

type simTrace struct {
	down   map[string][]interval // per node: no network
	asleep map[string][]interval // per node: no ticks
	hubOff []interval
	wipes  []time.Time
	sends  []simSend
}

type simSend struct {
	at       time.Time
	from, to string
	name     string
	size     int
}

func within(iv []interval, t time.Time) bool {
	for _, x := range iv {
		if !t.Before(x.from) && t.Before(x.to) {
			return true
		}
	}
	return false
}

func hotspotTrace(rng *rand.Rand, start, end time.Time) []interval {
	var out []interval
	sigma := math.Log(20) / 1.645 // p95/median = 20 → median 3 min, p95 ~60 min
	for t := start; t.Before(end); {
		t = t.Add(time.Duration(rng.ExpFloat64() * float64(50*time.Minute)))
		d := time.Duration(math.Exp(math.Log(float64(3*time.Minute)) + sigma*rng.NormFloat64()))
		d = min(max(d, 30*time.Second), 6*time.Hour)
		out = append(out, interval{t, t.Add(d)})
		t = t.Add(d)
	}
	return out
}

func newSimTrace(seed uint64, start time.Time) simTrace {
	rng := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
	end := start.Add(simDays * 24 * time.Hour)
	tr := simTrace{down: map[string][]interval{}, asleep: map[string][]interval{}}
	tr.down["judith"] = hotspotTrace(rng, start, end)
	tr.down["field-2"] = hotspotTrace(rng, start, end)
	for d := 0; d < simDays; d++ {
		day := start.Add(time.Duration(d) * 24 * time.Hour)
		tr.asleep["field-2"] = append(tr.asleep["field-2"], interval{day.Add(23 * time.Hour), day.Add(31 * time.Hour)})
		// sat-1 is out of contact except for 5 passes spread over the day.
		last := day
		for p := range 5 {
			w := day.Add(time.Duration(p)*24*time.Hour/5 + time.Duration(rng.Int64N(int64(3*time.Hour))))
			tr.down["sat-1"] = append(tr.down["sat-1"], interval{last, w})
			last = w.Add(8*time.Minute + time.Duration(rng.Int64N(int64(4*time.Minute))))
		}
		tr.down["sat-1"] = append(tr.down["sat-1"], interval{last, day.Add(24 * time.Hour)})
	}
	for t := start.Add(20 * time.Hour); t.Before(end); t = t.Add(36 * time.Hour) {
		tr.wipes = append(tr.wipes, t)
		tr.hubOff = append(tr.hubOff, interval{t, t.Add(10 * time.Minute)})
	}
	nodes := []string{"judith", "field-2", "sat-1"}
	for i := range simFiles {
		from := nodes[rng.IntN(3)]
		to := nodes[(slices3(from)+1+rng.IntN(2))%3]
		size := 1 + rng.IntN(50<<10)
		if rng.IntN(5) == 0 {
			size = 2*chunkSize + rng.IntN(chunkSize) // three chunks
		}
		at := start.Add(time.Hour + time.Duration(rng.Int64N(int64(simSendFor))))
		tr.sends = append(tr.sends, simSend{at: at, from: from, to: to, name: fmt.Sprintf("msg-%03d.bin", i), size: size})
	}
	sort.Slice(tr.sends, func(i, j int) bool { return tr.sends[i].at.Before(tr.sends[j].at) })
	return tr
}

func slices3(n string) int {
	switch n {
	case "judith":
		return 0
	case "field-2":
		return 1
	}
	return 2
}

func (tr simTrace) online(node string, t time.Time) bool {
	return !within(tr.down[node], t) && !within(tr.asleep[node], t)
}

type simResult struct {
	name                 string
	delivered, receipted int
	duplicates           int
	latencies            []time.Duration
	hubPuts              int
}

func (r simResult) row() string {
	sort.Slice(r.latencies, func(i, j int) bool { return r.latencies[i] < r.latencies[j] })
	p := func(q float64) string {
		if len(r.latencies) == 0 {
			return "-"
		}
		return r.latencies[min(int(q*float64(len(r.latencies))), len(r.latencies)-1)].Round(time.Minute).String()
	}
	return fmt.Sprintf("%-42s delivered %2d/%d  receipts %2d/%d  duplicates %d  latency p50 %-8s p95 %-8s hub uploads %d",
		r.name, r.delivered, simFiles, r.receipted, simFiles, r.duplicates, p(0.5), p(0.95), r.hubPuts)
}

// directOnly is the comparison without store-and-forward: a file moves only
// when sender and receiver are online at the same moment (an optimistic
// model of a plain sync or file share). No hub, so wipes don't touch it.
func directOnly(tr simTrace, start time.Time) simResult {
	res := simResult{name: "direct only (both ends online at once)"}
	end := start.Add(simDays * 24 * time.Hour)
	for _, s := range tr.sends {
		for t := s.at; t.Before(end) && t.Before(s.at.Add(defaultTTL)); t = t.Add(simStep) {
			if tr.online(s.from, t) && tr.online(s.to, t) {
				res.delivered++
				res.receipted++
				res.latencies = append(res.latencies, t.Sub(s.at))
				break
			}
		}
	}
	return res
}

func runRelaySim(t *testing.T, tr simTrace, start time.Time, name string, tune func(*Relay)) simResult {
	t.Helper()
	clock := &fakeClock{t: start}
	hub := newMemHub(clock.now, "judith", "field-2", "sat-1")
	nodes := map[string]*testNode{}
	for _, n := range []string{"judith", "field-2", "sat-1"} {
		nodes[n] = newNode(t, n, hub, clock)
		tune(nodes[n].Relay)
	}
	for range 2 { // enrollment day: everyone online once, keys published and pinned
		for _, n := range []string{"judith", "field-2", "sat-1"} {
			nodes[n].Sync(ctx)
		}
	}
	src := t.TempDir()
	sendAt := map[string]time.Time{}
	keys := map[string][]string{} // file → its bundle keys at the sender
	got := map[string]time.Time{}
	receipted := map[string]bool{}
	res := simResult{name: name}
	next, wipe := 0, 0
	for ; clock.t.Before(start.Add(simDays * 24 * time.Hour)); clock.add(simStep) {
		now := clock.t
		for wipe < len(tr.wipes) && !now.Before(tr.wipes[wipe]) {
			hub.wipe()
			wipe++
		}
		hub.down = within(tr.hubOff, now)
		for next < len(tr.sends) && !tr.sends[next].at.After(now) {
			s := tr.sends[next]
			next++
			path := filepath.Join(src, s.name)
			if err := os.WriteFile(path, make([]byte, s.size), 0o600); err != nil {
				t.Fatal(err)
			}
			before := map[string]bool{}
			for k := range nodes[s.from].load().Out {
				before[k] = true
			}
			if _, _, err := nodes[s.from].Send(ctx, s.to, path, 0); err != nil { // works offline: keys are pinned
				t.Fatalf("send %s: %v", s.name, err)
			}
			for k := range nodes[s.from].load().Out {
				if !before[k] {
					keys[s.name] = append(keys[s.name], k)
				}
			}
			sendAt[s.name] = now
		}
		for _, n := range []string{"judith", "field-2", "sat-1"} {
			if !tr.online(n, now) {
				continue // relayTick skips while offline; asleep means no tick at all
			}
			rep := nodes[n].Sync(ctx)
			if rep.Delivered > 0 { // a receipt arrived: which of n's files are now fully confirmed?
				st := nodes[n].load()
				for _, s := range tr.sends[:next] {
					if s.from != n || receipted[s.name] {
						continue
					}
					all := true
					for _, k := range keys[s.name] {
						it, ok := st.Out[k]
						all = all && ok && it.State == stateDelivered
					}
					receipted[s.name] = all
				}
			}
			if rep.Received == 0 {
				continue
			}
			for _, r := range nodes[n].Inbox() {
				if _, ok := got[r.Name]; !ok {
					got[r.Name] = now
				}
			}
		}
	}
	for _, n := range nodes {
		for _, r := range n.Inbox() {
			if strings.Contains(r.Name, " (") { // "msg-001 (2).bin": the same file delivered again
				res.duplicates++
			}
		}
	}
	for _, s := range tr.sends {
		if at, ok := got[s.name]; ok {
			res.delivered++
			res.latencies = append(res.latencies, at.Sub(sendAt[s.name]))
		}
		if receipted[s.name] {
			res.receipted++
		}
	}
	res.hubPuts = hub.puts
	return res
}

func TestSimDelayTolerantDelivery(t *testing.T) {
	if testing.Short() {
		t.Skip("simulation")
	}
	seed := uint64(20261023)
	if v, err := strconv.ParseUint(os.Getenv("ARGO_SIM_SEED"), 10, 64); err == nil {
		seed = v
	}
	start := time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)
	tr := newSimTrace(seed, start)
	fsyncWrites = false
	defer func() { fsyncWrites = true }()
	direct := directOnly(tr, start)
	naive := runRelaySim(t, tr, start, "relay, hub trusted (no recheck, no re-receipt)", func(r *Relay) { r.NoHubRecheck, r.NoResendReceipt = true, true })
	full := runRelaySim(t, tr, start, "relay, end-to-end (Argo default)", func(*Relay) {})
	t.Logf("seed %d, %d files over %d days, %d hub wipes", seed, simFiles, simDays, len(tr.wipes))
	for _, r := range []simResult{direct, naive, full} {
		t.Log(r.row())
	}
	if full.delivered != simFiles || full.receipted != simFiles || full.duplicates != 0 {
		t.Fatalf("the full relay must deliver every file once, with a receipt: %s", full.row())
	}
	// On the default seed the wipes hit bundles in flight (59/60 delivered, 57/60
	// receipts for the hub-trusting variant); other seeds may miss them all.
	if seed == 20261023 && naive.delivered+naive.receipted >= 2*simFiles {
		t.Errorf("hub wipes should cost the hub-trusting variant something; if not, the scenario no longer tests recovery")
	}
}
