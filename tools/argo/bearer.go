package main

// Bearers: ways a bundle can leave this device other than HTTPS to the hub
// (REQ-ARG-042..045). A bearer has an MTU, a legal duty cycle and a cost, so
// the scheduler (BearerRadio) fragments each bundle to the MTU and sends only what
// fits the budget: alerts, receipts and small status, never bulk files. Store
// and forward already gives custody and receipts, so a bearer only has to move
// bytes. Everything that leaves on a bearer is a BPSec-protected bundle
// (radioOK); nothing is ever sent in clear.
//
// Fading and scintillation are fought at the bundle layer, not the modem
// (the modem's own modulation, e.g. LoRa chirp spread spectrum, is outside
// Argo): one XOR parity fragment per group of data fragments (the simplest
// erasure code, RFC 5109 for RTP uses the same idea), groups interleaved so a
// burst of consecutive lost frames costs each group at most one fragment.
//
// Path diversity: alerts and receipts go out on every bearer at once; the
// receiver deduplicates by bundle id, so a second copy is harmless.

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"math"
	"sort"
	"time"
)

// Bearer is one non-HTTPS path.
type Bearer interface {
	Name() string
	MTU() int                             // largest frame in bytes
	Airtime(frameBytes int) time.Duration // time on air for one frame
	Duty() float64                        // permitted share of time on air, 0-1
	Cost() int                            // 0 = free; higher is dearer (orders status traffic)
	Send(ctx context.Context, frame []byte) error
	Recv(ctx context.Context) ([][]byte, error)
}

// Radio priorities. Anything else is bulk and is refused.
const (
	RadioAlert  = 0 // alerts and receipts: every bearer at once
	RadioStatus = 1 // small status: the cheapest bearer with budget
)

const (
	frameVer        = 1
	hdrLen          = 10 // ver|kind, id(4), idx, n, groups, total(2)
	maxFragments    = 32
	maxFramePayload = 400 // the largest frame of any bearer described here (Iridium SBD, 340 bytes)
	radioQueue      = 64
	radioResend     = 30 * time.Minute
	reasmTTL        = 30 * time.Minute
	maxPartials     = 16
	maxDone         = 256
)

var (
	errNotForRadio = errors.New("only alerts, receipts and small status go over a radio bearer")
	errTooBig      = errors.New("bundle is too big for this bearer")
	errNotProtect  = errors.New("bundle is not BPSec-protected; it will not leave on a radio")
)

// frame is one on-air unit. Data frames carry bundle bytes; a parity frame
// carries the XOR of the data fragments of one group (padded to equal length).
type frame struct {
	Parity  bool
	ID      [4]byte
	Idx     int // data: fragment number; parity: group number
	N       int // data fragments in the bundle
	G       int // parity groups (0 = no parity); fragment i is in group i % G
	Total   int // bundle length in bytes
	Payload []byte
}

func (f frame) marshal() []byte {
	b := make([]byte, 0, hdrLen+len(f.Payload))
	kind := byte(0)
	if f.Parity {
		kind = 1
	}
	b = append(b, frameVer<<4|kind)
	b = append(b, f.ID[:]...)
	b = append(b, byte(f.Idx), byte(f.N), byte(f.G), byte(f.Total>>8), byte(f.Total))
	return append(b, f.Payload...)
}

func parseFrame(b []byte) (frame, bool) {
	if len(b) <= hdrLen || b[0]>>4 != frameVer || b[0]&0x0f > 1 {
		return frame{}, false
	}
	f := frame{Parity: b[0]&1 == 1, Idx: int(b[5]), N: int(b[6]), G: int(b[7]), Total: int(b[8])<<8 | int(b[9]), Payload: b[hdrLen:]}
	copy(f.ID[:], b[1:5])
	switch {
	case f.N < 1 || f.N > maxFragments || f.G > f.N || f.Total < 1 || f.Total > f.N*maxFramePayload || len(f.Payload) > maxFramePayload:
		return frame{}, false
	case f.Parity && (f.G == 0 || f.Idx >= f.G):
		return frame{}, false
	case !f.Parity && f.Idx >= f.N:
		return frame{}, false
	}
	return f, true
}

// parityGroups picks how many parity groups a bundle of n fragments gets for a
// measured loss share: none on a clean link, one parity per 8, 4 or 2 data
// fragments as loss grows. The cost is airtime, so it stays off when not needed.
func parityGroups(n int, loss float64) int {
	per := 0
	switch {
	case loss < 0.01:
		return 0
	case loss < 0.05:
		per = 8
	case loss < 0.15:
		per = 4
	default:
		per = 2
	}
	return min(n, (n+per-1)/per)
}

