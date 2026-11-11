package main

// Link keys: the fast path between two devices that already trust each
// other (GAU-199).
//
// Each device makes one random 32-byte key for the bundles it sends to each
// peer and delivers it once, in an offer bundle that carries the node
// security of bpsec.go: signed with Ed25519 (argo-sig-1) and sealed with
// HPKE ML-KEM-768 + X25519 (argo-seal-1). It uses the key only after the
// peer's receipt for that offer comes back, so the peer has stored it first.
// From then on, bundles to that peer carry RFC 9173's standard contexts
// (bpsec9173.go) under keys derived from it with HKDF-SHA256, one per
// context and direction:
//
//   - file chunks: BIB-HMAC-SHA256 over the primary block, which also tells
//     the receiver which of the sender's keys was used, and BCB-AES-256-GCM
//     over the payload, whose additional data covers the primary block and
//     both block headers;
//   - receipts: BIB-HMAC-SHA256 over the primary block and the payload.
//
// Confidentiality stays post-quantum: a link key only ever travels under
// ML-KEM-768 + X25519, and AES-256 and HMAC-SHA-256 keep about 128-bit
// strength against Grover's search. Authenticity becomes pairwise: a valid
// HMAC or GCM tag proves that one of the two devices made the bundle, which
// is all the destination needs, but a third party can't check it. Whatever a
// third party may have to check keeps Ed25519: offers, receipts that answer
// a duplicate, and every bundle while no link key is confirmed.
//
// A sender replaces its key after linkKeyLife or linkKeyUses bundles,
// whichever comes first, and sends with argo-sig + argo-seal until the peer
// confirms the new one. Every offer also lists the peer's keys the offering
// device still holds, so a device that lost links.key gets the peer to drop
// its key and re-send what is still in flight. Keys live in links.key
// (mode 600) next to node.key and are never logged; outbox items and
// relay.json only record a key's random id.

import (
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"time"
)

const (
	linkLabel    = "argo-link-1"
	linkKeyLen   = 32
	linkIDLen    = 8
	linkKeyLife  = 7 * 24 * time.Hour // a sender stops using a key after this...
	linkKeyUses  = 1 << 16            // ...or this many bundles (random 96-bit IVs allow 2^32 per key)
	linkOfferTTL = 3 * 24 * time.Hour // an offer not confirmed by then is replaced
	maxRxKeys    = 16                 // a peer's keys kept for bundles still in flight
	maxOfferHave = 16
)

func linkPath() string { return filepath.Join(configDir(), "links.key") }

// linkKey is one direction's key. Key is secret: never log or print it.
type linkKey struct {
	ID        string    `json:"id"` // random, hex; safe to show
	Key       []byte    `json:"key"`
	Created   time.Time `json:"created"`            // by the sender's clock
	Offer     string    `json:"offer,omitempty"`    // sender only: the bundle that delivers it
	Confirmed time.Time `json:"confirmed,omitzero"` // sender only: when the peer's receipt came back
	sub       map[string][]byte
}

// linkFile is links.key.
type linkFile struct {
	Tx map[string]*linkKey   `json:"tx"` // peer → the key this device sends with
	Rx map[string][]*linkKey `json:"rx"` // peer → the keys it sends with, newest first
}

func newLinkKey(now time.Time) (*linkKey, error) {
	id, key := make([]byte, linkIDLen), make([]byte, linkKeyLen)
	if _, err := rand.Read(id); err != nil {
		return nil, err
	}
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	return &linkKey{ID: hex.EncodeToString(id), Key: key, Created: now}, nil
}

// subKey derives the key for one context ("bib" or "bcb") and direction, so
// no two uses share a key.
func (k *linkKey) subKey(purpose, from, to string) ([]byte, error) {
	if len(k.Key) != linkKeyLen {
		return nil, errors.New("link key: bad length")
	}
	info := linkLabel + " " + purpose + " " + from + ">" + to
	if s, ok := k.sub[info]; ok {
		return s, nil
	}
	s, err := hkdf.Key(sha256.New, k.Key, nil, info, 32)
	if err != nil {
		return nil, err
	}
	if k.sub == nil {
		k.sub = map[string][]byte{}
	}
	k.sub[info] = s
	return s, nil
}

