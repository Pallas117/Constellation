package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"math"
	"os"
	"testing"
	"time"
)

// fakeBearer is one end of a fake radio link with loss, reordering and failure.
type fakeBearer struct {
	name    string
	mtu     int
	duty    float64
	cost    int
	peer    *fakeBearer
	inbox   [][]byte
	drop    func(n int) bool // n counts frames offered, from 1
	reorder bool
	fail    bool
	offered int
	calls   int
	sent    [][]byte
}

func pair(name string, mtu int, duty float64, cost int) (*fakeBearer, *fakeBearer) {
	a := &fakeBearer{name: name, mtu: mtu, duty: duty, cost: cost}
	b := &fakeBearer{name: name, mtu: mtu, duty: duty, cost: cost}
	a.peer, b.peer = b, a
	return a, b
}

func (f *fakeBearer) Name() string              { return f.name }
func (f *fakeBearer) MTU() int                  { return f.mtu }
func (f *fakeBearer) Airtime(int) time.Duration { return 100 * time.Millisecond }
func (f *fakeBearer) Duty() float64             { return f.duty }
func (f *fakeBearer) Cost() int                 { return f.cost }
func (f *fakeBearer) Send(_ context.Context, fr []byte) error {
	f.calls++
	if f.fail {
		return errors.New("modem busy")
	}
	f.offered++
	f.sent = append(f.sent, fr)
	if f.drop != nil && f.drop(f.offered) {
		return nil // lost on air
	}
	f.peer.inbox = append(f.peer.inbox, append([]byte(nil), fr...))
	return nil
}
func (f *fakeBearer) Recv(context.Context) ([][]byte, error) {
	out := f.inbox
	f.inbox = nil
	if f.reorder {
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	return out, nil
}

func randBytes(n int) []byte { b := make([]byte, n); _, _ = rand.Read(b); return b }

func feed(r *Reassembler, frames []frame, skip func(i int, f frame) bool) []byte {
	var got []byte
	for i, f := range frames {
		if skip != nil && skip(i, f) {
			continue
		}
		if b, ok := r.Add(f.marshal()); ok {
			got = b
		}
	}
	return got
}

func TestFragmentReassembleReorderAndLoss(t *testing.T) {
	bundle := randBytes(1000)
	fr, err := fragment(bundle, 100, 0.1) // 90 bytes per frame: 12 fragments, parity per 4
	if err != nil {
		t.Fatal(err)
	}
	n := fr[0].N
	if n != 12 || len(fr) != n+3 {
		t.Fatalf("%d fragments, %d frames", n, len(fr))
	}
	for _, f := range fr {
		if len(f.marshal()) > 100 {
			t.Fatalf("frame over the MTU: %d", len(f.marshal()))
		}
	}
	// Reversed order, no loss.
	rev := append([]frame(nil), fr...)
	for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
		rev[i], rev[j] = rev[j], rev[i]
	}
	if got := feed(&Reassembler{}, rev, nil); !bytes.Equal(got, bundle) {
		t.Fatal("reordered frames did not rebuild the bundle")
	}
	// Every single data fragment can be lost, one at a time, including the short last one.
	for lost := range n {
		if got := feed(&Reassembler{}, fr, func(i int, f frame) bool { return i == lost }); !bytes.Equal(got, bundle) {
			t.Fatalf("losing fragment %d was not recovered", lost)
		}
	}
	// Two losses in one group cannot be recovered from one parity fragment.
	if got := feed(&Reassembler{}, fr, func(i int, f frame) bool { return i == 0 || i == 3 }); got != nil {
		t.Fatal("two lost fragments in a group are beyond a single parity")
	}
}

func TestFECSurvivesBurstLoss(t *testing.T) {
	bundle := randBytes(1000)
	fr, _ := fragment(bundle, 100, 0.1) // 12 data fragments in 3 interleaved groups (i % 3)
	g := fr[0].G
	if g != 3 {
		t.Fatalf("groups %d", g)
	}
	// A burst of up to G consecutive frames costs each group at most one fragment, wherever it starts.
	for start := 0; start+g <= 12; start++ {
		if got := feed(&Reassembler{}, fr, func(i int, f frame) bool { return i >= start && i < start+g }); !bytes.Equal(got, bundle) {
			t.Fatalf("burst of %d at %d not recovered", g, start)
		}
	}
	// A longer burst takes two fragments from one group: honest limit.
	if got := feed(&Reassembler{}, fr, func(i int, f frame) bool { return i >= 2 && i < 2+g+1 }); got != nil {
		t.Fatal("a burst longer than the group count should not be recoverable")
	}
}