// fragment splits a bundle into data frames and parity frames, in send order
// (data first, so a bundle that arrives whole never waits for parity).
func fragment(bundle []byte, mtu int, loss float64) ([]frame, error) {
	per := mtu - hdrLen
	if per < 16 || len(bundle) == 0 {
		return nil, errTooBig
	}
	n := (len(bundle) + per - 1) / per
	if n > maxFragments || len(bundle) > 0xffff {
		return nil, errTooBig
	}
	sum := sha256.Sum256(bundle)
	var id [4]byte
	copy(id[:], sum[:4])
	g := parityGroups(n, loss)
	out := make([]frame, 0, n+g)
	for i := range n {
		end := min((i+1)*per, len(bundle))
		out = append(out, frame{ID: id, Idx: i, N: n, G: g, Total: len(bundle), Payload: bundle[i*per : end]})
	}
	for k := range g {
		p := make([]byte, per)
		for i := k; i < n; i += g {
			for j, v := range out[i].Payload {
				p[j] ^= v
			}
		}
		out = append(out, frame{Parity: true, ID: id, Idx: k, N: n, G: g, Total: len(bundle), Payload: p})
	}
	return out, nil
}

type asm struct {
	n, g, total int
	data        map[int][]byte
	parity      map[int][]byte
	at          time.Time
}

// Reassembler rebuilds bundles from frames in any order, from any bearer,
// recovers one lost fragment per group from parity, checks the id (the first
// 4 bytes of the bundle's SHA-256) and returns each bundle once.
type Reassembler struct {
	Now     func() time.Time
	partial map[[4]byte]*asm
	done    map[[4]byte]time.Time
}

func (r *Reassembler) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Add takes one frame and returns a bundle when it completes one for the first time.
func (r *Reassembler) Add(raw []byte) ([]byte, bool) {
	f, ok := parseFrame(raw)
	if !ok {
		return nil, false
	}
	now := r.now()
	if r.partial == nil {
		r.partial, r.done = map[[4]byte]*asm{}, map[[4]byte]time.Time{}
	}
	for id, a := range r.partial {
		if now.Sub(a.at) > reasmTTL {
			delete(r.partial, id)
		}
	}
	for id, t := range r.done {
		if now.After(t) {
			delete(r.done, id)
		}
	}
	if _, dup := r.done[f.ID]; dup {
		return nil, false // a copy from another bearer, or a repeat
	}
	a := r.partial[f.ID]
	if a == nil {
		if len(r.partial) >= maxPartials {
			var oldest [4]byte
			var ot time.Time
			for id, p := range r.partial {
				if ot.IsZero() || p.at.Before(ot) {
					oldest, ot = id, p.at
				}
			}
			delete(r.partial, oldest)
		}
		a = &asm{n: f.N, g: f.G, total: f.Total, data: map[int][]byte{}, parity: map[int][]byte{}, at: now}
		r.partial[f.ID] = a
	}
	if a.n != f.N || a.g != f.G || a.total != f.Total {
		return nil, false // does not belong with the frames already held
	}
	if f.Parity {
		a.parity[f.Idx] = append([]byte(nil), f.Payload...)
	} else {
		a.data[f.Idx] = append([]byte(nil), f.Payload...)
	}
	a.recover()
	if len(a.data) < a.n {
		return nil, false
	}
	var buf bytes.Buffer
	for i := range a.n {
		buf.Write(a.data[i])
	}
	b := buf.Bytes()
	if len(b) < a.total {
		delete(r.partial, f.ID)
		return nil, false
	}
	b = b[:a.total]
	sum := sha256.Sum256(b)
	delete(r.partial, f.ID)
	if !bytes.Equal(sum[:4], f.ID[:]) {
		return nil, false // corrupted or mixed up: drop it all
	}
	if len(r.done) >= maxDone {
		r.done = map[[4]byte]time.Time{}
	}
	r.done[f.ID] = now.Add(time.Hour)
	return b, true
}