// covers says whether a bundle created at t may carry k: a sender uses a
// key for linkKeyLife from its creation.
func (k *linkKey) covers(t time.Time) bool {
	return !t.Before(k.Created.Add(-clockSkew)) && !t.After(k.Created.Add(linkKeyLife+clockSkew))
}

// linkProtect adds RFC 9173 blocks under k to a bundle that has none yet.
// seal also encrypts the payload (file chunks); without it the payload is
// only integrity-protected (receipts).
func linkProtect(b *Bundle, k *linkKey, seal bool) error {
	if len(b.Blocks) != 1 {
		return errors.New("link keys protect a bundle with no other blocks")
	}
	from, to := b.Source.NodeName(), b.Dest.NodeName()
	mac, err := k.subKey("bib", from, to)
	if err != nil {
		return err
	}
	targets := []uint64{0}
	if !seal {
		targets = append(targets, 1)
	}
	if _, err := addBIB(b, BIBConfig{Source: b.Source.Node(), Targets: targets, Variant: hmacSHA256, Scope: scopeAll, Key: mac}); err != nil {
		return err
	}
	if !seal {
		return nil
	}
	enc, err := k.subKey("bcb", from, to)
	if err != nil {
		return err
	}
	_, err = addBCB(b, BCBConfig{Source: b.Source.Node(), Targets: []uint64{1}, Variant: aesA256GCM, Scope: scopeAll, Key: enc})
	return err
}

var errNoLinkKey = errors.New("no link key from this sender matches")

// linkOpen checks and removes the RFC 9173 blocks that linkProtect added,
// trying the sender's keys whose lifetime covers the bundle's creation time,
// newest first, and returns the key that matched. Anything but the exact
// layout and parameters linkProtect uses is refused. The bundle is only
// changed once everything checked.
func linkOpen(b *Bundle, keys []*linkKey, sealed bool) (*linkKey, error) {
	shape := errors.New("link-protected bundle: unexpected security blocks")
	bibTargets, want := []uint64{0, 1}, 2
	if sealed {
		bibTargets, want = []uint64{0}, 3
	}
	bib, bcb := b.BlockOfType(blockBIB), b.BlockOfType(blockBCB)
	if len(b.Blocks) != want || bib == nil || (bcb != nil) != sealed {
		return nil, shape
	}
	bibNum, bcbNum := bib.Num, uint64(0)
	a, err := decodeSecBlock(bib.Data)
	if err != nil {
		return nil, err
	}
	hp, err := parseHMACParams(a.Params)
	if err != nil || a.Context != ctxBIBHMACSHA2 || a.Source != b.Source.Node() || !slices.Equal(a.Targets, bibTargets) ||
		hp.Variant != hmacSHA256 || hp.Scope != scopeAll || hp.HasWrapped {
		return nil, shape
	}
	if sealed {
		bcbNum = bcb.Num
		c, err := decodeSecBlock(bcb.Data)
		if err != nil {
			return nil, err
		}
		gp, err := parseGCMParams(c.Params)
		if err != nil || c.Context != ctxBCBAESGCM || c.Source != b.Source.Node() || !slices.Equal(c.Targets, []uint64{1}) ||
			gp.Variant != aesA256GCM || gp.Scope != scopeAll || gp.HasWrapped {
			return nil, shape
		}
	}
	from, to := b.Source.NodeName(), b.Dest.NodeName()
	created := fromDTNTime(b.Created)
	for _, k := range keys {
		if !k.covers(created) {
			continue
		}
		mac, err := k.subKey("bib", from, to)
		if err != nil {
			return nil, err
		}
		if _, err := checkBIB(b, bibNum, SecKeys{Key: mac}); err != nil {
			continue // another of the sender's keys
		}
		if sealed {
			enc, err := k.subKey("bcb", from, to)
			if err != nil {
				return nil, err
			}
			if err := openBCB(b, bcbNum, SecKeys{Key: enc}); err != nil {
				return nil, err // the right key, so the bundle was altered
			}
		}
		b.removeBlock(bibNum)
		return k, nil
	}
	return nil, errNoLinkKey
}

// linkOffer delivers a link key; it always travels signed and sealed.
type linkOffer struct {
	ID      []byte
	Key     []byte
	Created uint64   // DTN time, the sender's clock
	Have    [][]byte // ids of the recipient's keys the offering device holds
}

