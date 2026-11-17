package main

// End-to-end bundle security, laid out like BPSec (RFC 9172) but carried in
// RFC 9171's private block types, because RFC 9172 has no private range for
// security context IDs and HPKE is not a standard BPSec context yet:
//
//   - Integrity block (type 192, "argo-sig-1"): an Ed25519 (RFC 8032)
//     signature by the source node over the primary block and the plaintext
//     payload.
//   - Confidentiality block (type 193, "argo-seal-1"): HPKE (RFC 9180) with
//     ML-KEM-768 + X25519 (post-quantum hybrid), HKDF-SHA256 and AES-256-GCM.
//     It encrypts the payload and the integrity block (sign, then encrypt,
//     as RFC 9172 §3.8 requires when both target the payload).
//
// Both use BPSec's Abstract Security Block field order (targets, context ID,
// flags, source, parameters, results), so they can move to BPSec-COSE once
// COSE-HPKE is an RFC. Only standard library primitives are used.

import (
	"crypto/ed25519"
	"crypto/hpke"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	argoCtx     = 1 // context ID inside Argo's private block types
	paramSuite  = 1
	paramEnc    = 2
	resultSig   = 1
	sigLabel    = "argo-sig-1"
	sealLabel   = "argo-seal-1"
	asbParamsOn = 1
)

var (
	sealKEM  = hpke.MLKEM768X25519()
	sealKDF  = hpke.HKDFSHA256()
	sealAEAD = hpke.AES256GCM()
)

// NodeKeys is this device's identity. It never leaves the device.
type NodeKeys struct {
	Name string
	Sign ed25519.PrivateKey
	KEM  hpke.PrivateKey
}

// PeerKey is a device's public identity, as published in the Gauss directory.
type PeerKey struct {
	Node  string `json:"node"`
	Sign  []byte `json:"sign"`
	KEMID uint16 `json:"kem_id"`
	KEM   []byte `json:"kem"`
}

func (k NodeKeys) Public() PeerKey {
	return PeerKey{Node: k.Name, Sign: k.Sign.Public().(ed25519.PublicKey), KEMID: sealKEM.ID(), KEM: k.KEM.PublicKey().Bytes()}
}

// Fingerprint is a short code people compare out of band (like a safety
// number): SHA-256 over both public keys, first 10 bytes in groups of four.
func (k PeerKey) Fingerprint() string {
	var e cborEnc
	e.array(3)
	e.bytes(k.Sign)
	e.uint(uint64(k.KEMID))
	e.bytes(k.KEM)
	h := sha256.Sum256(e.b)
	s := strings.ToUpper(hex.EncodeToString(h[:10]))
	var g []string
	for i := 0; i < len(s); i += 4 {
		g = append(g, s[i:i+4])
	}
	return strings.Join(g, " ")
}

func (k PeerKey) valid() error {
	if len(k.Sign) != ed25519.PublicKeySize {
		return errors.New("bad signing key")
	}
	if k.KEMID != sealKEM.ID() {
		return fmt.Errorf("unsupported KEM %#x", k.KEMID)
	}
	if _, err := sealKEM.NewPublicKey(k.KEM); err != nil {
		return errors.New("bad encryption key")
	}
	return nil
}

type keyFile struct {
	SignSeed string `json:"sign_seed"`
	KEMID    uint16 `json:"kem_id"`
	KEM      string `json:"kem"`
}

func keyPath() string { return filepath.Join(configDir(), "node.key") }