// recover rebuilds a group's single missing data fragment from its parity.
func (a *asm) recover() {
	if a.g == 0 {
		return
	}
	for k := range a.g {
		p, ok := a.parity[k]
		if !ok {
			continue
		}
		missing := -1
		for i := k; i < a.n; i += a.g {
			if _, have := a.data[i]; !have {
				if missing >= 0 {
					missing = -2
					break
				}
				missing = i
			}
		}
		if missing < 0 {
			continue
		}
		x := append([]byte(nil), p...)
		for i := k; i < a.n; i += a.g {
			if i == missing {
				continue
			}
			for j, v := range a.data[i] {
				x[j] ^= v
			}
		}
		per := len(p)
		if missing < a.n-1 {
			a.data[missing] = x
		} else { // the last fragment is shorter
			a.data[missing] = x[:max(a.total-(a.n-1)*per, 0)]
		}
	}
}

// ---- duty cycle ----

type spend struct {
	At  time.Time     `json:"at"`
	Air time.Duration `json:"air"`
}

// DutyBudget keeps time on air within a share of a sliding window (default
// one hour), the way regional rules count it.
type DutyBudget struct {
	Fraction float64
	Window   time.Duration
	log      []spend
}

func (d *DutyBudget) used(now time.Time) time.Duration {
	w := d.Window
	if w <= 0 {
		w = time.Hour
	}
	var sum time.Duration
	keep := d.log[:0]
	for _, s := range d.log {
		if now.Sub(s.At) < w {
			sum += s.Air
			keep = append(keep, s)
		}
	}
	d.log = keep
	return sum
}

// Allow says whether another transmission of this length fits the budget now.
func (d *DutyBudget) Allow(air time.Duration, now time.Time) bool {
	w := d.Window
	if w <= 0 {
		w = time.Hour
	}
	return d.used(now)+air <= time.Duration(d.Fraction*float64(w))
}

// Spend records a transmission.
func (d *DutyBudget) Spend(air time.Duration, now time.Time) {
	d.log = append(d.log, spend{now, air})
	if len(d.log) > 4096 {
		d.log = d.log[len(d.log)-4096:]
	}
}

// loraAirtime is the time on air of one LoRa packet (Semtech AN1200.13):
// explicit header, CRC on, coding rate 4/(4+cr), cr = 1..4.
func loraAirtime(payload, sf int, bwHz float64, cr, preamble int) time.Duration {
	tsym := math.Pow(2, float64(sf)) / bwHz
	de := 0.0
	if tsym > 0.016 {
		de = 1
	}
	num := float64(8*payload - 4*sf + 28 + 16)
	den := 4 * (float64(sf) - 2*de)
	syms := 8 + math.Max(math.Ceil(num/den)*float64(cr+4), 0)
	return time.Duration((float64(preamble) + 4.25 + syms) * tsym * float64(time.Second))
}

// ---- the scheduler ----

type progress struct {
	frames []frame
	next   int
}

type radioItem struct {
	loss    map[string]float64 // loss used to fragment for each bearer, so a restart rebuilds the same frames
	id      string
	prio    int
	raw     []byte
	expires time.Time
	per     map[string]*progress
	targets []string
}

// BearerRadio is the bearer scheduler (named apart from Radio, the Wi-Fi profile in radio.go): a bounded queue, per-bearer duty budgets and
// the receive side. Not safe for concurrent use; callers hold the relay lock.
type BearerRadio struct {
	Bearers []Bearer
	Now     func() time.Time
	Loss    func() float64 // measured link loss, for the parity ratio; nil = 0
	Rand    func() float64
	Reasm   Reassembler
	budgets map[string]*DutyBudget
	holds   map[string]time.Time
	fails   map[string]int
	queue   []*radioItem
}

func (r *BearerRadio) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *BearerRadio) init() {
	if r.budgets == nil {
		r.budgets, r.holds, r.fails = map[string]*DutyBudget{}, map[string]time.Time{}, map[string]int{}
	}
}

func (r *BearerRadio) budget(b Bearer) *DutyBudget {
	r.init()
	if d, ok := r.budgets[b.Name()]; ok {
		return d
	}
	d := &DutyBudget{Fraction: b.Duty(), Window: time.Hour}
	r.budgets[b.Name()] = d
	return d
}

// maxRadioBundle is the largest bundle any bearer could carry.
func (r *BearerRadio) maxBundle(b Bearer) int { return maxFragments * (b.MTU() - hdrLen) }