func TestFECAdaptsToLoss(t *testing.T) {
	bundle := randBytes(1000)
	count := func(loss float64) int { fr, _ := fragment(bundle, 100, loss); return len(fr) }
	clean, mild, bad, awful := count(0), count(0.03), count(0.1), count(0.3)
	if clean != 12 || !(clean < mild && mild < bad && bad < awful) {
		t.Fatalf("frames at loss 0/3/10/30%%: %d %d %d %d", clean, mild, bad, awful)
	}
	if parityGroups(1, 0.5) != 1 || parityGroups(5, 0) != 0 {
		t.Fatal("parity groups")
	}
}

func TestFragmentLimits(t *testing.T) {
	if _, err := fragment(randBytes(100*maxFragments), 100, 0); !errors.Is(err, errTooBig) {
		t.Fatal("bundles beyond the fragment cap are refused")
	}
	if _, err := fragment(nil, 100, 0); err == nil {
		t.Fatal("empty bundle")
	}
	if _, ok := parseFrame([]byte{0x10, 1, 2, 3}); ok {
		t.Fatal("short frame accepted")
	}
	fr, _ := fragment(randBytes(300), 100, 0)
	bad := fr[0].marshal()
	bad[0] = 0x20 // wrong version
	if _, ok := parseFrame(bad); ok {
		t.Fatal("wrong version accepted")
	}
	bad = fr[0].marshal()
	bad[5] = 200 // index out of range
	if _, ok := parseFrame(bad); ok {
		t.Fatal("index beyond the fragment count accepted")
	}
}

func TestReassemblerDedupAcrossBearersAndCorruption(t *testing.T) {
	bundle := randBytes(500)
	fr, _ := fragment(bundle, 100, 0.05)
	var r Reassembler
	done := 0
	for pass := 0; pass < 2; pass++ { // the same frames arrive over two bearers
		for _, f := range fr {
			if b, ok := r.Add(f.marshal()); ok {
				done++
				if !bytes.Equal(b, bundle) {
					t.Fatal("wrong bundle")
				}
			}
		}
	}
	if done != 1 {
		t.Fatalf("delivered %d times; the receiver must deduplicate by bundle id", done)
	}
	// A flipped byte fails the id check and is dropped, never delivered.
	var r2 Reassembler
	var got []byte
	for i, f := range fr {
		w := f.marshal()
		if i == 1 {
			w[len(w)-1] ^= 0xff
		}
		if b, ok := r2.Add(w); ok {
			got = b
		}
	}
	if got != nil {
		t.Fatal("a corrupted bundle was delivered")
	}
}

func TestReassemblerBoundedAndExpires(t *testing.T) {
	now := lsT0
	r := &Reassembler{Now: func() time.Time { return now }}
	for range maxPartials + 10 {
		fr, _ := fragment(randBytes(300), 100, 0)
		r.Add(fr[0].marshal())
	}
	if len(r.partial) > maxPartials {
		t.Fatalf("%d partials held", len(r.partial))
	}
	now = now.Add(reasmTTL + time.Minute)
	fr, _ := fragment(randBytes(300), 100, 0)
	r.Add(fr[0].marshal())
	if len(r.partial) != 1 {
		t.Fatalf("old partials should expire: %d", len(r.partial))
	}
}

func TestLoraAirtimeAndDutyBudget(t *testing.T) {
	// Semtech AN1200.13 worked by hand: SF7, 125 kHz, CR 4/5, 8-symbol preamble, 20 bytes = 56.576 ms.
	if got := loraAirtime(20, 7, 125000, 1, 8); math.Abs(got.Seconds()*1000-56.576) > 0.01 {
		t.Fatalf("airtime %v", got)
	}
	m := &Meshtastic{SF: 11, BW: 250000, CR: 1, Preamble: 16, DutyFraction: 0.01}
	air := m.Airtime(200)
	if air < time.Second || air > 3*time.Second {
		t.Fatalf("LongFast frame of 200 bytes should take 1-3 s on air, got %v", air)
	}
	d := &DutyBudget{Fraction: 0.01, Window: time.Hour}
	now := lsT0
	n := 0
	for d.Allow(air, now) {
		d.Spend(air, now)
		n++
	}
	if time.Duration(n)*air > 36*time.Second || time.Duration(n+1)*air <= 36*time.Second {
		t.Fatalf("1%% of an hour is 36 s: %d frames of %v", n, air)
	}
	if d.Allow(air, now.Add(30*time.Minute)) {
		t.Fatal("the budget is a sliding window, not a reset")
	}
	if !d.Allow(air, now.Add(time.Hour+time.Second)) {
		t.Fatal("the budget returns after the window")
	}
}