// loadOrCreateKeys reads the node key file, creating it (0600) the first time.
func loadOrCreateKeys(path, name string) (NodeKeys, bool, error) {
	if b, err := os.ReadFile(path); err == nil {
		k, err := parseKeys(b, name)
		return k, false, err
	} else if !errors.Is(err, os.ErrNotExist) {
		return NodeKeys{}, false, err
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := rand.Read(seed); err != nil {
		return NodeKeys{}, false, err
	}
	kp, err := sealKEM.GenerateKey()
	if err != nil {
		return NodeKeys{}, false, err
	}
	kb, err := kp.Bytes()
	if err != nil {
		return NodeKeys{}, false, err
	}
	raw, _ := json.Marshal(keyFile{SignSeed: base64.StdEncoding.EncodeToString(seed), KEMID: sealKEM.ID(), KEM: base64.StdEncoding.EncodeToString(kb)})
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return NodeKeys{}, false, err
	}
	// O_EXCL: two processes racing to create keys must not overwrite each other.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return loadOrCreateKeys(path, name)
		}
		return NodeKeys{}, false, err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return NodeKeys{}, false, err
	}
	if err := f.Close(); err != nil {
		return NodeKeys{}, false, err
	}
	k, err := parseKeys(raw, name)
	return k, true, err
}

func parseKeys(b []byte, name string) (NodeKeys, error) {
	var kf keyFile
	if err := json.Unmarshal(b, &kf); err != nil {
		return NodeKeys{}, errors.New("node key file is unreadable")
	}
	seed, err := base64.StdEncoding.DecodeString(kf.SignSeed)
	if err != nil || len(seed) != ed25519.SeedSize {
		return NodeKeys{}, errors.New("node key file: bad signing key")
	}
	if kf.KEMID != sealKEM.ID() {
		return NodeKeys{}, fmt.Errorf("node key file: unsupported KEM %#x", kf.KEMID)
	}
	kb, err := base64.StdEncoding.DecodeString(kf.KEM)
	if err != nil {
		return NodeKeys{}, errors.New("node key file: bad encryption key")
	}
	kp, err := sealKEM.NewPrivateKey(kb)
	if err != nil {
		return NodeKeys{}, errors.New("node key file: bad encryption key")
	}
	return NodeKeys{Name: name, Sign: ed25519.NewKeyFromSeed(seed), KEM: kp}, nil
}

// asb is an Abstract Security Block (RFC 9172 §3.6), encoded as a CBOR array.
type asb struct {
	Targets []uint64
	Source  EID
	Params  map[int64][]byte // Argo's parameters are byte strings
	Results [][]asbResult
}

type asbResult struct {
	ID    int64
	Value []byte
}

func (a asb) encode() ([]byte, error) {
	var e cborEnc
	n := 5
	if len(a.Params) > 0 {
		n = 6
	}
	e.array(n)
	e.array(len(a.Targets))
	for _, t := range a.Targets {
		e.uint(t)
	}
	e.int(argoCtx)
	if len(a.Params) > 0 {
		e.uint(asbParamsOn)
	} else {
		e.uint(0)
	}
	if err := encodeEID(&e, a.Source); err != nil {
		return nil, err
	}
	if len(a.Params) > 0 {
		e.array(len(a.Params))
		for _, id := range []int64{paramSuite, paramEnc} { // fixed order: deterministic
			if v, ok := a.Params[id]; ok {
				e.array(2)
				e.int(id)
				e.bytes(v)
			}
		}
	}
	e.array(len(a.Results))
	for _, rs := range a.Results {
		e.array(len(rs))
		for _, r := range rs {
			e.array(2)
			e.int(r.ID)
			e.bytes(r.Value)
		}
	}
	return e.b, nil
}

