package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time      { return c.t }
func (c *fakeClock) add(d time.Duration) { c.t = c.t.Add(d) }
func newClock() *fakeClock               { return &fakeClock{t: time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)} }
func writeTemp(t *testing.T, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

type testNode struct {
	*Relay
	alerts []string
}

func newNode(t *testing.T, name string, hub *memHubServer, clock *fakeClock) *testNode {
	t.Helper()
	n := &testNode{}
	n.Relay = &Relay{Dir: t.TempDir(), Keys: newTestKeys(t, name), InboxDir: t.TempDir(), Now: clock.now,
		Notify: func(title, msg string) { n.alerts = append(n.alerts, title+": "+msg) }}
	if hub != nil {
		n.Hub = hub.client(name)
	}
	return n
}

func (n *testNode) state(key string) string {
	st := n.load()
	if it, ok := st.Out[key]; ok {
		return it.State
	}
	return ""
}

func (n *testNode) onlyOutKey(t *testing.T) string {
	t.Helper()
	var keys []string
	for k, it := range n.load().Out {
		if !it.Receipt {
			keys = append(keys, k)
		}
	}
	if len(keys) != 1 {
		t.Fatalf("want one outbound bundle, have %d", len(keys))
	}
	return keys[0]
}

var ctx = context.Background()

func TestRelayDeliversWithSignedReceipt(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx) // publishes ground-1's keys

	src := writeTemp(t, "pass-plan.txt", []byte("AOS 09:41 EL 62"))
	if _, n, err := a.Send(ctx, "ground-1", src, 0); err != nil || n != 1 {
		t.Fatalf("send: %d %v", n, err)
	}
	key := a.onlyOutKey(t)
	if r := a.Sync(ctx); r.Uploaded != 1 || a.state(key) != stateAtHub {
		t.Fatalf("upload: %+v %s", r, a.state(key))
	}
	if r := b.Sync(ctx); r.Received != 1 {
		t.Fatalf("receive: %+v", r)
	}
	inbox := b.Inbox()
	if len(inbox) != 1 || inbox[0].From != "judith" || inbox[0].Name != "pass-plan.txt" {
		t.Fatalf("inbox: %+v", inbox)
	}
	if got, _ := os.ReadFile(inbox[0].Path); string(got) != "AOS 09:41 EL 62" {
		t.Fatalf("content: %q", got)
	}
	if info, _ := os.Stat(inbox[0].Path); info.Mode().Perm() != 0o600 {
		t.Errorf("received file mode %v", info.Mode().Perm())
	}
	b.Sync(ctx) // uploads the receipt
	if r := a.Sync(ctx); r.Delivered != 1 || a.state(key) != stateDelivered {
		t.Fatalf("receipt: %+v %s", r, a.state(key))
	}
	if _, err := os.Stat(a.outPath(key)); !os.IsNotExist(err) {
		t.Error("a delivered bundle must be removed from the outbox")
	}
}

func TestRelayMultiChunkAndEmptyFiles(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	big := make([]byte, 2*chunkSize+123)
	_, _ = rand.Read(big)
	if _, n, err := a.Send(ctx, "ground-1", writeTemp(t, "telemetry.bin", big), 0); err != nil || n != 3 {
		t.Fatalf("send: %d %v", n, err)
	}
	if _, n, err := a.Send(ctx, "ground-1", writeTemp(t, "empty.txt", nil), 0); err != nil || n != 1 {
		t.Fatalf("empty send: %d %v", n, err)
	}
	a.Sync(ctx)
	b.Sync(ctx)
	got := map[string][]byte{}
	for _, r := range b.Inbox() {
		got[r.Name], _ = os.ReadFile(r.Path)
	}
	if !bytes.Equal(got["telemetry.bin"], big) || got["empty.txt"] == nil || len(got["empty.txt"]) != 0 {
		t.Fatalf("received %d files", len(got))
	}
}

func TestRelayReuploadsWhenHubLosesBundles(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	_, _, _ = a.Send(ctx, "ground-1", writeTemp(t, "f.txt", []byte("x")), 0)
	key := a.onlyOutKey(t)
	a.Sync(ctx)
	hub.wipe() // restored from an old backup before ground-1 came online
	clock.add(statusEvery)
	a.Sync(ctx) // recheck sees "unknown" and queues it again
	a.Sync(ctx)
	b.Sync(ctx)
	b.Sync(ctx)
	a.Sync(ctx)
	if a.state(key) != stateDelivered {
		t.Fatalf("after hub loss: %s", a.state(key))
	}
}