func (o linkOffer) encode() []byte {
	var e cborEnc
	e.array(6)
	e.uint(1)
	e.text("link-key")
	e.bytes(o.ID)
	e.bytes(o.Key)
	e.uint(o.Created)
	e.array(len(o.Have))
	for _, id := range o.Have {
		e.bytes(id)
	}
	return e.b
}

func decodeLinkOffer(p []byte) (linkOffer, error) {
	var o linkOffer
	bad := errors.New("payload: not an Argo link key")
	d := cborDec{b: p}
	if n, err := d.array(); err != nil || n != 6 {
		return o, bad
	}
	if v, err := d.uint(); err != nil || v != 1 {
		return o, bad
	}
	if k, err := d.text(); err != nil || k != "link-key" {
		return o, bad
	}
	var err error
	if o.ID, err = d.bytes(); err != nil || len(o.ID) != linkIDLen {
		return o, bad
	}
	if o.Key, err = d.bytes(); err != nil || len(o.Key) != linkKeyLen {
		return o, bad
	}
	if o.Created, err = d.uint(); err != nil {
		return o, bad
	}
	n, err := d.array()
	if err != nil || n > maxOfferHave {
		return o, bad
	}
	for range n {
		id, err := d.bytes()
		if err != nil || len(id) != linkIDLen {
			return o, bad
		}
		o.Have = append(o.Have, id)
	}
	if !d.done() {
		return o, bad
	}
	return o, nil
}

// ---- the relay's side ----

// txLink returns the confirmed, unexpired key for bundles to device and
// counts the use, or nil: the bundle then gets argo-sig + argo-seal.
func (r *Relay) txLink(st *relayState, device string, now time.Time) *linkKey {
	if st.links == nil {
		return nil
	}
	k := st.links.Tx[device]
	if k == nil || k.Confirmed.IsZero() || now.After(k.Created.Add(linkKeyLife)) || st.LinkUses[k.ID] >= linkKeyUses {
		return nil
	}
	st.LinkUses[k.ID]++
	return k
}

// ensureLink offers device a new key when there is none, the current one is
// worn out, an offer went unanswered, or (force) the peer sent a bundle under
// a key this device doesn't hold. A pending offer is never replaced early.
func (r *Relay) ensureLink(st *relayState, device string, to PeerKey, now time.Time, force bool) {
	if st.links == nil {
		return
	}
	old := st.links.Tx[device]
	switch {
	case old == nil:
	case old.Confirmed.IsZero():
		if now.Before(old.Created.Add(linkOfferTTL)) {
			return // an offer is on its way
		}
	case !force && now.Before(old.Created.Add(linkKeyLife)) && st.LinkUses[old.ID] < linkKeyUses:
		return
	}
	k, err := newLinkKey(now)
	if err != nil {
		return
	}
	id, _ := hex.DecodeString(k.ID)
	o := linkOffer{ID: id, Key: k.Key, Created: dtnTime(now)}
	for _, rk := range st.links.Rx[device] {
		if len(o.Have) < maxOfferHave {
			h, _ := hex.DecodeString(rk.ID)
			o.Have = append(o.Have, h)
		}
	}
	item, raw, err := r.newBundle(st, device, serviceArgo, o.encode(), linkOfferTTL, now, &to, false, false)
	if err != nil || writeFileAtomic(r.outPath(item.Key), raw) != nil {
		return
	}
	item.Offer, k.Offer = k.ID, item.Key
	if old != nil {
		delete(st.LinkUses, old.ID)
	}
	st.links.Tx[device] = k
	st.Out[item.Key] = item
}

// confirmLink starts using an offered key once the peer's receipt for the
// offer arrives.
func (r *Relay) confirmLink(st *relayState, it *outItem, now time.Time) {
	if st.links == nil || it.Offer == "" {
		return
	}
	if k := st.links.Tx[it.Dest]; k != nil && k.ID == it.Offer && k.Offer == it.Key && k.Confirmed.IsZero() {
		k.Confirmed = now
	}
}