func decodeASB(p []byte) (asb, error) {
	var a asb
	bad := errors.New("security block: malformed")
	d := cborDec{b: p}
	n, err := d.array()
	if err != nil || (n != 5 && n != 6) {
		return a, bad
	}
	nt, err := d.array()
	if err != nil || nt < 1 || nt > maxBundleBlocks {
		return a, bad
	}
	for range nt {
		t, err := d.uint()
		if err != nil {
			return a, bad
		}
		a.Targets = append(a.Targets, t)
	}
	if ctx, err := d.int(); err != nil || ctx != argoCtx {
		return a, errors.New("security block: unknown context")
	}
	flags, err := d.uint()
	if err != nil || (flags&asbParamsOn != 0) != (n == 6) {
		return a, bad
	}
	if a.Source, err = decodeEID(&d); err != nil {
		return a, bad
	}
	if n == 6 {
		np, err := d.array()
		if err != nil || np > 8 {
			return a, bad
		}
		a.Params = map[int64][]byte{}
		for range np {
			if k, err := d.array(); err != nil || k != 2 {
				return a, bad
			}
			id, err := d.int()
			if err != nil {
				return a, bad
			}
			if a.Params[id], err = d.bytes(); err != nil {
				return a, bad
			}
		}
	}
	nr, err := d.array()
	if err != nil || nr != len(a.Targets) {
		return a, bad
	}
	for range nr {
		k, err := d.array()
		if err != nil || k > 4 {
			return a, bad
		}
		var rs []asbResult
		for range k {
			if m, err := d.array(); err != nil || m != 2 {
				return a, bad
			}
			id, err := d.int()
			if err != nil {
				return a, bad
			}
			v, err := d.bytes()
			if err != nil {
				return a, bad
			}
			rs = append(rs, asbResult{ID: id, Value: v})
		}
		a.Results = append(a.Results, rs)
	}
	if !d.done() {
		return a, bad
	}
	return a, nil
}

func sigInput(p Primary, t Block) ([]byte, error) {
	pb, err := p.encode()
	if err != nil {
		return nil, err
	}
	var e cborEnc
	e.array(6)
	e.text(sigLabel)
	e.bytes(pb)
	e.uint(t.Type)
	e.uint(t.Num)
	e.uint(t.Flags)
	e.bytes(t.Data)
	return e.b, nil
}

// signBundle adds an integrity block over the payload, signed by k.
func signBundle(b *Bundle, k NodeKeys) error {
	if b.BlockOfType(blockArgoSig) != nil || b.BlockOfType(blockArgoSeal) != nil {
		return errors.New("bundle is already signed or sealed")
	}
	if b.Source.Node() != nodeEID(k.Name) {
		return errors.New("only the source node signs its bundles")
	}
	payload := b.Blocks[len(b.Blocks)-1]
	in, err := sigInput(b.Primary, payload)
	if err != nil {
		return err
	}
	data, err := asb{Targets: []uint64{payload.Num}, Source: b.Source.Node(),
		Results: [][]asbResult{{{ID: resultSig, Value: ed25519.Sign(k.Sign, in)}}}}.encode()
	if err != nil {
		return err
	}
	blk := Block{Type: blockArgoSig, Num: b.nextBlockNum(), CRCType: crc32C, Data: data}
	b.Blocks = append(b.Blocks[:len(b.Blocks)-1], blk, payload)
	return nil
}

// verifyBundle checks the integrity block against the sender's pinned key
// and removes it. A bundle without one is refused.
func verifyBundle(b *Bundle, from PeerKey) error {
	blk := b.BlockOfType(blockArgoSig)
	if blk == nil {
		return errors.New("bundle is not signed")
	}
	a, err := decodeASB(blk.Data)
	if err != nil {
		return err
	}
	if a.Source != b.Source.Node() || a.Source != nodeEID(from.Node) {
		return errors.New("signature source does not match the bundle source")
	}
	payload := b.Blocks[len(b.Blocks)-1]
	if len(a.Targets) != 1 || a.Targets[0] != payload.Num || len(a.Results[0]) != 1 || a.Results[0][0].ID != resultSig {
		return errors.New("signature does not cover the payload")
	}
	in, err := sigInput(b.Primary, payload)
	if err != nil {
		return err
	}
	if !ed25519.Verify(ed25519.PublicKey(from.Sign), in, a.Results[0][0].Value) {
		return errors.New("bad signature")
	}
	b.removeBlock(blk.Num)
	return nil
}

func sealInfo(p Primary) ([]byte, error) {
	pb, err := p.encode()
	if err != nil {
		return nil, err
	}
	var e cborEnc
	e.array(2)
	e.text(sealLabel)
	e.bytes(pb)
	return e.b, nil
}