func TestRelayResendsReceiptForDuplicates(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	_, _, _ = a.Send(ctx, "ground-1", writeTemp(t, "f.txt", []byte("x")), 0)
	key := a.onlyOutKey(t)
	a.Sync(ctx)
	b.Sync(ctx) // delivered; receipt queued
	b.Sync(ctx) // receipt uploaded
	hub.wipe()  // ...and lost, with the tombstone
	clock.add(statusEvery)
	a.Sync(ctx) // unknown at the hub, no receipt: re-upload
	a.Sync(ctx)
	if r := b.Sync(ctx); r.Received != 0 || len(b.Inbox()) != 1 {
		t.Fatalf("duplicate must not be delivered twice: %+v", r)
	}
	b.Sync(ctx)
	a.Sync(ctx)
	if a.state(key) != stateDelivered {
		t.Fatalf("lost receipt never replaced: %s", a.state(key))
	}
}

func TestRelayWorksOfflineAndExpires(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	a.Sync(ctx) // learn ground-1's key while online
	hub.down = true
	if _, _, err := a.Send(ctx, "ground-1", writeTemp(t, "notes.md", []byte("x")), time.Hour); err != nil {
		t.Fatalf("sending while offline must queue, not fail: %v", err)
	}
	key := a.onlyOutKey(t)
	if r := a.Sync(ctx); r.HubUp || a.state(key) != stateQueued {
		t.Fatalf("offline: %+v %s", r, a.state(key))
	}
	clock.add(2 * time.Hour)
	if r := a.Sync(ctx); r.Expired != 1 || a.state(key) != stateExpired {
		t.Fatalf("expiry: %+v %s", r, a.state(key))
	}
	if len(a.alerts) == 0 || !strings.Contains(a.alerts[len(a.alerts)-1], "notes.md") {
		t.Errorf("expiry must say which file: %v", a.alerts)
	}
}

func TestRelayRestartKeepsQueue(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	a.Sync(ctx)
	hub.down = true
	_, _, _ = a.Send(ctx, "ground-1", writeTemp(t, "f.txt", []byte("survives")), 0)
	a.Sync(ctx)
	// A new process: same directories and keys, fresh Relay value.
	a2 := &Relay{Dir: a.Dir, Keys: a.Keys, InboxDir: a.InboxDir, Now: clock.now, Hub: hub.client("judith")}
	hub.down = false
	clock.add(retryMax)
	a2.Sync(ctx)
	b.Sync(ctx)
	if len(b.Inbox()) != 1 {
		t.Fatal("bundle queued before a restart was lost")
	}
}

func TestRelayRefusesForgedAndTamperedBundles(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1", "mallory")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	m := newNode(t, "mallory", hub, clock)
	b.Sync(ctx)
	a.Sync(ctx)
	m.Sync(ctx)
	// mallory signs as itself but claims to be judith: the hub refuses the upload.
	forged := testBundle()
	forged.Source, forged.Dest = "dtn://judith/", "dtn://ground-1/files"
	raw, _ := forged.Marshal()
	if err := hub.client("mallory").Put(ctx, raw); err == nil {
		t.Fatal("hub accepted a bundle whose source is not the uploader")
	}
	// A bundle judith really sent, altered in the hub's storage.
	_, _, _ = a.Send(ctx, "ground-1", writeTemp(t, "f.txt", []byte("genuine")), 0)
	a.Sync(ctx)
	for k, e := range hub.queues["ground-1"] {
		pb, _ := ParseBundle(e.raw)
		pb.Blocks[len(pb.Blocks)-1].Data[10] ^= 1
		e.raw, _ = pb.Marshal()
		hub.queues["ground-1"][k] = e
	}
	if r := b.Sync(ctx); r.Rejected != 1 || len(b.Inbox()) != 0 {
		t.Fatalf("tampered bundle: %+v", r)
	}
	if len(b.alerts) == 0 || !strings.Contains(b.alerts[0], "refused") {
		t.Errorf("a refused bundle must alert: %v", b.alerts)
	}
}

