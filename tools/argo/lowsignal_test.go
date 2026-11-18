package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var lsT0 = time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)

func bad() LinkSample  { return LinkSample{Online: true, Failed: true, Loss: 0.2, RTTMs: 2000} }
func good() LinkSample { return LinkSample{Online: true, RTTMs: 80} }
func meh() LinkSample  { return LinkSample{Online: true, Loss: 0.1, RTTMs: 900} } // neither good nor bad

func TestLowSignalHysteresis(t *testing.T) {
	var l LowSignal
	now := lsT0
	for i := range 2 {
		l.Observe(bad(), now)
		if l.On {
			t.Fatalf("on after %d bad probes", i+1)
		}
	}
	if !l.Observe(bad(), now) || !l.On || l.Level < 1 {
		t.Fatalf("3 bad probes should turn it on: %+v", l)
	}
	// Good probes alone are not enough: not before the minimum stay, not before 10 in a row.
	for range 9 {
		now = now.Add(time.Minute)
		l.Observe(good(), now)
	}
	if !l.On {
		t.Fatal("left after 9 good probes")
	}
	l.Observe(good(), now.Add(time.Minute))
	if !l.On {
		t.Fatal("left before the minimum stay")
	}
	// An in-between probe changes nothing; a bad one resets the good run.
	l.Observe(meh(), now.Add(2*time.Minute))
	if l.Good != 10 {
		t.Fatalf("an in-between probe must not reset the run: %+v", l)
	}
	l.Observe(bad(), now.Add(3*time.Minute))
	if l.Good != 0 || !l.On {
		t.Fatalf("a bad probe resets the good run: %+v", l)
	}
	later := now.Add(30 * time.Minute)
	for i := range lowLeaveGood {
		later = later.Add(time.Minute)
		l.Observe(good(), later)
		if i < lowLeaveGood-1 && !l.On {
			t.Fatalf("left early at %d", i)
		}
	}
	if l.On || l.ChunkBytes() != chunkSize || l.TimeoutScale() != 1 {
		t.Fatalf("should be off after a sustained good window: %+v", l)
	}
}

func TestLowSignalDoesNotFlap(t *testing.T) {
	var l LowSignal
	flips, was := 0, false
	now := lsT0
	for i := range 200 { // alternating good and bad: never 3 bad in a row, never 10 good in a row
		now = now.Add(time.Minute)
		if i%2 == 0 {
			l.Observe(good(), now)
		} else {
			l.Observe(bad(), now)
		}
		if l.On != was {
			flips++
			was = l.On
		}
	}
	if flips != 0 {
		t.Fatalf("flipped %d times on alternating probes", flips)
	}
}

func TestLowSignalChunkLadder(t *testing.T) {
	var l LowSignal
	if l.ChunkBytes() != 1<<20 {
		t.Fatalf("normal chunk %d", l.ChunkBytes())
	}
	now := lsT0
	worst := LinkSample{Online: true, Failed: true, Loss: 0.5, RTTMs: 4000}
	for range 3 {
		l.Observe(worst, now)
	}
	if l.Level != 2 || l.ChunkBytes() != 4<<10 || l.TimeoutScale() != 6 || l.ReportGap() != lowReportEvery {
		t.Fatalf("worst link: %+v", l)
	}
	for range lowStepDownGood { // a few good probes relax one step, not all the way
		now = now.Add(time.Minute)
		l.Observe(good(), now)
	}
	if l.Level != 1 || l.ChunkBytes() != 64<<10 {
		t.Fatalf("should relax to 64 KiB: %+v", l)
	}
	if got := l.Label(); got != " low-signal (64 KiB chunks)" {
		t.Fatalf("label %q", got)
	}
}