// radioOK says a bundle may leave on a radio: it must carry BPSec protection.
// Bundles with a payload to keep private need a confidentiality block; admin
// records (receipts, which carry no secrets) need at least an integrity block.
func radioOK(raw []byte) error {
	b, err := ParseBundle(raw)
	if err != nil {
		return err
	}
	var integ, conf bool
	for _, bl := range b.Blocks {
		switch bl.Type {
		case blockArgoSig, blockBIB:
			integ = true
		case blockArgoSeal, blockBCB:
			conf = true
		}
	}
	if b.Flags&flagAdminRecord != 0 {
		if !integ && !conf {
			return errNotProtect
		}
		return nil
	}
	if !conf {
		return errNotProtect
	}
	return nil
}

// Submit queues a bundle. Bulk (any other priority), unprotected or oversize
// bundles are refused. Resubmitting an id already queued is a no-op.
func (r *BearerRadio) Submit(id string, prio int, raw []byte, expires time.Time) error {
	if prio != RadioAlert && prio != RadioStatus {
		return errNotForRadio
	}
	if err := radioOK(raw); err != nil {
		return err
	}
	for _, q := range r.queue {
		if q.id == id {
			return nil
		}
	}
	if len(r.queue) >= radioQueue {
		return errors.New("radio queue is full")
	}
	fit := false
	for _, b := range r.Bearers {
		fit = fit || len(raw) <= r.maxBundle(b)
	}
	if !fit {
		return errTooBig
	}
	r.queue = append(r.queue, &radioItem{id: id, prio: prio, raw: raw, expires: expires, per: map[string]*progress{}})
	return nil
}

// Pending is how many bundles are waiting for budget or a bearer.
func (r *BearerRadio) Pending() int { return len(r.queue) }

func (r *BearerRadio) targetsFor(it *radioItem) []Bearer {
	var ok []Bearer
	for _, b := range r.Bearers {
		if len(it.raw) <= r.maxBundle(b) {
			ok = append(ok, b)
		}
	}
	if it.prio == RadioAlert {
		return ok // every bearer at once
	}
	sort.SliceStable(ok, func(i, j int) bool { return ok[i].Cost() < ok[j].Cost() })
	if len(ok) > 1 {
		ok = ok[:1]
	}
	return ok
}

// Pump sends what fits the budgets, alerts first, and returns frames sent.
// A failing bearer is held with jittered exponential back-off, never hammered.
func (r *BearerRadio) Pump(ctx context.Context) int {
	now := r.now()
	r.init()
	sort.SliceStable(r.queue, func(i, j int) bool { return r.queue[i].prio < r.queue[j].prio })
	sent := 0
	keep := r.queue[:0]
	for _, it := range r.queue {
		if now.After(it.expires) {
			continue
		}
		allDone := true
		targets := r.targetsFor(it)
		for _, b := range targets {
			if now.Before(r.holds[b.Name()]) {
				allDone = false // held after a failure; try again later
				continue
			}
			p := it.per[b.Name()]
			if p == nil {
				loss := 0.0
				if r.Loss != nil {
					loss = r.Loss()
				}
				fr, err := fragment(it.raw, b.MTU(), loss)
				if err != nil {
					continue
				}
				p = &progress{frames: fr}
				it.per[b.Name()] = p
				if it.loss == nil {
					it.loss = map[string]float64{}
				}
				it.loss[b.Name()] = loss
			}
			d := r.budget(b)
			for p.next < len(p.frames) {
				wire := p.frames[p.next].marshal()
				air := b.Airtime(len(wire))
				if !d.Allow(air, now) {
					break
				}
				if err := b.Send(ctx, wire); err != nil {
					r.fails[b.Name()]++
					rnd := 0.5
					if r.Rand != nil {
						rnd = r.Rand()
					}
					r.holds[b.Name()] = now.Add(jitterBackoff(r.fails[b.Name()], 30*time.Second, 30*time.Minute, rnd))
					break
				}
				r.fails[b.Name()] = 0
				d.Spend(air, now)
				p.next++
				sent++
			}
			if p.next < len(p.frames) {
				allDone = false
			}
		}
		if !allDone || len(targets) == 0 {
			keep = append(keep, it)
		}
	}
	r.queue = keep
	return sent
}

// Poll reads every bearer and returns the bundles completed this time.
func (r *BearerRadio) Poll(ctx context.Context) [][]byte {
	var out [][]byte
	for _, b := range r.Bearers {
		frames, err := b.Recv(ctx)
		if err != nil {
			continue
		}
		for _, f := range frames {
			if raw, ok := r.Reasm.Add(f); ok {
				out = append(out, raw)
			}
		}
	}
	return out
}