func TestRelayKeyPinningAlertsOnChange(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	a.Sync(ctx)
	before := a.Pins()["ground-1"].Fingerprint()
	// The hub now offers a different key for ground-1 (compromised hub, or re-enrollment).
	hub.keys["ground-1"] = newTestKeys(t, "ground-1").Public()
	clock.add(2 * time.Hour)
	a.Sync(ctx)
	if a.Pins()["ground-1"].Fingerprint() != before {
		t.Fatal("a changed key must not replace the pinned one silently")
	}
	if len(a.alerts) != 1 || !strings.Contains(a.alerts[0], "argo keys trust ground-1") {
		t.Fatalf("alerts: %v", a.alerts)
	}
	if k, err := a.TrustNew(ctx, "ground-1"); err != nil || a.Pins()["ground-1"].Fingerprint() != k.Fingerprint() {
		t.Fatal("argo keys trust must re-pin")
	}
}

func TestRelayUnknownSenderStaysOnHub(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	a.Sync(ctx)
	_, _, _ = a.Send(ctx, "ground-1", writeTemp(t, "f.txt", []byte("x")), 0)
	a.Sync(ctx)
	delete(hub.keys, "judith") // directory not yet showing the sender
	if r := b.Sync(ctx); r.Received != 0 || len(hub.queues["ground-1"]) != 1 {
		t.Fatalf("unknown sender: %+v, %d left on hub", r, len(hub.queues["ground-1"]))
	}
	hub.keys["judith"] = a.Keys.Public()
	if r := b.Sync(ctx); r.Received != 1 {
		t.Fatalf("after the key appears: %+v", r)
	}
}

func TestRelayDataMule(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	a.Sync(ctx)
	b.Sync(ctx) // learns judith's key
	// The ground station has no network at all from here on.
	b.Hub = nil
	_, _, _ = a.Send(ctx, "ground-1", writeTemp(t, "ephemeris.txt", []byte("TLE...")), 0)
	stick := t.TempDir()
	if n, err := a.MuleExport(stick); err != nil || n != 1 {
		t.Fatalf("export: %d %v", n, err)
	}
	if r, err := b.MuleImport(ctx, stick); err != nil || r.Received != 1 {
		t.Fatalf("import: %+v %v", r, err)
	}
	if r, _ := b.MuleImport(ctx, stick); r.Received != 0 || len(b.Inbox()) != 1 {
		t.Fatal("re-importing the same stick must not deliver twice")
	}
	back := t.TempDir() // the receipt rides back on the stick
	if n, _ := b.MuleExport(back); n != 1 {
		t.Fatalf("receipt export: %d", n)
	}
	if r, _ := a.MuleImport(ctx, back); r.Delivered != 1 {
		t.Fatalf("receipt import: %+v", r)
	}
}

func TestRelaySendChecks(t *testing.T) {
	clock := newClock()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a := newNode(t, "judith", hub, clock)
	for _, dev := range []string{"Ground", "../x", "judith", ""} {
		if _, _, err := a.Send(ctx, dev, writeTemp(t, "f", []byte("x")), 0); err == nil {
			t.Errorf("send to %q should fail", dev)
		}
	}
	if _, _, err := a.Send(ctx, "ground-1", writeTemp(t, "f", []byte("x")), 0); err == nil || !strings.Contains(err.Error(), "no published keys") {
		t.Errorf("unknown destination: %v", err)
	}
	if _, _, err := a.Send(ctx, "ground-1", t.TempDir(), 0); err == nil {
		t.Error("directories cannot be sent")
	}
}

func TestSafeName(t *testing.T) {
	for in, want := range map[string]string{
		"../../etc/passwd": "passwd", "..\\..\\x.txt": "x.txt", ".bashrc": "bashrc", "": "file",
		"a\x00b\nc.txt": "a_b_c.txt", "plan:v2.txt": "plan_v2.txt", "ok name.pdf": "ok name.pdf",
	} {
		if got := safeName(in); got != want {
			t.Errorf("safeName(%q) = %q, want %q", in, got, want)
		}
	}
	if len(safeName(strings.Repeat("x", 300))) != 128 {
		t.Error("names are capped at 128 bytes")
	}
}

func TestPathHealthTwoOfThree(t *testing.T) {
	var h pathHealth
	now := time.Now()
	for _, c := range []struct {
		ok   bool
		want bool
	}{{true, true}, {false, false}, {true, true}, {false, false}, {false, false}, {true, false}, {true, true}} {
		h.record(c.ok, now)
		if h.Up() != c.want {
			t.Fatalf("after %v: up=%v want %v (%v)", c.ok, h.Up(), c.want, h.Last)
		}
	}
}