// sealedChunk makes a real BPSec-protected bundle (a file chunk, HPKE sealed).
func sealedChunk(t *testing.T, size int) (n1, n2 *testNode, raw []byte, key string) {
	t.Helper()
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	if _, _, err := a.Send(ctx, "ground-1", writeTemp(t, "s.bin", randBytes(size)), 0); err != nil {
		t.Fatal(err)
	}
	key = a.onlyOutKey(t)
	raw, err := os.ReadFile(a.outPath(key))
	if err != nil {
		t.Fatal(err)
	}
	return a, b, raw, key
}

func TestRadioRefusesBulkOversizeAndUnprotected(t *testing.T) {
	a, _, raw, _ := sealedChunk(t, 10)
	fa, _ := pair("lora", 200, 0.01, 1)
	r := &BearerRadio{Bearers: []Bearer{fa}, Now: func() time.Time { return lsT0 }}
	if err := r.Submit("x", 2, raw, lsT0.Add(time.Hour)); !errors.Is(err, errNotForRadio) {
		t.Fatalf("bulk priority: %v", err)
	}
	if err := r.Submit("x", RadioStatus, raw, lsT0.Add(time.Hour)); err != nil {
		t.Fatalf("a small sealed bundle should be accepted: %v", err)
	}
	if err := r.Submit("big", RadioStatus, make([]byte, 100*maxFragments), lsT0.Add(time.Hour)); err == nil {
		t.Fatal("oversize bundle accepted")
	}
	// Signed but not sealed, not a receipt: readable payload must never go on air.
	st := a.load()
	it, plain, err := a.newBundle(st, "ground-1", "argo", []byte("alert: battery 5%"), time.Hour, lsT0, nil, false, false)
	if err != nil || it == nil {
		t.Fatal(err)
	}
	if err := r.Submit("plain", RadioAlert, plain, lsT0.Add(time.Hour)); !errors.Is(err, errNotProtect) {
		t.Fatalf("an unsealed payload must be refused: %v", err)
	}
	if err := r.Submit("junk", RadioAlert, []byte("not a bundle"), lsT0.Add(time.Hour)); err == nil {
		t.Fatal("garbage accepted")
	}
}

func TestRadioPriorityAndPathDiversity(t *testing.T) {
	_, _, raw, _ := sealedChunk(t, 10)
	lora, loraPeer := pair("lora", 200, 0.05, 1)
	sat, satPeer := pair("sbd", 340, 0.05, 5)
	r := &BearerRadio{Bearers: []Bearer{sat, lora}, Now: func() time.Time { return lsT0 }}
	exp := lsT0.Add(time.Hour)
	_ = r.Submit("status", RadioStatus, raw, exp)
	_ = r.Submit("alert", RadioAlert, raw[:len(raw):len(raw)], exp)
	r.Pump(ctx)
	if len(lora.sent) == 0 || len(sat.sent) == 0 {
		t.Fatalf("an alert goes on every bearer: lora %d, sbd %d", len(lora.sent), len(sat.sent))
	}
	var rl, rs Reassembler
	var gotL, gotS int
	for _, f := range loraPeer.inbox {
		if b, ok := rl.Add(f); ok && bytes.Equal(b, raw) {
			gotL++
		}
	}
	for _, f := range satPeer.inbox {
		if b, ok := rs.Add(f); ok && bytes.Equal(b, raw) {
			gotS++
		}
	}
	if gotL != 1 || gotS != 1 {
		t.Fatalf("lora delivered %d, sbd delivered %d", gotL, gotS)
	}
	// The same alert arrives by both bearers at one receiver: still one delivery.
	rr := &BearerRadio{Bearers: []Bearer{loraPeer, satPeer}}
	loraPeer.inbox, satPeer.inbox = nil, nil
	for _, f := range lora.sent {
		loraPeer.inbox = append(loraPeer.inbox, f)
	}
	for _, f := range sat.sent {
		satPeer.inbox = append(satPeer.inbox, f)
	}
	if got := rr.Poll(ctx); len(got) != 1 || !bytes.Equal(got[0], raw) {
		t.Fatalf("receiver should deduplicate by bundle id, got %d bundles", len(got))
	}
	// A status bundle alone uses only the cheapest bearer.
	lora2, _ := pair("lora", 200, 0.05, 1)
	sat2, _ := pair("sbd", 340, 0.05, 5)
	r2 := &BearerRadio{Bearers: []Bearer{sat2, lora2}, Now: func() time.Time { return lsT0 }}
	_ = r2.Submit("status", RadioStatus, raw, exp)
	r2.Pump(ctx)
	if len(lora2.sent) == 0 || len(sat2.sent) != 0 {
		t.Fatalf("status should use the cheapest bearer only: lora %d, sbd %d", len(lora2.sent), len(sat2.sent))
	}
}