// acceptOffer stores a key a peer will send with. The offer's list of this
// device's keys the peer holds is checked against the key in use: if the
// peer made the offer after confirming that key and no longer has it (it
// lost links.key), the key is dropped and what is in flight goes again.
func (r *Relay) acceptOffer(st *relayState, from string, b *Bundle, now time.Time) error {
	if st.links == nil {
		return errors.New("link keys are off on this device")
	}
	o, err := decodeLinkOffer(b.Payload())
	if err != nil {
		return err
	}
	created := fromDTNTime(o.Created)
	if created.After(now.Add(clockSkew)) || created.After(fromDTNTime(b.Created).Add(clockSkew)) {
		return errors.New("link key from the future")
	}
	id := hex.EncodeToString(o.ID)
	rx := st.links.Rx[from]
	if !slices.ContainsFunc(rx, func(k *linkKey) bool { return k.ID == id }) {
		rx = append(rx, &linkKey{ID: id, Key: o.Key, Created: created})
	}
	slices.SortStableFunc(rx, func(x, y *linkKey) int { return y.Created.Compare(x.Created) })
	if len(rx) > maxRxKeys {
		rx = rx[:maxRxKeys]
	}
	st.links.Rx[from] = rx
	st.pruneLinks(now)
	if k := st.links.Tx[from]; k != nil && !k.Confirmed.IsZero() && fromDTNTime(b.Created).After(k.Confirmed.Add(clockSkew)) &&
		!slices.ContainsFunc(o.Have, func(h []byte) bool { return hex.EncodeToString(h) == k.ID }) {
		r.dropLink(st, from, now)
	}
	return nil
}

// dropLink stops using this device's key for device. Receipts sent under it
// are dropped (a duplicate brings a signed one); file chunks still in flight
// are opened with it and queued again as new bundles with argo-sig +
// argo-seal, since the hub keeps the old IDs as delivered.
func (r *Relay) dropLink(st *relayState, device string, now time.Time) {
	k := st.links.Tx[device]
	if k == nil {
		return
	}
	delete(st.links.Tx, device)
	delete(st.LinkUses, k.ID)
	var redo []*outItem
	for _, it := range st.Out {
		if it.LinkKey == k.ID && it.Dest == device && (it.State == stateQueued || it.State == stateAtHub || it.State == statePickedUp) {
			redo = append(redo, it)
		}
	}
	to, pinned := st.Pins[device]
	for _, it := range redo {
		path := r.outPath(it.Key)
		if it.Receipt {
			delete(st.Out, it.Key)
			_ = os.Remove(path)
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil || !pinned {
			continue // it expires as before
		}
		b, err := ParseBundle(raw)
		if err != nil {
			continue
		}
		if _, err := linkOpen(b, []*linkKey{k}, true); err != nil {
			continue
		}
		ttl := it.Expires.Sub(now)
		if ttl <= 0 {
			continue
		}
		item, raw, err := r.newBundle(st, device, serviceFiles, b.Payload(), ttl, now, &to, false, false)
		if err != nil || writeFileAtomic(r.outPath(item.Key), raw) != nil {
			continue
		}
		item.Name, item.Transfer, item.Chunk, item.Chunks = it.Name, it.Transfer, it.Chunk, it.Chunks
		st.Out[item.Key] = item
		delete(st.Out, it.Key)
		_ = os.Remove(path)
	}
}

// pruneLinks drops receive keys no bundle still alive can carry: used for
// linkKeyLife, plus the longest bundle lifetime.
func (st *relayState) pruneLinks(now time.Time) {
	if st.links == nil {
		return
	}
	for peer, rx := range st.links.Rx {
		rx = slices.DeleteFunc(rx, func(k *linkKey) bool { return now.After(k.Created.Add(linkKeyLife + maxTTL + clockSkew)) })
		if len(rx) == 0 {
			delete(st.links.Rx, peer)
		} else {
			st.links.Rx[peer] = rx
		}
	}
}

// forgetLinks drops both directions' keys for a device whose node key
// changed (re-enrolled): they were agreed with its old identity.
func (st *relayState) forgetLinks(device string) {
	if st.links == nil {
		return
	}
	if k := st.links.Tx[device]; k != nil {
		delete(st.LinkUses, k.ID)
	}
	delete(st.links.Tx, device)
	delete(st.links.Rx, device)
}