func TestJitterBackoff(t *testing.T) {
	base, ceil := 30*time.Second, 15*time.Minute
	prev := time.Duration(0)
	for a := 1; a <= 4; a++ {
		lo, hi := jitterBackoff(a, base, ceil, 0), jitterBackoff(a, base, ceil, 0.999)
		d := base << (a - 1)
		if lo != d/2 || hi < d-time.Second || hi > d {
			t.Fatalf("attempt %d: %v..%v for %v", a, lo, hi, d)
		}
		if lo <= prev {
			t.Fatalf("not growing: %v after %v", lo, prev)
		}
		prev = lo
	}
	if jitterBackoff(50, base, ceil, 0.999) > ceil || jitterBackoff(0, base, ceil, 0) != base/2 {
		t.Fatal("must cap at the ceiling and treat 0 attempts as 1")
	}
	if jitterBackoff(3, base, ceil, 0.1) == jitterBackoff(3, base, ceil, 0.9) {
		t.Fatal("jitter must spread retries")
	}
}

func TestRelayLowSignalSmallChunksAndResume(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	a.Low = LowSignal{On: true, Level: 1}
	big := make([]byte, 200<<10+5)
	for i := range big {
		big[i] = byte(i * 7)
	}
	if _, n, err := a.Send(ctx, "ground-1", writeTemp(t, "log.bin", big), 0); err != nil || n != 4 {
		t.Fatalf("64 KiB chunks of 200 KiB should be 4, got %d %v", n, err)
	}
	// Sender and receiver may use different modes: the receiver works the chunk size out itself.
	if rep := a.Sync(ctx); rep.Uploaded != 4 {
		t.Fatalf("4 bulk chunks fit one low-signal round: %+v", rep)
	}
	b.Sync(ctx)
	in := b.Inbox()
	if len(in) != 1 {
		t.Fatalf("inbox %+v", in)
	}
	if got, _ := os.ReadFile(in[0].Path); string(got) != string(big) {
		t.Fatal("reassembled file differs")
	}
	a.Low = LowSignal{On: true, Level: 2}
	if _, n, _ := a.Send(ctx, "ground-1", writeTemp(t, "tiny.bin", make([]byte, 9<<10)), 0); n != 3 {
		t.Fatalf("4 KiB chunks of 9 KiB should be 3, got %d", n)
	}
	if _, _, err := a.Send(ctx, "ground-1", writeTemp(t, "huge.bin", make([]byte, lowMaxFileBytes+1)), 0); err == nil || !strings.Contains(err.Error(), "link is weak") {
		t.Fatalf("a big file on a 4 KiB link should wait: %v", err)
	}
}

func TestRelayLowSignalCapsBulkPerSync(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	a.Low = LowSignal{On: true, Level: 1}
	if _, n, err := a.Send(ctx, "ground-1", writeTemp(t, "x.bin", make([]byte, 10*64<<10)), 0); err != nil || n != 10 {
		t.Fatalf("send %d %v", n, err)
	}
	var per []int
	for range 3 {
		per = append(per, a.Sync(ctx).Uploaded)
	}
	if per[0] != lowBulkPerSync || per[1] != lowBulkPerSync || per[2] != 2 {
		t.Fatalf("uploads per sync %v", per)
	}
}

func TestRelayLowSignalBackoffGrowsWithJitter(t *testing.T) {
	r := &Relay{Rand: func() float64 { return 0.5 }}
	n := r.retryFor(1)
	r.Low = LowSignal{On: true, Level: 2}
	if low := r.retryFor(1); low <= n || r.retryFor(3) <= r.retryFor(2) {
		t.Fatalf("low-signal retries must be longer and grow: %v vs %v", low, n)
	}
	if r.retryFor(40) > 2*retryMax {
		t.Fatal("back-off must have a ceiling")
	}
}