func TestRadioPumpRespectsDutyBudgetAndAlertsFirst(t *testing.T) {
	now := lsT0
	lora, peer := pair("lora", 200, 0.0005, 1) // 0.05% of an hour = 1.8 s = 18 frames of 100 ms
	r := &BearerRadio{Bearers: []Bearer{lora}, Now: func() time.Time { return now }}
	exp := now.Add(48 * time.Hour)
	// Several different bundles: one status and four alerts; alerts must leave first.
	_, _, statusRaw, _ := sealedChunk(t, 10)
	_ = r.Submit("status", RadioStatus, statusRaw, exp)
	for i := 2; i < 6; i++ {
		_, _, alertRaw, _ := sealedChunk(t, 10+i)
		if err := r.Submit("alert"+string(rune('a'+i)), RadioAlert, alertRaw, exp); err != nil {
			t.Fatal(err)
		}
	}
	sent := r.Pump(ctx)
	if sent == 0 || sent > 18 {
		t.Fatalf("budget of 18 frames, sent %d", sent)
	}
	if r.Pending() == 0 {
		t.Fatal("what does not fit the budget must wait")
	}
	if r.queue[0].id == "status" && len(r.queue) > 1 {
		t.Fatal("the status bundle must not outrank alerts")
	}
	now = now.Add(2 * time.Hour)
	for k := 0; k < 8 && r.Pending() > 0; k++ {
		r.Pump(ctx)
		now = now.Add(2 * time.Hour)
	}
	if r.Pending() != 0 {
		t.Fatalf("everything should leave over time, %d waiting", r.Pending())
	}
	if len(peer.sent) != 0 {
		t.Fatal("frames only leave through the sender")
	}
}

func TestRadioHoldsFailingBearerWithBackoff(t *testing.T) {
	_, _, raw, _ := sealedChunk(t, 10)
	now := lsT0
	lora, _ := pair("lora", 200, 0.05, 1)
	lora.fail = true
	r := &BearerRadio{Bearers: []Bearer{lora}, Now: func() time.Time { return now }, Rand: func() float64 { return 0.5 }}
	_ = r.Submit("a", RadioAlert, raw, now.Add(time.Hour))
	r.Pump(ctx)
	r.Pump(ctx)
	r.Pump(ctx)
	if lora.calls != 1 {
		t.Fatalf("a failing modem must not be hammered: %d calls", lora.calls)
	}
	lora.fail = false
	now = now.Add(2 * time.Minute)
	if r.Pump(ctx) == 0 || r.Pending() != 0 {
		t.Fatal("after the hold the bundle should go")
	}
}

func TestRelaySendsReceiptOverRadioWhenHubIsDown(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	if _, _, err := a.Send(ctx, "ground-1", writeTemp(t, "plan.txt", []byte("AOS 09:41")), 0); err != nil {
		t.Fatal(err)
	}
	key := a.onlyOutKey(t)
	a.Sync(ctx)
	b.Sync(ctx) // b has the file and owes a receipt
	// The hub is gone for b and a; the radio link loses a frame.
	la, lb := pair("lora", 200, 0.01, 1)
	lb.drop = func(n int) bool { return n == 1 }
	a.Hub, b.Hub = nil, nil
	a.Radio = &BearerRadio{Bearers: []Bearer{la}, Loss: func() float64 { return 0.1 }}
	b.Radio = &BearerRadio{Bearers: []Bearer{lb}, Loss: func() float64 { return 0.1 }}
	b.Sync(ctx) // sends the receipt over the radio
	if len(lb.sent) == 0 {
		t.Fatal("the receipt should have gone over the radio")
	}
	if r := a.Sync(ctx); r.Delivered != 1 || a.state(key) != stateDelivered {
		t.Fatalf("receipt over radio: %+v %s", r, a.state(key))
	}
	// The next sync must not resend: radio state persists, the item is marked.
	before := lb.offered
	b.Sync(ctx)
	if lb.offered != before {
		t.Fatal("the same receipt was sent again immediately")
	}
}