func blockAAD(t Block) []byte {
	var e cborEnc
	e.array(3)
	e.uint(t.Type)
	e.uint(t.Num)
	e.uint(t.Flags)
	return e.b
}

func suiteBytes() []byte {
	var e cborEnc
	e.array(3)
	e.uint(uint64(sealKEM.ID()))
	e.uint(uint64(sealKDF.ID()))
	e.uint(uint64(sealAEAD.ID()))
	return e.b
}

// sealBundle encrypts the payload and the integrity block to the
// destination's public key. Call it after signBundle.
func sealBundle(b *Bundle, to PeerKey) error {
	if err := to.valid(); err != nil {
		return err
	}
	if b.Dest.Node() != nodeEID(to.Node) {
		return errors.New("sealing to a key that is not the destination's")
	}
	sig := b.BlockOfType(blockArgoSig)
	if sig == nil {
		return errors.New("sign before sealing")
	}
	pk, err := sealKEM.NewPublicKey(to.KEM)
	if err != nil {
		return err
	}
	info, err := sealInfo(b.Primary)
	if err != nil {
		return err
	}
	enc, s, err := hpke.NewSender(pk, sealKDF, sealAEAD, info)
	if err != nil {
		return err
	}
	payload := &b.Blocks[len(b.Blocks)-1]
	targets := []*Block{payload, sig}
	for _, t := range targets {
		ct, err := s.Seal(blockAAD(*t), t.Data)
		if err != nil {
			return err
		}
		t.Data = ct
	}
	data, err := asb{Targets: []uint64{payload.Num, sig.Num}, Source: b.Source.Node(),
		Params:  map[int64][]byte{paramSuite: suiteBytes(), paramEnc: enc},
		Results: [][]asbResult{{}, {}}}.encode()
	if err != nil {
		return err
	}
	blk := Block{Type: blockArgoSeal, Num: b.nextBlockNum(), CRCType: crc32C, Data: data}
	p := b.Blocks[len(b.Blocks)-1]
	b.Blocks = append(b.Blocks[:len(b.Blocks)-1], blk, p)
	return nil
}

// openBundle decrypts the confidentiality block's targets with k and removes
// it. A bundle without one is refused.
func openBundle(b *Bundle, k NodeKeys) error {
	blk := b.BlockOfType(blockArgoSeal)
	if blk == nil {
		return errors.New("bundle is not encrypted")
	}
	if b.Dest.Node() != nodeEID(k.Name) {
		return errors.New("bundle is not addressed to this device")
	}
	a, err := decodeASB(blk.Data)
	if err != nil {
		return err
	}
	if string(a.Params[paramSuite]) != string(suiteBytes()) {
		return errors.New("unsupported cipher suite")
	}
	if a.Source != b.Source.Node() {
		return errors.New("encryption source does not match the bundle source")
	}
	info, err := sealInfo(b.Primary)
	if err != nil {
		return err
	}
	r, err := hpke.NewRecipient(a.Params[paramEnc], k.KEM, sealKDF, sealAEAD, info)
	if err != nil {
		return errors.New("cannot decrypt: bad encapsulated key")
	}
	payloadNum := b.Blocks[len(b.Blocks)-1].Num
	if len(a.Targets) == 0 || a.Targets[0] != payloadNum {
		return errors.New("encryption does not cover the payload")
	}
	plain := make([][]byte, len(a.Targets))
	for i, num := range a.Targets {
		t := b.Block(num)
		if t == nil || t.Type == blockArgoSeal {
			return errors.New("encryption target missing")
		}
		if plain[i], err = r.Open(blockAAD(*t), t.Data); err != nil {
			return errors.New("cannot decrypt: wrong key or altered bundle")
		}
	}
	for i, num := range a.Targets { // only change the bundle once every target opened
		b.Block(num).Data = plain[i]
	}
	b.removeBlock(blk.Num)
	return nil
}