func TestPendingPriorityReceiptsAlertsThenBulk(t *testing.T) {
	st := &relayState{Out: map[string]*outItem{}}
	add := func(it outItem) { it.State = stateQueued; st.Out[it.Key] = &it }
	add(outItem{Key: "f2", Transfer: "t1", Chunk: 2, Created: lsT0})
	add(outItem{Key: "f0", Transfer: "t1", Chunk: 0, Created: lsT0})
	add(outItem{Key: "f1", Transfer: "t1", Chunk: 1, Created: lsT0})
	add(outItem{Key: "alert", Created: lsT0.Add(time.Hour)})
	add(outItem{Key: "offer", Offer: "k1", Created: lsT0.Add(2 * time.Hour)})
	add(outItem{Key: "receipt", Receipt: true, Created: lsT0.Add(3 * time.Hour)})
	var got []string
	for _, it := range pending(st, stateQueued) {
		got = append(got, it.Key)
	}
	if strings.Join(got, ",") != "receipt,alert,offer,f0,f1,f2" {
		t.Fatalf("order %v", got)
	}
}

func TestSampleForAnchorsAndSignal(t *testing.T) {
	s := Snapshot{Online: true, API: Result{Err: ErrDNS}, Anchors: Anchors{Up: 2, Total: 3}}
	if sampleFor(s, NetScore{RTTMs: 100}, LowSignal{}).Failed {
		t.Fatal("one dead path with live anchors is not a weak link")
	}
	s.Anchors.Up = 0
	if !sampleFor(s, NetScore{RTTMs: 100}, LowSignal{}).Failed {
		t.Fatal("all anchors dead means the link failed")
	}
	s = Snapshot{Online: true, Signal: &WiFiSignal{RSSI: -88, Noise: -95}}
	if ls := sampleFor(s, NetScore{RTTMs: 100}, LowSignal{}); !isBadSample(ls) || ls.RSSI != -88 {
		t.Fatalf("weak RSSI should read as bad: %+v", ls)
	}
	var l LowSignal
	l.Recent = []bool{true, false, false}
	if ls := sampleFor(Snapshot{Online: true}, NetScore{RTTMs: 50}, l); ls.Loss != 0.5 {
		t.Fatalf("loss over the window: %v", ls.Loss)
	}
}

func TestPhonePrefersSMSWhenDataProbesFail(t *testing.T) {
	var via []string
	p := testPhone(t, func(_, _ string) error { via = append(via, "imessage"); return nil })
	p.sendRelay = func(_, _ string) error { via = append(via, "sms"); return nil }
	low := LowSignal{On: true, LastFailures: 2}
	p.PreferSMS = func() bool { return low.PreferSMS() }
	p.Send("Argo: slow", "The link is weak.", time.Now())
	low = LowSignal{On: true, LastFailures: 0}
	p.Send("Argo: slow", "Still weak but data works.", time.Now())
	if strings.Join(via, ",") != "sms,imessage" {
		t.Fatalf("routes %v", via)
	}
	b, _ := os.ReadFile(filepath.Join(filepath.Dir(p.Queue), "egress.jsonl"))
	if !strings.Contains(string(b), "sms-low-signal") {
		t.Errorf("egress should name the route: %s", b)
	}
}

func TestLowSignalInStatusAndReport(t *testing.T) {
	st := State{CheckedAt: time.Now(), Class: OK, Loc: "MY", Via: "wifi",
		Low: LowSignal{On: true, Level: 1}, Clock: ClockVerdict{Checked: true, Fault: true, SkewSecs: 600, Sources: 4, Agree: 1}}
	line := statusLine(st, time.Now())
	if !strings.Contains(line, "low-signal (64 KiB chunks)") || !strings.Contains(line, "time source disagreement") || !strings.Contains(line, "via:wifi") {
		t.Fatalf("status: %q", line)
	}
	r := map[string]any{}
	addLowAndLink(r, Config{}, st)
	ls := r["lowSignal"].(map[string]any)
	if ls["on"] != true || ls["chunkBytes"] != 64<<10 || r["clock"].(map[string]any)["fault"] != true {
		t.Fatalf("report fields: %+v", r)
	}
	if got := (LowSignal{}).ReportGap(); got != 0 {
		t.Fatal("normal mode reports every check")
	}
}
