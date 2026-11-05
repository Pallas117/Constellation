package main

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testLinkKey(t *testing.T, at time.Time) *linkKey {
	t.Helper()
	k, err := newLinkKey(at)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func marshalSize(t *testing.T, b *Bundle) int {
	t.Helper()
	raw, err := b.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	return len(raw)
}

func reparsed(t *testing.T, b *Bundle) *Bundle {
	t.Helper()
	raw, err := b.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	out, err := ParseBundle(raw)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestLinkProtectOpen(t *testing.T) {
	created := fromDTNTime(testBundle().Created)
	k, other := testLinkKey(t, created), testLinkKey(t, created)
	plain := testBundle().Payload()

	for _, sealed := range []bool{true, false} {
		b := testBundle()
		base := marshalSize(t, b)
		if err := linkProtect(b, k, sealed); err != nil {
			t.Fatal(err)
		}
		if added := marshalSize(t, b) - base; added > 160 {
			t.Errorf("sealed=%v: link protection added %d bytes; expected well under argo-sig + argo-seal's ~1.3 kB", sealed, added)
		}
		if sealed && bytes.Contains(b.Payload(), plain) {
			t.Fatal("a sealed payload must not be readable")
		}
		got := reparsed(t, b)
		if _, err := linkOpen(got, []*linkKey{other}, sealed); !errors.Is(err, errNoLinkKey) {
			t.Fatalf("sealed=%v: another key must not match: %v", sealed, err)
		}
		m, err := linkOpen(got, []*linkKey{other, k}, sealed) // any order: the BIB picks the key
		if err != nil || m != k {
			t.Fatalf("sealed=%v: open: %v", sealed, err)
		}
		if len(got.Blocks) != 1 || !bytes.Equal(got.Payload(), plain) {
			t.Fatalf("sealed=%v: opened bundle: %+v", sealed, got.Blocks)
		}
	}

	// Wrong shape for the bundle kind, a tampered payload or primary block,
	// a reflected bundle, and a key used outside its lifetime all fail.
	protected := func(sealed bool) *Bundle {
		b := testBundle()
		if err := linkProtect(b, k, sealed); err != nil {
			t.Fatal(err)
		}
		return reparsed(t, b)
	}
	if _, err := linkOpen(protected(false), []*linkKey{k}, true); err == nil {
		t.Error("an unsealed bundle must not pass as sealed")
	}
	if _, err := linkOpen(protected(true), []*linkKey{k}, false); err == nil {
		t.Error("a sealed bundle must not pass as a receipt")
	}
	b := protected(true)
	b.Blocks[len(b.Blocks)-1].Data[3] ^= 1
	if _, err := linkOpen(b, []*linkKey{k}, true); err == nil || errors.Is(err, errNoLinkKey) {
		t.Errorf("tampered payload: %v", err)
	}
	b = protected(false)
	b.Blocks[len(b.Blocks)-1].Data[3] ^= 1
	if _, err := linkOpen(b, []*linkKey{k}, false); err == nil {
		t.Error("tampered receipt payload accepted")
	}
	b = protected(true)
	b.Lifetime++
	if _, err := linkOpen(b, []*linkKey{k}, true); err == nil {
		t.Error("tampered primary block accepted")
	}
	b = protected(true)
	b.Source, b.Dest = "dtn://ground-1/", "dtn://judith/files"
	if _, err := linkOpen(b, []*linkKey{k}, true); err == nil {
		t.Error("a bundle reflected back to its sender must not open: each direction has its own keys")
	}
	old := testLinkKey(t, created.Add(-linkKeyLife-time.Hour))
	old.Key = k.Key
	if _, err := linkOpen(protected(true), []*linkKey{old}, true); !errors.Is(err, errNoLinkKey) {
		t.Errorf("a key past its lifetime must not be tried: %v", err)
	}

	// Only linkProtect's exact parameters are accepted (here SHA-384).
	b = testBundle()
	mac, _ := k.subKey("bib", "judith", "ground-1")
	if _, err := addBIB(b, BIBConfig{Source: b.Source, Targets: []uint64{0, 1}, Variant: hmacSHA384, Scope: scopeAll, Key: mac}); err != nil {
		t.Fatal(err)
	}
	if _, err := linkOpen(reparsed(t, b), []*linkKey{k}, false); err == nil || errors.Is(err, errNoLinkKey) {
		t.Errorf("other parameters must be refused as the wrong shape: %v", err)
	}
	// Node security and link security never mix.
	b = testBundle()
	if err := signBundle(b, newTestKeys(t, "judith")); err != nil {
		t.Fatal(err)
	}
	if err := linkProtect(b, k, true); err == nil {
		t.Error("link protection on a signed bundle")
	}
}

func TestLinkOfferCodec(t *testing.T) {
	o := linkOffer{ID: bytes.Repeat([]byte{1}, linkIDLen), Key: bytes.Repeat([]byte{2}, linkKeyLen), Created: 42,
		Have: [][]byte{bytes.Repeat([]byte{3}, linkIDLen)}}
	got, err := decodeLinkOffer(o.encode())
	if err != nil || !bytes.Equal(got.ID, o.ID) || !bytes.Equal(got.Key, o.Key) || got.Created != 42 || len(got.Have) != 1 {
		t.Fatalf("round trip: %+v %v", got, err)
	}
	for _, bad := range []linkOffer{
		{ID: o.ID[:4], Key: o.Key},
		{ID: o.ID, Key: o.Key[:16]},
		{ID: o.ID, Key: o.Key, Have: [][]byte{{1}}},
	} {
		if _, err := decodeLinkOffer(bad.encode()); err == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
	if _, err := decodeLinkOffer(append(o.encode(), 0)); err == nil {
		t.Error("trailing bytes accepted")
	}
}

func newLinkedNode(t *testing.T, name string, hub *memHubServer, clock *fakeClock) *testNode {
	t.Helper()
	n := newNode(t, name, hub, clock)
	n.LinkPath = filepath.Join(t.TempDir(), "links.key")
	return n
}

// atHub returns the bundles queued for dest, parsed.
func atHub(t *testing.T, hub *memHubServer, dest string) []*Bundle {
	t.Helper()
	var out []*Bundle
	for _, e := range hub.queues[dest] {
		b, err := ParseBundle(e.raw)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, b)
	}
	return out
}

// syncAll syncs every node until nothing is queued anywhere: Sync uploads
// before it fetches, so a receipt made during a fetch goes out next time.
func syncAll(t *testing.T, hub *memHubServer, nodes ...*testNode) {
	t.Helper()
	for range 12 {
		for _, n := range nodes {
			n.Sync(ctx)
		}
		idle := true
		for _, q := range hub.queues {
			idle = idle && len(q) == 0
		}
		for _, n := range nodes {
			for _, it := range n.load().Out {
				idle = idle && it.State != stateQueued
			}
		}
		if idle {
			return
		}
	}
	t.Fatal("the nodes never settled")
}

// linkedPair returns two nodes that have exchanged and confirmed link keys
// in both directions through one ordinary file transfer.
func linkedPair(t *testing.T, clock *fakeClock) (*memHubServer, *testNode, *testNode) {
	t.Helper()
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newLinkedNode(t, "judith", hub, clock), newLinkedNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	if _, _, err := a.Send(ctx, "ground-1", writeTemp(t, "first.txt", []byte("first")), 0); err != nil {
		t.Fatal(err)
	}
	for _, bd := range atHub(t, hub, "ground-1") {
		t.Fatalf("nothing should be at the hub before a syncs: %v", bd.Key())
	}
	a.Sync(ctx)
	got := atHub(t, hub, "ground-1")
	if len(got) != 2 {
		t.Fatalf("want the offer and the first file at the hub, have %d", len(got))
	}
	for _, bd := range got {
		if bd.BlockOfType(blockArgoSeal) == nil || bd.BlockOfType(blockBCB) != nil {
			t.Fatal("before a link key is confirmed, bundles carry argo-sig + argo-seal")
		}
	}
	syncAll(t, hub, a, b)
	sa, sb := a.load(), b.load()
	ka, kb := sa.links.Tx["ground-1"], sb.links.Tx["judith"]
	if ka == nil || kb == nil || ka.Confirmed.IsZero() || kb.Confirmed.IsZero() {
		t.Fatalf("both directions should be confirmed: %+v %+v", ka, kb)
	}
	if len(sb.links.Rx["judith"]) != 1 || sb.links.Rx["judith"][0].ID != ka.ID || sa.links.Rx["ground-1"][0].ID != kb.ID {
		t.Fatal("each side must hold the other's key")
	}
	if len(b.Inbox()) != 1 {
		t.Fatalf("first file: %+v", b.Inbox())
	}
	return hub, a, b
}

func TestRelayLinkKeysTakeOver(t *testing.T) {
	clock := newClock()
	hub, a, b := linkedPair(t, clock)
	if _, _, err := a.Send(ctx, "ground-1", writeTemp(t, "second.txt", []byte("second, via the link key")), 0); err != nil {
		t.Fatal(err)
	}
	key := a.onlyUndelivered(t)
	a.Sync(ctx)
	got := atHub(t, hub, "ground-1")
	if len(got) != 1 || got[0].BlockOfType(blockBCB) == nil || got[0].BlockOfType(blockBIB) == nil ||
		got[0].BlockOfType(blockArgoSeal) != nil || got[0].BlockOfType(blockArgoSig) != nil {
		t.Fatalf("a confirmed link key must protect the file chunk with BIB + BCB only")
	}
	b.Sync(ctx)
	b.Sync(ctx) // receipt, under ground-1's own link key
	for _, rc := range atHub(t, hub, "judith") {
		if rc.BlockOfType(blockBIB) == nil || rc.BlockOfType(blockArgoSig) != nil {
			t.Fatal("the receipt should carry a BIB under the link key")
		}
	}
	a.Sync(ctx)
	if a.state(key) != stateDelivered || len(b.Inbox()) != 2 {
		t.Fatalf("delivery: %s %+v", a.state(key), b.Inbox())
	}
	if got, _ := os.ReadFile(b.Inbox()[1].Path); string(got) != "second, via the link key" {
		t.Fatalf("content %q", got)
	}

	// The keys stay in links.key (mode 600) and nowhere else.
	for _, n := range []*testNode{a, b} {
		info, err := os.Stat(n.LinkPath)
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("links.key: %v %v", info, err)
		}
		rel, _ := os.ReadFile(filepath.Join(n.Dir, "relay.json"))
		for _, k := range n.load().links.Tx {
			secret := base64.StdEncoding.EncodeToString(k.Key)
			if bytes.Contains(rel, []byte(secret)) || strings.Contains(strings.Join(n.alerts, "\n"), secret) {
				t.Fatal("a link key leaked out of links.key")
			}
		}
	}
	// Outbox views only show files.
	for _, it := range a.Outbox() {
		if it.Offer != "" {
			t.Error("link key offers must not show in the outbox")
		}
	}
}

func TestRelayLinkKeyRotates(t *testing.T) {
	clock := newClock()
	hub, a, b := linkedPair(t, clock)
	first := a.load().links.Tx["ground-1"].ID
	clock.add(linkKeyLife + time.Hour)
	if _, _, err := a.Send(ctx, "ground-1", writeTemp(t, "late.txt", []byte("late")), 0); err != nil {
		t.Fatal(err)
	}
	a.Sync(ctx)
	for _, bd := range atHub(t, hub, "ground-1") {
		if bd.BlockOfType(blockArgoSeal) == nil {
			t.Fatal("after its lifetime the old key must not be used; fall back until the new one is confirmed")
		}
	}
	syncAll(t, hub, a, b)
	k := a.load().links.Tx["ground-1"]
	if k.ID == first || k.Confirmed.IsZero() {
		t.Fatalf("rotation: %+v", k)
	}
	if rx := b.load().links.Rx["judith"]; len(rx) != 2 || rx[0].ID != k.ID {
		t.Fatalf("the receiver keeps the old key for bundles in flight, newest first: %d", len(rx))
	}
	if _, _, err := a.Send(ctx, "ground-1", writeTemp(t, "next.txt", []byte("next")), 0); err != nil {
		t.Fatal(err)
	}
	for _, it := range a.load().Out {
		if it.Name == "next.txt" && it.LinkKey != k.ID {
			t.Fatalf("the new key should protect the next file: %+v", it)
		}
	}
	syncAll(t, hub, a, b)
	if len(b.Inbox()) != 3 {
		t.Fatalf("inbox: %+v", b.Inbox())
	}

	// Count-based rotation too.
	st := a.load()
	st.LinkUses[k.ID] = linkKeyUses
	if a.txLink(st, "ground-1", clock.now()) != nil {
		t.Error("a key used linkKeyUses times must not be used again")
	}
}

func TestRelayLinkKeyLossRecovers(t *testing.T) {
	clock := newClock()
	hub, a, b := linkedPair(t, clock)
	clock.add(clockSkew + time.Minute)
	if err := os.Remove(b.LinkPath); err != nil { // ground-1 loses links.key; node.key stays
		t.Fatal(err)
	}
	if _, _, err := a.Send(ctx, "ground-1", writeTemp(t, "after-loss.txt", []byte("after the loss")), 0); err != nil {
		t.Fatal(err)
	}
	a.Sync(ctx)
	if r := b.Sync(ctx); r.Rejected != 1 {
		t.Fatalf("ground-1 can't read it: %+v", r)
	}
	syncAll(t, hub, a, b)
	names := map[string]int{}
	for _, f := range b.Inbox() {
		names[f.Name]++
	}
	if names["after-loss.txt"] != 1 {
		t.Fatalf("the file should arrive once, re-sent with node security: %+v", b.Inbox())
	}
	for _, it := range a.load().Out {
		if it.Name == "after-loss.txt" && it.State != stateDelivered {
			t.Fatalf("re-sent chunk not confirmed: %+v", it)
		}
	}
	ka, kb := a.load().links.Tx["ground-1"], b.load().links.Tx["judith"]
	if ka == nil || ka.Confirmed.IsZero() || kb == nil || kb.Confirmed.IsZero() {
		t.Fatal("both directions should have new confirmed keys")
	}
}

func TestRelayTrustNewForgetsLinkKeys(t *testing.T) {
	clock := newClock()
	hub, a, _ := linkedPair(t, clock)
	// ground-1 is re-enrolled with a new identity.
	c := newLinkedNode(t, "ground-1", nil, clock)
	hub.keys["ground-1"] = c.Keys.Public()
	if _, err := a.TrustNew(ctx, "ground-1"); err != nil {
		t.Fatal(err)
	}
	st := a.load()
	if st.links.Tx["ground-1"] != nil || len(st.links.Rx["ground-1"]) != 0 {
		t.Fatal("keys agreed with the old identity must go")
	}
}

// onlyUndelivered returns the one file chunk still waiting for a receipt.
func (n *testNode) onlyUndelivered(t *testing.T) string {
	t.Helper()
	var keys []string
	for k, it := range n.load().Out {
		if !it.internal() && it.State != stateDelivered {
			keys = append(keys, k)
		}
	}
	if len(keys) != 1 {
		t.Fatalf("want one undelivered bundle, have %d", len(keys))
	}
	return keys[0]
}
