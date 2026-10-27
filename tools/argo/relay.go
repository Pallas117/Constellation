package main

// Store-and-forward delivery between enrolled devices (delay-tolerant
// networking). Files are split into 1 MiB chunks; each chunk is one BPv7
// bundle, signed and sealed to the destination (bpsec.go), written to disk,
// and forwarded when a path exists: the Gauss hub over the tailnet (hub.go)
// or a folder someone carries (`argo mule`). Nothing is lost while offline,
// asleep or restarted, because every step is persisted before it is acked.
//
// Reliability is end to end, not hop by hop: BPv7 has no custody transfer,
// so a sender keeps each bundle until a signed "delivered" status report
// comes back, re-uploads it if the hub loses it, and gives up only when the
// bundle's lifetime ends. Receivers drop duplicates by bundle ID and answer
// a duplicate with a fresh receipt, so a lost receipt never strands a sender.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

const (
	chunkSize      = 1 << 20
	maxSendBytes   = 256 << 20
	defaultTTL     = 7 * 24 * time.Hour
	maxTTL         = 30 * 24 * time.Hour
	clockSkew      = 10 * time.Minute
	statusEvery    = 10 * time.Minute
	retryBase      = 30 * time.Second
	retryMax       = 15 * time.Minute
	maxPartial     = 64
	fetchPerSync   = 64
	keepDoneFor    = 48 * time.Hour // finished items stay visible in `argo outbox` this long
	serviceFiles   = "files"
	serviceArgo    = "argo"
	stateQueued    = "queued"    // waiting for a path
	stateAtHub     = "at-hub"    // the hub holds it
	statePickedUp  = "picked-up" // the destination took it from the hub
	stateDelivered = "delivered" // signed receipt from the destination
	stateExpired   = "expired"   // lifetime ended without a receipt
	stateRefused   = "refused"   // the hub refused it for good (size, unknown device)
)

var deviceRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`) // same as Gauss (backend/mesh/store.ts)

// Hub is the store-and-forward mailbox (the Gauss backend). It holds
// ciphertext only and authenticates devices by their Gauss token.
type Hub interface {
	Put(ctx context.Context, raw []byte) error
	List(ctx context.Context) ([]hubItem, error)
	Get(ctx context.Context, key string) ([]byte, error)
	Ack(ctx context.Context, key string) error
	Status(ctx context.Context, keys []string) (map[string]string, error)
	Directory(ctx context.Context) ([]PeerKey, error)
	Publish(ctx context.Context, k PeerKey) error
}

type hubItem struct {
	Key  string `json:"id"`
	From string `json:"from"`
	Size int    `json:"size"`
}

var (
	errHubRefused  = errors.New("hub refused the bundle")
	errHubConflict = errors.New("hub already has a different key for this device")
)

type outItem struct {
	Key       string    `json:"key"`
	Dest      string    `json:"dest"`
	Name      string    `json:"name,omitempty"`
	Transfer  string    `json:"transfer,omitempty"`
	Chunk     int       `json:"chunk,omitempty"`
	Chunks    int       `json:"chunks,omitempty"`
	Receipt   bool      `json:"receipt,omitempty"` // a status report we owe someone
	Subject   string    `json:"subject,omitempty"` // for a receipt: the key of the bundle it confirms
	State     string    `json:"state"`
	Created   time.Time `json:"created"`
	Expires   time.Time `json:"expires"`
	Attempts  int       `json:"attempts,omitempty"`
	NextTry   time.Time `json:"next_try,omitempty"`
	CheckedAt time.Time `json:"checked_at,omitempty"`
	Uploads   int       `json:"uploads,omitempty"`
	Done      time.Time `json:"done,omitempty"`
}

type inTransfer struct {
	From    string    `json:"from"`
	Name    string    `json:"name"`
	Size    uint64    `json:"size"`
	Sum     []byte    `json:"sum"`
	Count   int       `json:"count"`
	Have    []int     `json:"have"`
	Expires time.Time `json:"expires"`
}

type received struct {
	From string    `json:"from"`
	Name string    `json:"name"`
	Path string    `json:"path"`
	Size uint64    `json:"size"`
	At   time.Time `json:"at"`
}

// pathHealth is Babel-style (RFC 8966): a path is up when at least 2 of the
// last 3 attempts worked. Since changes only when that verdict flips, so a
// steady path leaves the state file untouched.
type pathHealth struct {
	Last  []bool    `json:"last,omitempty"`
	Since time.Time `json:"since,omitempty"`
}

func (h *pathHealth) record(ok bool, now time.Time) {
	was, fresh := h.Up(), len(h.Last) == 0
	h.Last = append(h.Last, ok)
	if len(h.Last) > 3 {
		h.Last = h.Last[len(h.Last)-3:]
	}
	if fresh || h.Up() != was {
		h.Since = now
	}
}

func (h pathHealth) Up() bool {
	n := 0
	for _, ok := range h.Last {
		if ok {
			n++
		}
	}
	return n >= 2 || (len(h.Last) == 1 && h.Last[0])
}

type relayState struct {
	Seq       uint64                 `json:"seq"`
	Out       map[string]*outItem    `json:"out"`
	Seen      map[string]time.Time   `json:"seen"` // bundle key → when we may forget it
	Pins      map[string]PeerKey     `json:"pins"` // device → key trusted on first use
	Partial   map[string]*inTransfer `json:"partial"`
	Received  []received             `json:"received,omitempty"`
	Published bool                   `json:"published,omitempty"`
	Hub       pathHealth             `json:"hub"`
	DirAt     time.Time              `json:"dir_at,omitempty"`
	raw       []byte                 // as loaded, so an unchanged state isn't rewritten every tick
}

// Relay is one device's bundle agent. Callers hold the Argo store lock.
type Relay struct {
	Dir      string // ~/.local/state/argo/dtn
	Keys     NodeKeys
	Hub      Hub // nil: no hub path (mule only)
	InboxDir string
	Now      func() time.Time
	Notify   func(title, msg string)
	// NoResendReceipt turns off answering duplicates with a fresh receipt
	// (only for the simulation that shows why it is needed).
	NoResendReceipt bool
	// NoHubRecheck turns off re-uploading bundles the hub lost (simulation only).
	NoHubRecheck bool
}

func (r *Relay) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *Relay) notify(title, msg string) {
	if r.Notify != nil {
		r.Notify(title, msg)
	}
}

func (r *Relay) me() EID { return nodeEID(r.Keys.Name) }

func (r *Relay) load() *relayState {
	st := &relayState{}
	if b, err := os.ReadFile(filepath.Join(r.Dir, "relay.json")); err == nil {
		_ = json.Unmarshal(b, st)
		st.raw = b
	}
	if st.Out == nil {
		st.Out = map[string]*outItem{}
	}
	if st.Seen == nil {
		st.Seen = map[string]time.Time{}
	}
	if st.Pins == nil {
		st.Pins = map[string]PeerKey{}
	}
	if st.Partial == nil {
		st.Partial = map[string]*inTransfer{}
	}
	return st
}

func (r *Relay) save(st *relayState) error {
	b := mustJSON(st)
	if bytes.Equal(b, st.raw) {
		return nil // an idle tick changes nothing: no write, no fsync
	}
	if err := writeFileAtomic(filepath.Join(r.Dir, "relay.json"), b); err != nil {
		return err
	}
	st.raw = b
	return nil
}

func mustJSON(v any) []byte { b, _ := json.MarshalIndent(v, "", "  "); return b }

// fsyncWrites is on everywhere except the simulation, where thousands of
// full syncs (F_FULLFSYNC on macOS) would only measure the disk.
var fsyncWrites = true

// writeFileAtomic writes a 0600 file via rename, so a crash leaves the old
// or the new file, never half of one.
func writeFileAtomic(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if fsyncWrites {
		if err := f.Sync(); err != nil {
			f.Close()
			return err
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (r *Relay) outPath(key string) string { return filepath.Join(r.Dir, "out", key+".bundle") }

// ---- application data unit (the plaintext inside a sealed payload) ----

type adu struct {
	Name     string
	Size     uint64
	Sum      []byte
	Transfer []byte
	Index    int
	Count    int
	Data     []byte
}

func (a adu) encode() []byte {
	var e cborEnc
	e.array(9)
	e.uint(1)
	e.text("file")
	e.text(a.Name)
	e.uint(a.Size)
	e.bytes(a.Sum)
	e.bytes(a.Transfer)
	e.uint(uint64(a.Index))
	e.uint(uint64(a.Count))
	e.bytes(a.Data)
	return e.b
}

func decodeADU(p []byte) (adu, error) {
	var a adu
	bad := errors.New("payload: not an Argo file chunk")
	d := cborDec{b: p}
	if n, err := d.array(); err != nil || n != 9 {
		return a, bad
	}
	if v, err := d.uint(); err != nil || v != 1 {
		return a, bad
	}
	if k, err := d.text(); err != nil || k != "file" {
		return a, bad
	}
	var err error
	if a.Name, err = d.text(); err != nil {
		return a, bad
	}
	if a.Size, err = d.uint(); err != nil || a.Size > maxSendBytes {
		return a, bad
	}
	if a.Sum, err = d.bytes(); err != nil || len(a.Sum) != sha256.Size {
		return a, bad
	}
	if a.Transfer, err = d.bytes(); err != nil || len(a.Transfer) != 16 {
		return a, bad
	}
	idx, err1 := d.uint()
	cnt, err2 := d.uint()
	if err1 != nil || err2 != nil || cnt == 0 || cnt > maxSendBytes/chunkSize+1 || idx >= cnt {
		return a, bad
	}
	a.Index, a.Count = int(idx), int(cnt)
	if a.Data, err = d.bytes(); err != nil || len(a.Data) > chunkSize || !d.done() {
		return a, bad
	}
	return a, nil
}

// safeName keeps only a plain file name: no directories, no leading dots,
// no control characters, at most 128 bytes.
func safeName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(func(c rune) rune {
		if unicode.IsControl(c) || c == '/' || c == ':' {
			return '_'
		}
		return c
	}, name)
	name = strings.TrimLeft(name, ". ")
	for len(name) > 128 {
		name = name[:len(name)-1]
	}
	if name == "" {
		return "file"
	}
	return name
}

// ---- sending ----

func (r *Relay) peerKey(ctx context.Context, st *relayState, device string) (PeerKey, error) {
	if k, ok := st.Pins[device]; ok {
		return k, nil
	}
	r.refreshDirectory(ctx, st, true)
	if k, ok := st.Pins[device]; ok {
		return k, nil
	}
	return PeerKey{}, fmt.Errorf("%s has no published keys yet (it needs Argo with `argo keys publish`, or one sync)", device)
}

// Send queues a file for a device. Each chunk becomes one signed, sealed
// bundle on disk before Send returns; Sync forwards them.
func (r *Relay) Send(ctx context.Context, device, path string, ttl time.Duration) (string, int, error) {
	if !deviceRE.MatchString(device) {
		return "", 0, errors.New("device names are lowercase letters, digits and dashes")
	}
	if device == r.Keys.Name {
		return "", 0, errors.New("that is this device")
	}
	if ttl <= 0 {
		ttl = defaultTTL
	}
	if ttl > maxTTL {
		ttl = maxTTL
	}
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return "", 0, err
	}
	if !info.Mode().IsRegular() {
		return "", 0, errors.New("only regular files can be sent")
	}
	if info.Size() > maxSendBytes {
		return "", 0, fmt.Errorf("file is %d MB; the limit is %d MB", info.Size()>>20, maxSendBytes>>20)
	}
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", 0, err
	}
	sum := h.Sum(nil)
	st := r.load()
	to, err := r.peerKey(ctx, st, device)
	if err != nil {
		return "", 0, err
	}
	transfer := make([]byte, 16)
	if _, err := rand.Read(transfer); err != nil {
		return "", 0, err
	}
	size := uint64(info.Size())
	count := int((size + chunkSize - 1) / chunkSize)
	if count == 0 {
		count = 1 // an empty file is still one bundle
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", 0, err
	}
	now := r.now()
	name := safeName(filepath.Base(path))
	buf := make([]byte, chunkSize)
	for i := range count {
		n, err := io.ReadFull(f, buf)
		if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
			return "", 0, err
		}
		payload := adu{Name: name, Size: size, Sum: sum, Transfer: transfer, Index: i, Count: count, Data: buf[:n]}.encode()
		item, raw, err := r.newBundle(st, device, serviceFiles, payload, ttl, now, &to, false)
		if err != nil {
			return "", 0, err
		}
		item.Name, item.Transfer, item.Chunk, item.Chunks = name, hex.EncodeToString(transfer), i, count
		if err := writeFileAtomic(r.outPath(item.Key), raw); err != nil {
			return "", 0, err
		}
		st.Out[item.Key] = item
	}
	return hex.EncodeToString(transfer), count, r.save(st)
}

// newBundle builds a signed bundle; sealTo nil leaves the payload readable
// (receipts carry no secrets, only which bundle arrived and when).
func (r *Relay) newBundle(st *relayState, device, service string, payload []byte, ttl time.Duration, now time.Time, sealTo *PeerKey, admin bool) (*outItem, []byte, error) {
	st.Seq++
	b := &Bundle{
		Primary: Primary{
			Flags:    flagNoFragment,
			CRCType:  crc32C,
			Dest:     EID("dtn://" + device + "/" + service),
			Source:   r.me(), // the source node ID (RFC 9171 §4.3.1); the service is on the destination
			ReportTo: EID("dtn://" + r.Keys.Name + "/" + serviceArgo),
			Created:  dtnTime(now),
			Seq:      st.Seq,
			Lifetime: uint64(ttl / time.Millisecond),
		},
		Blocks: []Block{{Type: blockPayload, Num: 1, CRCType: crc32C, Data: payload}},
	}
	if admin {
		b.Flags |= flagAdminRecord
		b.ReportTo = dtnNone // never ask for a report about a report
	} else {
		b.Flags |= flagReportDelivery | flagStatusTime
	}
	if err := signBundle(b, r.Keys); err != nil {
		return nil, nil, err
	}
	if sealTo != nil {
		if err := sealBundle(b, *sealTo); err != nil {
			return nil, nil, err
		}
	}
	raw, err := b.Marshal()
	if err != nil {
		return nil, nil, err
	}
	return &outItem{Key: b.Key(), Dest: device, State: stateQueued, Created: now, Expires: b.Expires(), Receipt: admin}, raw, nil
}

// ---- syncing ----

// SyncReport says what one Sync did.
type SyncReport struct {
	Uploaded, Received, Delivered, Rejected, Expired int
	HubUp                                            bool
	Errors                                           []string
	NewKeys                                          []string // "device FINGERPRINT" pinned from a carried folder
}

func (s SyncReport) String() string {
	line := fmt.Sprintf("sent %d, received %d, confirmed %d", s.Uploaded, s.Received, s.Delivered)
	if s.Rejected > 0 {
		line += fmt.Sprintf(", refused %d", s.Rejected)
	}
	if s.Expired > 0 {
		line += fmt.Sprintf(", expired %d", s.Expired)
	}
	if !s.HubUp {
		line += " (hub unreachable; will retry)"
	}
	return line
}

func retryDelay(attempts int) time.Duration {
	d := retryBase << max(attempts-1, 0)
	if d > retryMax || d <= 0 {
		return retryMax
	}
	return d
}

// Sync expires old bundles, then uploads, checks and fetches through the hub.
func (r *Relay) Sync(ctx context.Context) SyncReport {
	st := r.load()
	defer func() { _ = r.save(st) }()
	rep := SyncReport{}
	now := r.now()
	r.expire(st, now, &rep)
	if r.Hub == nil {
		return rep
	}
	if !st.Published {
		switch err := r.Hub.Publish(ctx, r.Keys.Public()); {
		case err == nil:
			st.Published = true
		case errors.Is(err, errHubConflict):
			st.Published = true // keep going; the alert tells the person what to do
			r.notify("Argo: key conflict", "Gauss already has a different key for "+r.Keys.Name+". An admin must revoke and re-enroll this device before others can send to it.")
		}
	}
	if now.Sub(st.DirAt) > time.Hour {
		r.refreshDirectory(ctx, st, false)
	}
	rep.HubUp = r.upload(ctx, st, now, &rep)
	if rep.HubUp && !r.NoHubRecheck {
		r.recheck(ctx, st, now)
	}
	if rep.HubUp {
		r.fetch(ctx, st, &rep)
	}
	return rep
}

func (r *Relay) expire(st *relayState, now time.Time, rep *SyncReport) {
	for k, it := range st.Out {
		switch {
		case it.State == stateDelivered || it.State == stateExpired || it.State == stateRefused:
			if now.Sub(it.Done) > keepDoneFor {
				delete(st.Out, k)
			}
		case now.After(it.Expires):
			it.State, it.Done = stateExpired, now
			_ = os.Remove(r.outPath(k))
			if !it.Receipt {
				rep.Expired++
				if it.Chunk == 0 {
					r.notify("Argo: not delivered", fmt.Sprintf("%s to %s expired before it arrived.", it.Name, it.Dest))
				}
			}
		}
	}
	for k, until := range st.Seen {
		if now.After(until) {
			delete(st.Seen, k)
		}
	}
	for id, p := range st.Partial {
		if now.After(p.Expires) {
			_ = os.RemoveAll(filepath.Join(r.Dir, "in", id))
			delete(st.Partial, id)
		}
	}
}

// pending lists outbox items in a stable order: receipts first (they are
// small and unblock senders), then oldest first.
func pending(st *relayState, want string) []*outItem {
	var out []*outItem
	for _, it := range st.Out {
		if it.State == want {
			out = append(out, it)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Receipt != out[j].Receipt {
			return out[i].Receipt
		}
		if !out[i].Created.Equal(out[j].Created) {
			return out[i].Created.Before(out[j].Created)
		}
		return out[i].Key < out[j].Key
	})
	return out
}

// upload returns false when the hub could not be reached at all.
func (r *Relay) upload(ctx context.Context, st *relayState, now time.Time, rep *SyncReport) bool {
	reached := false
	for _, it := range pending(st, stateQueued) {
		if now.Before(it.NextTry) {
			continue
		}
		raw, err := os.ReadFile(r.outPath(it.Key))
		if err != nil {
			it.State, it.Done = stateRefused, now // the bundle file is gone; nothing to send
			continue
		}
		err = r.Hub.Put(ctx, raw)
		switch {
		case err == nil:
			reached = true
			st.Hub.record(true, now)
			it.State, it.CheckedAt, it.Attempts = stateAtHub, now, 0
			it.Uploads++
			rep.Uploaded++
		case errors.Is(err, errHubRefused):
			reached = true
			it.State, it.Done = stateRefused, now
			_ = os.Remove(r.outPath(it.Key))
			if !it.Receipt && it.Chunk == 0 {
				r.notify("Argo: not sent", fmt.Sprintf("Gauss refused %s for %s: %v", it.Name, it.Dest, err))
			}
		default:
			st.Hub.record(false, now)
			it.Attempts++
			it.NextTry = now.Add(retryDelay(it.Attempts))
			rep.Errors = append(rep.Errors, Mask(err.Error()))
			return reached // offline or hub down: stop for this round
		}
	}
	if !reached { // nothing to upload: one cheap call says whether the hub is there
		_, err := r.Hub.Status(ctx, nil)
		st.Hub.record(err == nil, now)
		return err == nil
	}
	return true
}

// recheck asks the hub about bundles it should be holding. A bundle the hub
// no longer knows and the destination never confirmed is queued again.
func (r *Relay) recheck(ctx context.Context, st *relayState, now time.Time) {
	var keys []string
	for _, it := range st.Out {
		if (it.State == stateAtHub || it.State == statePickedUp) && now.Sub(it.CheckedAt) >= statusEvery {
			keys = append(keys, it.Key)
		}
	}
	if len(keys) == 0 {
		return
	}
	sort.Strings(keys)
	status, err := r.Hub.Status(ctx, keys)
	if err != nil {
		return
	}
	for _, k := range keys {
		it := st.Out[k]
		it.CheckedAt = now
		switch status[k] {
		case "queued":
			it.State = stateAtHub
		case "picked-up":
			if it.Receipt { // receipts need no receipt of their own
				it.State, it.Done = stateDelivered, now
				_ = os.Remove(r.outPath(k))
			} else {
				it.State = statePickedUp
			}
		default: // the hub lost it (restart, wipe) before the destination confirmed
			it.State, it.NextTry = stateQueued, time.Time{}
		}
	}
}

func (r *Relay) fetch(ctx context.Context, st *relayState, rep *SyncReport) {
	items, err := r.Hub.List(ctx)
	if err != nil {
		rep.Errors = append(rep.Errors, Mask(err.Error()))
		return
	}
	if len(items) > fetchPerSync {
		items = items[:fetchPerSync]
	}
	for _, h := range items {
		raw, err := r.Hub.Get(ctx, h.Key)
		if err != nil {
			rep.Errors = append(rep.Errors, Mask(err.Error()))
			return
		}
		res, err := r.accept(ctx, st, raw)
		switch res {
		case acceptDeferred:
			continue // e.g. the sender's key isn't in the directory yet: leave it on the hub
		case acceptRejected:
			rep.Rejected++
			r.notify("Argo: refused a bundle", fmt.Sprintf("From %s: %v", safeName(h.From), err))
		case acceptFile, acceptChunk:
			rep.Received++
		case acceptReceipt:
			rep.Delivered++
		}
		if res == acceptError {
			rep.Errors = append(rep.Errors, err.Error())
			continue // local problem (disk): keep it on the hub and retry
		}
		if err := r.save(st); err != nil { // persist before telling the hub it can forget it
			rep.Errors = append(rep.Errors, err.Error())
			return
		}
		_ = r.Hub.Ack(ctx, h.Key)
	}
}

// refreshDirectory pins keys seen for the first time and alerts when the
// hub offers a different key for a device already pinned.
func (r *Relay) refreshDirectory(ctx context.Context, st *relayState, quiet bool) {
	if r.Hub == nil {
		return
	}
	keys, err := r.Hub.Directory(ctx)
	if err != nil {
		return
	}
	st.DirAt = r.now()
	for _, k := range keys {
		if !deviceRE.MatchString(k.Node) || k.valid() != nil {
			continue
		}
		old, ok := st.Pins[k.Node]
		switch {
		case !ok:
			st.Pins[k.Node] = k
		case old.Fingerprint() != k.Fingerprint() && !quiet:
			r.notify("Argo: key changed", fmt.Sprintf("Gauss offers a new key for %s (%s). Still trusting the old one. If %s was re-enrolled, check the code with its owner, then run: argo keys trust %s", k.Node, k.Fingerprint(), k.Node, k.Node))
		}
	}
}

// TrustNew replaces a device's pinned key with the one the hub offers now.
func (r *Relay) TrustNew(ctx context.Context, device string) (PeerKey, error) {
	if r.Hub == nil {
		return PeerKey{}, errors.New("no hub configured")
	}
	keys, err := r.Hub.Directory(ctx)
	if err != nil {
		return PeerKey{}, err
	}
	for _, k := range keys {
		if k.Node == device && k.valid() == nil {
			st := r.load()
			st.Pins[device] = k
			return k, r.save(st)
		}
	}
	return PeerKey{}, fmt.Errorf("%s is not in the directory", device)
}

type acceptResult int

const (
	acceptRejected acceptResult = iota
	acceptDeferred
	acceptDuplicate
	acceptChunk
	acceptFile
	acceptReceipt
	acceptError
)

// accept checks and stores one bundle addressed to this device.
func (r *Relay) accept(ctx context.Context, st *relayState, raw []byte) (acceptResult, error) {
	b, err := ParseBundle(raw)
	if err != nil {
		return acceptRejected, err
	}
	now := r.now()
	if b.Dest.Node() != r.me() {
		return acceptRejected, errors.New("not addressed to this device")
	}
	if b.Flags&flagFragment != 0 {
		return acceptRejected, errors.New("fragments are not accepted")
	}
	if now.After(b.Expires().Add(clockSkew)) {
		return acceptRejected, errors.New("expired")
	}
	if b.Lifetime > uint64(maxTTL/time.Millisecond) || fromDTNTime(b.Created).After(now.Add(24*time.Hour)) {
		return acceptRejected, errors.New("implausible creation time or lifetime")
	}
	from := b.Source.NodeName()
	if !deviceRE.MatchString(from) || from == r.Keys.Name {
		return acceptRejected, errors.New("bad source")
	}
	key := b.Key()
	if _, dup := st.Seen[key]; dup {
		if b.Flags&flagReportDelivery != 0 && !r.NoResendReceipt {
			r.queueReceipt(st, b.Primary, now) // our first receipt may have been lost
		}
		return acceptDuplicate, nil
	}
	peer, ok := st.Pins[from]
	if !ok {
		r.refreshDirectory(ctx, st, true)
		if peer, ok = st.Pins[from]; !ok {
			return acceptDeferred, errors.New("unknown sender")
		}
	}
	if b.Flags&flagAdminRecord != 0 {
		if b.BlockOfType(blockArgoSeal) != nil {
			return acceptRejected, errors.New("unexpected encrypted status report")
		}
		if err := verifyBundle(b, peer); err != nil {
			return acceptRejected, err
		}
		rpt, err := decodeStatusReport(b.Payload())
		if err != nil {
			return acceptRejected, err
		}
		st.Seen[key] = b.Expires().Add(clockSkew)
		it, ok := st.Out[rpt.Key()]
		if !ok || !rpt.Delivered || rpt.Subject.Node() != r.me() || it.Dest != from {
			return acceptDuplicate, nil // a receipt for something we no longer track
		}
		if it.State != stateDelivered {
			it.State, it.Done = stateDelivered, now
			_ = os.Remove(r.outPath(it.Key))
		}
		return acceptReceipt, nil
	}
	if err := openBundle(b, r.Keys); err != nil {
		return acceptRejected, err
	}
	if err := verifyBundle(b, peer); err != nil {
		return acceptRejected, err
	}
	a, err := decodeADU(b.Payload())
	if err != nil {
		return acceptRejected, err
	}
	res, err := r.storeChunk(st, from, a, b.Expires())
	if res == acceptError || res == acceptRejected {
		return res, err
	}
	st.Seen[key] = b.Expires().Add(clockSkew)
	if b.Flags&flagReportDelivery != 0 {
		r.queueReceipt(st, b.Primary, now)
	}
	return res, nil
}

// queueReceipt answers a delivered bundle with a signed status report, sent
// only to the bundle's own source node (never to a third party, so a
// receipt can't be used to reflect traffic at someone else).
func (r *Relay) queueReceipt(st *relayState, p Primary, now time.Time) {
	if p.ReportTo.Node() != p.Source.Node() {
		return
	}
	for _, it := range st.Out { // one receipt in flight per bundle is enough
		if it.Receipt && it.Subject == p.Key() && (it.State == stateQueued || it.State == stateAtHub) {
			return
		}
	}
	rpt := StatusReport{Delivered: true, At: dtnTime(now), Subject: p.Source.Node(), SubjectCreated: p.Created, SubjectSeq: p.Seq}
	payload, err := rpt.encode()
	if err != nil {
		return
	}
	ttl := max(p.Expires().Sub(now), time.Hour) // as long as the sender keeps waiting
	item, raw, err := r.newBundle(st, p.Source.NodeName(), serviceArgo, payload, ttl, now, nil, true)
	if err != nil || writeFileAtomic(r.outPath(item.Key), raw) != nil {
		return
	}
	item.Subject = p.Key()
	st.Out[item.Key] = item
}

func (r *Relay) storeChunk(st *relayState, from string, a adu, expires time.Time) (acceptResult, error) {
	if want := max(1, int((a.Size+chunkSize-1)/chunkSize)); a.Count != want {
		return acceptRejected, errors.New("chunk count does not match the file size")
	}
	id := hex.EncodeToString(a.Transfer)
	p, ok := st.Partial[id]
	if !ok {
		if len(st.Partial) >= maxPartial {
			return acceptError, errors.New("too many unfinished transfers; will retry")
		}
		p = &inTransfer{From: from, Name: safeName(a.Name), Size: a.Size, Sum: a.Sum, Count: a.Count, Expires: expires}
		st.Partial[id] = p
	}
	if p.From != from || p.Size != a.Size || p.Count != a.Count || string(p.Sum) != string(a.Sum) {
		return acceptRejected, errors.New("chunk does not match its transfer")
	}
	wantLen := chunkSize
	if a.Index == a.Count-1 {
		wantLen = int(a.Size) - (a.Count-1)*chunkSize
	}
	if len(a.Data) != wantLen {
		return acceptRejected, errors.New("chunk has the wrong length")
	}
	if !contains(p.Have, a.Index) {
		if err := writeFileAtomic(filepath.Join(r.Dir, "in", id, fmt.Sprint(a.Index)), a.Data); err != nil {
			return acceptError, err
		}
		p.Have = append(p.Have, a.Index)
	}
	if expires.After(p.Expires) {
		p.Expires = expires
	}
	if len(p.Have) < p.Count {
		return acceptChunk, nil
	}
	path, err := r.assemble(id, p)
	if err != nil {
		if errors.Is(err, errBadSum) {
			_ = os.RemoveAll(filepath.Join(r.Dir, "in", id))
			delete(st.Partial, id)
			return acceptRejected, err
		}
		return acceptError, err
	}
	delete(st.Partial, id)
	st.Received = append(st.Received, received{From: from, Name: filepath.Base(path), Path: path, Size: p.Size, At: r.now()})
	if len(st.Received) > 200 {
		st.Received = st.Received[len(st.Received)-200:]
	}
	r.notify("Argo: file received", fmt.Sprintf("%s from %s", filepath.Base(path), from))
	return acceptFile, nil
}

func contains(xs []int, x int) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

var errBadSum = errors.New("file checksum does not match; discarded")

// assemble joins the chunks, checks the SHA-256 the sender signed, and only
// then moves the file into the inbox under a name that doesn't overwrite.
func (r *Relay) assemble(id string, p *inTransfer) (string, error) {
	dir := filepath.Join(r.InboxDir, safeName(p.From))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, ".argo-incoming-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	h := sha256.New()
	for i := range p.Count {
		b, err := os.ReadFile(filepath.Join(r.Dir, "in", id, fmt.Sprint(i)))
		if err != nil {
			tmp.Close()
			return "", err
		}
		h.Write(b)
		if _, err := tmp.Write(b); err != nil {
			tmp.Close()
			return "", err
		}
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if string(h.Sum(nil)) != string(p.Sum) {
		return "", errBadSum
	}
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return "", err
	}
	ext := filepath.Ext(p.Name)
	base := strings.TrimSuffix(p.Name, ext)
	for n := 1; n < 1000; n++ {
		name := p.Name
		if n > 1 {
			name = fmt.Sprintf("%s (%d)%s", base, n, ext)
		}
		dst := filepath.Join(dir, name)
		if err := os.Link(tmp.Name(), dst); err == nil { // link fails if dst exists: no overwrite race
			_ = os.RemoveAll(filepath.Join(r.Dir, "in", id))
			return dst, nil
		} else if !errors.Is(err, os.ErrExist) {
			return "", err
		}
	}
	return "", errors.New("too many files with that name")
}

// ---- carried folders (data mules) ----

const muleKeyFile = "argo-key.json"

// MuleExport copies every bundle not yet confirmed into dir, for someone to
// carry to a device with no network, plus this device's public key so an
// air-gapped receiver can check them. Bundles are sealed and signed, so the
// carrier can neither read nor change them.
func (r *Relay) MuleExport(dir string) (int, error) {
	st := r.load()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return 0, err
	}
	if err := writeFileAtomic(filepath.Join(dir, muleKeyFile), mustJSON(r.Keys.Public())); err != nil {
		return 0, err
	}
	n := 0
	for k, it := range st.Out {
		if it.State == stateDelivered || it.State == stateExpired || it.State == stateRefused {
			continue
		}
		raw, err := os.ReadFile(r.outPath(k))
		if err != nil {
			continue
		}
		if err := writeFileAtomic(filepath.Join(dir, k+".bundle"), raw); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// MuleImport accepts the bundles in dir that are addressed to this device;
// others are left for whoever they are for. A carried public key is trusted
// only for a device not pinned yet (the same first-use rule as the hub
// directory); a different key for a pinned device is reported, never used.
func (r *Relay) MuleImport(ctx context.Context, dir string) (SyncReport, error) {
	st := r.load()
	defer func() { _ = r.save(st) }()
	var rep SyncReport
	entries, err := os.ReadDir(dir)
	if err != nil {
		return rep, err
	}
	if b, err := os.ReadFile(filepath.Join(dir, muleKeyFile)); err == nil && len(b) < 8<<10 {
		var k PeerKey
		if json.Unmarshal(b, &k) == nil && deviceRE.MatchString(k.Node) && k.valid() == nil && k.Node != r.Keys.Name {
			switch old, ok := st.Pins[k.Node]; {
			case !ok:
				st.Pins[k.Node] = k
				rep.NewKeys = append(rep.NewKeys, k.Node+" "+k.Fingerprint())
			case old.Fingerprint() != k.Fingerprint():
				r.notify("Argo: key changed", fmt.Sprintf("The carried folder has a different key for %s (%s). Still trusting the old one.", k.Node, k.Fingerprint()))
			}
		}
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".bundle") {
			continue
		}
		info, err := e.Info()
		if err != nil || info.Size() > 2*chunkSize {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		if b, err := ParseBundle(raw); err != nil || b.Dest.Node() != r.me() {
			continue
		}
		switch res, err := r.accept(ctx, st, raw); res {
		case acceptFile, acceptChunk:
			rep.Received++
		case acceptReceipt:
			rep.Delivered++
		case acceptRejected:
			rep.Rejected++
			rep.Errors = append(rep.Errors, fmt.Sprintf("%s: %v", e.Name(), err))
		}
	}
	return rep, nil
}

// ---- views ----

func (r *Relay) Outbox() []outItem {
	st := r.load()
	var out []outItem
	for _, it := range st.Out {
		if !it.Receipt {
			out = append(out, *it)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Created.Equal(out[j].Created) {
			return out[i].Created.After(out[j].Created)
		}
		return out[i].Chunk < out[j].Chunk
	})
	return out
}

func (r *Relay) Inbox() []received { return r.load().Received }

func (r *Relay) Pins() map[string]PeerKey { return r.load().Pins }

func (r *Relay) HubHealth() pathHealth { return r.load().Hub }
