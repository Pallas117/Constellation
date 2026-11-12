package main

// RFC 9173's default security contexts for BPSec (RFC 9172), so Argo can
// exchange bundles with standard BPv7 nodes (NASA HDTN, dtn7-rs, ION) that
// use pre-placed symmetric keys (GAU-199):
//
//   - BIB-HMAC-SHA2 (security context 1) in a Block Integrity Block (type 11);
//   - BCB-AES-GCM (security context 2) in a Block Confidentiality Block (type 12).
//
// Argo's own blocks 192/193 (bpsec.go) are unchanged and still carry the
// relay's end-to-end security. Their Abstract Security Block is one CBOR
// array; RFC 9172 §3.6 instead lists the ASB fields in order with nothing
// around them, so here the block-type-specific data is a CBOR sequence
// (RFC 8742), which is how every RFC 9173 Appendix A example encodes it.
//
// Keys always come from the caller (local policy, RFC 9173 §3.5 and §4.5):
// nothing here creates, stores or logs key material. Where the published
// examples and the text disagree, the code follows what implementations
// interoperate on and says so ("Interop:"); where Argo is stricter or looser
// than the text it says so ("Policy:").

import (
	"cmp"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"errors"
	"fmt"
	"hash"
	"slices"
)

const (
	blockBIB = 11 // RFC 9172 §11.1
	blockBCB = 12

	ctxBIBHMACSHA2 = 1 // RFC 9173 §5.1
	ctxBCBAESGCM   = 2

	asbParamsPresent = 0x01 // RFC 9172 §3.6: security context flags, bit 0

	// BIB-HMAC-SHA2 parameter ids (RFC 9173 §3.3.4), result id (§3.4) and
	// SHA variants (§3.3.1).
	bibParamSHA     = 1
	bibParamWrapped = 2
	bibParamScope   = 3
	bibResultMAC    = 1
	hmacSHA256      = 5
	hmacSHA384      = 6 // the RFC default
	hmacSHA512      = 7

	// BCB-AES-GCM parameter ids (RFC 9173 §4.3.5), result id (§4.4.2) and
	// AES variants (§4.3.2).
	bcbParamIV      = 1
	bcbParamAES     = 2
	bcbParamWrapped = 3
	bcbParamScope   = 4
	bcbResultTag    = 1
	aesA128GCM      = 1
	aesA256GCM      = 3 // the RFC default

	// Scope flags, the same bits in both contexts (RFC 9173 §3.3.3, §4.3.4).
	scopePrimary  = 0x1
	scopeTarget   = 0x2
	scopeSecurity = 0x4
	scopeAll      = scopePrimary | scopeTarget | scopeSecurity // the RFC default
	scopeMax      = 0xffff                                     // a 16-bit field

	// Block processing control flags (RFC 9171 §4.2.4).
	blkReplicate = 0x01
	blkDiscard   = 0x10
	blkAssigned  = 0x17 // bits 0, 1, 2 and 4; RFC 9172 §4 zeroes the rest in canonical forms

	bcbTagLen     = 16 // RFC 9173 §4.3.2: always 128 bits
	bcbIVLen      = 12 // RFC 9173 §4.3.1: SHOULD be 12 bytes
	bcbIVMin      = 8
	bcbIVMax      = 16
	hmacKeyMin    = 16 // Policy: see hmacKeyOK
	maxSecParams  = 8
	maxSecResults = 4
)

// secItem is one security context parameter or result: an id and the CBOR
// encoding of its value, whose type each context defines (RFC 9172 §3.10).
type secItem struct {
	ID    uint64
	Value []byte
}

func uintItem(id, v uint64) secItem {
	var e cborEnc
	e.uint(v)
	return secItem{ID: id, Value: e.b}
}

func bytesItem(id uint64, p []byte) secItem {
	var e cborEnc
	e.bytes(p)
	return secItem{ID: id, Value: e.b}
}

func (it secItem) uint() (uint64, error) {
	d := cborDec{b: it.Value}
	v, err := d.uint()
	if err != nil || !d.done() {
		return 0, fmt.Errorf("security block: item %d is not an unsigned integer", it.ID)
	}
	return v, nil
}

func (it secItem) bytes() ([]byte, error) {
	d := cborDec{b: it.Value}
	v, err := d.bytes()
	if err != nil || !d.done() {
		return nil, fmt.Errorf("security block: item %d is not a byte string", it.ID)
	}
	return v, nil
}

// secBlock is the Abstract Security Block of a BIB or BCB (RFC 9172 §3.6).
type secBlock struct {
	Targets []uint64
	Context uint64
	Source  EID
	Params  []secItem   // empty: the optional parameters field is absent
	Results [][]secItem // one list per target, in target order
}

// encode writes the ASB as a CBOR sequence: targets, context id, flags,
// source, parameters (only when there are some), results.
func (a secBlock) encode() ([]byte, error) {
	if len(a.Targets) == 0 || len(a.Results) != len(a.Targets) {
		return nil, errors.New("security block: needs one result list per target")
	}
	var e cborEnc
	e.array(len(a.Targets))
	for _, t := range a.Targets {
		e.uint(t)
	}
	e.uint(a.Context)
	if len(a.Params) > 0 {
		e.uint(asbParamsPresent)
	} else {
		e.uint(0) // reserved bits are written as 0
	}
	if err := encodeEID(&e, a.Source); err != nil {
		return nil, err
	}
	if len(a.Params) > 0 {
		e.array(len(a.Params))
		for _, p := range a.Params {
			e.array(2)
			e.uint(p.ID)
			e.raw(p.Value)
		}
	}
	e.array(len(a.Results))
	for _, rs := range a.Results {
		e.array(len(rs))
		for _, r := range rs {
			e.array(2)
			e.uint(r.ID)
			e.raw(r.Value)
		}
	}
	return e.b, nil
}

var errSecBlock = errors.New("security block: malformed")

// decodeSecBlock reads an ASB within fixed limits: 1 to 16 distinct targets,
// at most 8 distinct parameters, one result list per target with at most 4
// results each, and nothing after the results.
func decodeSecBlock(p []byte) (secBlock, error) {
	var a secBlock
	d := cborDec{b: p}
	nt, err := d.array()
	if err != nil || nt < 1 || nt > maxBundleBlocks {
		return a, errSecBlock
	}
	for range nt {
		t, err := d.uint()
		if err != nil || slices.Contains(a.Targets, t) {
			return a, errSecBlock
		}
		a.Targets = append(a.Targets, t)
	}
	if a.Context, err = d.uint(); err != nil {
		return a, errSecBlock
	}
	flags, err := d.uint()
	if err != nil {
		return a, errSecBlock
	}
	if a.Source, err = decodeEID(&d); err != nil {
		return a, errSecBlock
	}
	if flags&asbParamsPresent != 0 { // reserved bits are ignored (§3.6)
		np, err := d.array()
		if err != nil || np < 1 || np > maxSecParams {
			return a, errSecBlock
		}
		for range np {
			it, err := decodeSecItem(&d)
			if err != nil || slices.ContainsFunc(a.Params, func(x secItem) bool { return x.ID == it.ID }) {
				return a, errSecBlock
			}
			a.Params = append(a.Params, it)
		}
	}
	nr, err := d.array()
	if err != nil || nr != nt {
		return a, errSecBlock
	}
	for range nr {
		k, err := d.array()
		if err != nil || k > maxSecResults {
			return a, errSecBlock
		}
		rs := []secItem{}
		for range k {
			it, err := decodeSecItem(&d)
			if err != nil {
				return a, errSecBlock
			}
			rs = append(rs, it)
		}
		a.Results = append(a.Results, rs)
	}
	if !d.done() {
		return a, errSecBlock
	}
	return a, nil
}

func decodeSecItem(d *cborDec) (secItem, error) {
	if n, err := d.array(); err != nil || n != 2 {
		return secItem{}, errSecBlock
	}
	id, err := d.uint()
	if err != nil {
		return secItem{}, errSecBlock
	}
	v, err := d.item()
	if err != nil {
		return secItem{}, errSecBlock
	}
	return secItem{ID: id, Value: append([]byte(nil), v...)}, nil
}

// hmacParams are a BIB-HMAC-SHA2 block's parameters, defaults applied.
type hmacParams struct {
	Variant    uint64
	Scope      uint64
	Wrapped    []byte
	HasWrapped bool
}

func parseHMACParams(items []secItem) (hmacParams, error) {
	p := hmacParams{Variant: hmacSHA384, Scope: scopeAll}
	var err error
	for _, it := range items {
		switch it.ID {
		case bibParamSHA:
			p.Variant, err = it.uint()
			if err == nil && hmacHash(p.Variant) == nil {
				err = fmt.Errorf("BIB-HMAC-SHA2: unsupported SHA variant %d", p.Variant)
			}
		case bibParamWrapped:
			p.Wrapped, err = it.bytes()
			p.HasWrapped = true
		case bibParamScope:
			p.Scope, err = it.uint()
			if err == nil && p.Scope > scopeMax {
				err = errors.New("BIB-HMAC-SHA2: scope flags exceed 16 bits")
			}
		default:
			err = fmt.Errorf("BIB-HMAC-SHA2: unknown parameter %d", it.ID)
		}
		if err != nil {
			return p, err
		}
	}
	return p, nil
}

func hmacHash(variant uint64) func() hash.Hash {
	switch variant {
	case hmacSHA256:
		return sha256.New
	case hmacSHA384:
		return sha512.New384
	case hmacSHA512:
		return sha512.New
	}
	return nil
}

// hmacKeyOK checks an HMAC key's length. Policy: RFC 9173 §3.5 says the key
// length MUST equal the HMAC output, but every Appendix A example uses a
// 16-byte key (with HMAC 256, 384 and 512 alike), so Argo accepts 16 bytes
// up to the output size, in whole 64-bit words so AES key wrap can carry it.
func hmacKeyOK(h func() hash.Hash, key []byte) error {
	if len(key) < hmacKeyMin || len(key) > h().Size() || len(key)%8 != 0 {
		return fmt.Errorf("BIB-HMAC-SHA2: a %d-byte key does not suit this SHA variant", len(key))
	}
	return nil
}

// gcmParams are a BCB-AES-GCM block's parameters, defaults applied.
type gcmParams struct {
	IV         []byte
	Variant    uint64
	Scope      uint64
	Wrapped    []byte
	HasWrapped bool
}

func parseGCMParams(items []secItem) (gcmParams, error) {
	p := gcmParams{Variant: aesA256GCM, Scope: scopeAll}
	hasIV := false
	var err error
	for _, it := range items {
		switch it.ID {
		case bcbParamIV:
			p.IV, err = it.bytes()
			hasIV = true
			if err == nil && (len(p.IV) < bcbIVMin || len(p.IV) > bcbIVMax) {
				err = fmt.Errorf("BCB-AES-GCM: a %d-byte IV is outside 8 to 16 bytes", len(p.IV))
			}
		case bcbParamAES:
			p.Variant, err = it.uint()
			if err == nil && aesKeyLen(p.Variant) == 0 {
				err = fmt.Errorf("BCB-AES-GCM: unsupported AES variant %d", p.Variant)
			}
		case bcbParamWrapped:
			p.Wrapped, err = it.bytes()
			p.HasWrapped = true
		case bcbParamScope:
			p.Scope, err = it.uint()
			if err == nil && p.Scope > scopeMax {
				err = errors.New("BCB-AES-GCM: scope flags exceed 16 bits")
			}
		default:
			err = fmt.Errorf("BCB-AES-GCM: unknown parameter %d", it.ID)
		}
		if err != nil {
			return p, err
		}
	}
	if !hasIV {
		// Policy: RFC 9173 §4.8.2 lets a node treat a missing IV as an error;
		// Argo has no other source for one.
		return p, errors.New("BCB-AES-GCM: no initialization vector")
	}
	return p, nil
}

func aesKeyLen(variant uint64) int {
	switch variant {
	case aesA128GCM:
		return 16
	case aesA256GCM:
		return 32
	}
	return 0
}

func gcmFor(key []byte, ivLen int) (cipher.AEAD, error) {
	c, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	if ivLen == bcbIVLen {
		return cipher.NewGCM(c)
	}
	return cipher.NewGCMWithNonceSize(c, ivLen) // RFC 9173 allows 8 to 16 bytes
}

// SecKeys is local policy for checking, decrypting or removing one RFC 9173
// security block. The keys are pre-placed: they come from the caller.
type SecKeys struct {
	Key []byte // the HMAC or AES key, used when the block carries no wrapped key
	KEK []byte // the key-encryption key, used when the block carries a wrapped key
	// BarePrimary selects the IPPT form for a primary-block target; see ipptOf.
	BarePrimary bool
	// RestoreCRC is the CRC type put back on targets that no security block
	// covers any more, which RFC 9173 §3.8.2 and §4.8.2 require when this
	// node is not the bundle's destination. crcNone leaves them without.
	RestoreCRC uint64
}

// key returns the block's key: unwrapped with the KEK when the block carries
// a wrapped key, otherwise the pre-placed key. Neither falls back to the other.
func (k SecKeys) key(wrapped []byte, has bool) ([]byte, error) {
	if !has {
		if len(k.Key) == 0 {
			return nil, errors.New("security block: no pre-placed key")
		}
		return k.Key, nil
	}
	if len(k.KEK) == 0 {
		return nil, errors.New("security block carries a wrapped key, but no key-encryption key is set")
	}
	key, err := aesKeyUnwrap(k.KEK, wrapped)
	if err != nil {
		return nil, errors.New("security block: cannot unwrap its key (wrong key-encryption key or altered block)")
	}
	return key, nil
}

// ipptOf builds the Integrity-Protected Plaintext for one BIB target
// (RFC 9173 §3.7). Target 0 is the primary block; sec is the BIB itself.
//
// Interop: for a primary-block target, step 5 appends "the canonical form of
// the primary block". RFC 9173 A.3 publishes it wrapped in a CBOR byte
// string, and dtn7-rs (bp7-rs, read 2026-10-24) computes it that way; errata
// 9192 (reported 2026-09-28, not verified) reads the text as the bare CBOR
// array. Argo wraps it by default and uses the bare array when bare is set.
// Other targets' data is always a byte string (§3.7 step 5, Appendix B).
func ipptOf(b *Bundle, scope, target uint64, sec Block, bare bool) ([]byte, error) {
	pb, err := b.Primary.encode()
	if err != nil {
		return nil, err
	}
	var e cborEnc
	e.uint(scope & scopeAll) // step 1, with reserved and unassigned bits 0
	if target == 0 {
		// Steps 2 and 3 are skipped for a primary-block target (the NOTE after step 5).
		if scope&scopeSecurity != 0 {
			blockHeader(&e, sec)
		}
		if bare {
			e.raw(pb)
		} else {
			e.bytes(pb)
		}
		return e.b, nil
	}
	t := b.Block(target)
	if t == nil {
		return nil, fmt.Errorf("security target %d is missing", target)
	}
	if scope&scopePrimary != 0 {
		e.raw(pb)
	}
	if scope&scopeTarget != 0 {
		blockHeader(&e, *t)
	}
	if scope&scopeSecurity != 0 {
		blockHeader(&e, sec)
	}
	e.bytes(t.Data)
	return e.b, nil
}

// aadOf builds BCB-AES-GCM's additional authenticated data for one target
// (RFC 9173 §4.7.2). Step 4 says "the BIB"; A.4 shows the BCB's own header
// (h'0c0201'), which is what this uses.
func aadOf(b *Bundle, scope uint64, t, sec Block) ([]byte, error) {
	var e cborEnc
	e.uint(scope & scopeAll)
	if scope&scopePrimary != 0 {
		pb, err := b.Primary.encode()
		if err != nil {
			return nil, err
		}
		e.raw(pb)
	}
	if scope&scopeTarget != 0 {
		blockHeader(&e, t)
	}
	if scope&scopeSecurity != 0 {
		blockHeader(&e, sec)
	}
	return e.b, nil
}

// blockHeader appends a block's canonical type code, number and processing
// flags, with the flags RFC 9171 does not assign set to 0 (RFC 9172 §4).
func blockHeader(e *cborEnc, blk Block) {
	e.uint(blk.Type)
	e.uint(blk.Num)
	e.uint(blk.Flags & blkAssigned)
}

// secCover records which blocks the bundle's BIBs and BCBs target. A BIB
// that a BCB encrypts can't be read; RFC 9172 §3.8 ensures its targets are
// encrypted too, so they still show up as covered.
type secCover struct {
	bib        map[uint64][]uint64 // target -> readable BIBs on it
	bcb        map[uint64][]uint64 // target -> BCBs on it
	bibTargets map[uint64][]uint64 // readable BIB -> its targets
}

func coverage(b *Bundle) (secCover, error) {
	c := secCover{bib: map[uint64][]uint64{}, bcb: map[uint64][]uint64{}, bibTargets: map[uint64][]uint64{}}
	for _, blk := range b.Blocks {
		if blk.Type != blockBCB {
			continue
		}
		a, err := decodeSecBlock(blk.Data)
		if err != nil {
			return c, err
		}
		for _, t := range a.Targets {
			c.bcb[t] = append(c.bcb[t], blk.Num)
		}
	}
	for _, blk := range b.Blocks {
		if blk.Type != blockBIB || len(c.bcb[blk.Num]) > 0 {
			continue
		}
		a, err := decodeSecBlock(blk.Data)
		if err != nil {
			return c, err
		}
		c.bibTargets[blk.Num] = a.Targets
		for _, t := range a.Targets {
			c.bib[t] = append(c.bib[t], blk.Num)
		}
	}
	return c, nil
}

func checkTargetList(targets []uint64) error {
	if len(targets) == 0 || len(targets) > maxBundleBlocks {
		return errors.New("security block: needs 1 to 16 targets")
	}
	for i, t := range targets {
		if slices.Contains(targets[:i], t) {
			return errors.New("security block: duplicate target")
		}
	}
	return nil
}

// newSecBlockNum returns want if it is free, or the next free number for 0.
func newSecBlockNum(b *Bundle, want uint64) (uint64, error) {
	if want == 0 {
		return b.nextBlockNum(), nil
	}
	if want == 1 || b.Block(want) != nil {
		return 0, fmt.Errorf("block number %d is taken", want)
	}
	return want, nil
}

// insertIndex is where a new block goes: in front of block number before,
// or first after the primary block for 0. The payload stays last.
func insertIndex(b *Bundle, before uint64) (int, error) {
	if len(b.Blocks) >= maxBundleBlocks {
		return 0, errors.New("bundle: too many blocks")
	}
	if before == 0 {
		return 0, nil
	}
	i := slices.IndexFunc(b.Blocks, func(x Block) bool { return x.Num == before })
	if i < 0 {
		return 0, fmt.Errorf("bundle: no block %d to insert before", before)
	}
	return i, nil
}

func restoreCRCs(b *Bundle, targets []uint64, crc uint64) error {
	if crc == crcNone {
		return nil
	}
	cov, err := coverage(b)
	if err != nil {
		return err
	}
	for _, t := range targets {
		if blk := b.Block(t); blk != nil && len(cov.bib[t]) == 0 && len(cov.bcb[t]) == 0 {
			blk.CRCType = crc
		}
	}
	return nil
}

// BIBConfig is one BIB-HMAC-SHA2 operation at a security source.
type BIBConfig struct {
	Source      EID      // the security source: node ID of the node adding the block
	Targets     []uint64 // block numbers to protect; 0 is the primary block
	Variant     uint64   // hmacSHA256, hmacSHA384 or hmacSHA512; 0 means hmacSHA384
	Scope       uint64   // integrity scope flags; 0 covers the target data only, scopeAll is the RFC default
	Key         []byte   // the pre-placed HMAC key
	KEK         []byte   // optional: also carry Key in the block, wrapped under this AES key (RFC 3394)
	BlockNum    uint64   // 0: the next free number
	Before      uint64   // insert in front of this block; 0: first after the primary block
	Flags       uint64   // the BIB's block processing control flags
	CRCType     uint64   // the BIB's own CRC
	BarePrimary bool     // IPPT form for a primary-block target; see ipptOf
}

// addBIB adds a BIB-HMAC-SHA2 block (RFC 9173 §3.8.1) and returns its
// number. The bundle is only changed once everything has been computed.
func addBIB(b *Bundle, c BIBConfig) (uint64, error) {
	variant := cmp.Or(c.Variant, hmacSHA384)
	h := hmacHash(variant)
	if h == nil {
		return 0, fmt.Errorf("BIB-HMAC-SHA2: unsupported SHA variant %d", variant)
	}
	if err := hmacKeyOK(h, c.Key); err != nil {
		return 0, err
	}
	if c.Scope > scopeAll {
		return 0, errors.New("BIB-HMAC-SHA2: reserved scope flags must be 0")
	}
	if c.CRCType > crc32C {
		return 0, errors.New("bundle: unknown CRC type")
	}
	if err := checkTargetList(c.Targets); err != nil {
		return 0, err
	}
	cov, err := coverage(b)
	if err != nil {
		return 0, err
	}
	for _, t := range c.Targets {
		if t != 0 {
			tb := b.Block(t)
			if tb == nil {
				return 0, fmt.Errorf("BIB target %d is missing", t)
			}
			if tb.Type == blockBIB || tb.Type == blockBCB {
				return 0, errors.New("a BIB must not target a security block (RFC 9172 §3.7)")
			}
		}
		if len(cov.bib[t]) > 0 {
			return 0, fmt.Errorf("block %d already has a BIB (RFC 9172 §3.2)", t)
		}
		if len(cov.bcb[t]) > 0 {
			return 0, fmt.Errorf("block %d is encrypted, so a BIB must not be added (RFC 9172 §3.9)", t)
		}
	}
	num, err := newSecBlockNum(b, c.BlockNum)
	if err != nil {
		return 0, err
	}
	at, err := insertIndex(b, c.Before)
	if err != nil {
		return 0, err
	}
	params := []secItem{uintItem(bibParamSHA, variant)}
	if len(c.KEK) > 0 {
		wrapped, err := aesKeyWrap(c.KEK, c.Key)
		if err != nil {
			return 0, err
		}
		params = append(params, bytesItem(bibParamWrapped, wrapped))
	}
	params = append(params, uintItem(bibParamScope, c.Scope))
	// The IPPT does not include CRCs, so they can come off the targets
	// (RFC 9173 §3.8.1) after the results are computed.
	sec := Block{Type: blockBIB, Num: num, Flags: c.Flags, CRCType: c.CRCType}
	results := make([][]secItem, len(c.Targets))
	for i, t := range c.Targets {
		in, err := ipptOf(b, c.Scope, t, sec, c.BarePrimary)
		if err != nil {
			return 0, err
		}
		m := hmac.New(h, c.Key)
		m.Write(in)
		results[i] = []secItem{bytesItem(bibResultMAC, m.Sum(nil))}
	}
	if sec.Data, err = (secBlock{Targets: c.Targets, Context: ctxBIBHMACSHA2, Source: c.Source,
		Params: params, Results: results}).encode(); err != nil {
		return 0, err
	}
	for _, t := range c.Targets {
		if t != 0 {
			b.Block(t).CRCType = crcNone
		}
	}
	b.Blocks = slices.Insert(b.Blocks, at, sec)
	return num, nil
}

// checkBIB verifies every result in BIB number num (RFC 9173 §3.8.2) and
// changes nothing. A missing parameter, unknown value or bad MAC fails it.
func checkBIB(b *Bundle, num uint64, k SecKeys) (secBlock, error) {
	var a secBlock
	blk := b.Block(num)
	if blk == nil || blk.Type != blockBIB {
		return a, fmt.Errorf("block %d is not a BIB", num)
	}
	cov, err := coverage(b)
	if err != nil {
		return a, err
	}
	if len(cov.bcb[num]) > 0 {
		return a, errors.New("the BIB is encrypted; decrypt it first (RFC 9172 §3.9)")
	}
	if a, err = decodeSecBlock(blk.Data); err != nil {
		return a, err
	}
	if a.Context != ctxBIBHMACSHA2 {
		return a, fmt.Errorf("BIB %d: unsupported security context %d", num, a.Context)
	}
	p, err := parseHMACParams(a.Params)
	if err != nil {
		return a, err
	}
	key, err := k.key(p.Wrapped, p.HasWrapped)
	if err != nil {
		return a, err
	}
	h := hmacHash(p.Variant)
	if err := hmacKeyOK(h, key); err != nil {
		return a, err
	}
	for i, t := range a.Targets {
		if len(cov.bcb[t]) > 0 {
			return a, fmt.Errorf("block %d is encrypted; decrypt it first (RFC 9172 §3.9)", t)
		}
		if t != 0 {
			tb := b.Block(t)
			if tb == nil {
				return a, fmt.Errorf("BIB target %d is missing", t)
			}
			if tb.Type == blockBIB || tb.Type == blockBCB {
				return a, errors.New("a BIB must not target a security block (RFC 9172 §3.7)")
			}
		}
		rs := a.Results[i]
		if len(rs) != 1 || rs[0].ID != bibResultMAC {
			return a, errors.New("BIB-HMAC-SHA2: expected one HMAC per target")
		}
		want, err := rs[0].bytes()
		if err != nil {
			return a, err
		}
		in, err := ipptOf(b, p.Scope, t, *blk, k.BarePrimary)
		if err != nil {
			return a, err
		}
		m := hmac.New(h, key)
		m.Write(in)
		if !hmac.Equal(m.Sum(nil), want) { // constant time (RFC 9173 §3.6)
			return a, fmt.Errorf("BIB %d: integrity check failed for block %d", num, t)
		}
	}
	return a, nil
}

// acceptBIB verifies BIB number num and then removes it, as the security
// acceptor does.
func acceptBIB(b *Bundle, num uint64, k SecKeys) error {
	if k.RestoreCRC > crc32C {
		return errors.New("bundle: unknown CRC type")
	}
	a, err := checkBIB(b, num, k)
	if err != nil {
		return err
	}
	b.removeBlock(num)
	return restoreCRCs(b, a.Targets, k.RestoreCRC)
}

// BCBConfig is one BCB-AES-GCM operation at a security source.
type BCBConfig struct {
	Source   EID      // the security source: node ID of the node adding the block
	Targets  []uint64 // addBCB takes exactly one; see there
	Variant  uint64   // aesA128GCM or aesA256GCM; 0 means aesA256GCM
	Scope    uint64   // AAD scope flags; 0 adds nothing, scopeAll is the RFC default
	Key      []byte   // the pre-placed AES key: 16 or 32 bytes to match Variant
	KEK      []byte   // optional: also carry Key in the block, wrapped under this AES key (RFC 3394)
	IV       []byte   // nil: 12 fresh random bytes. Never reuse an IV with the same key.
	BlockNum uint64   // 0: the next free number
	Before   uint64   // insert in front of this block; 0: first after the primary block
	Flags    uint64   // "replicate in every fragment" is added when the payload is a target (RFC 9172 §3.8)
	CRCType  uint64   // the BCB's own CRC
}

// addBCB encrypts one block with BCB-AES-GCM (RFC 9173 §4.8.1) and returns
// the new BCB's number.
//
// Policy: one target per BCB. All targets of a BCB share its key and IV,
// and AES-GCM must never use an IV twice with one key (RFC 9173 §4.3.1;
// errata 7002 on Appendix A.4). A block that a readable BIB protects is
// refused too: RFC 9172 §3.9 would need that BIB encrypted in the same
// operation, and at the security source a BCB alone already authenticates.
func addBCB(b *Bundle, c BCBConfig) (uint64, error) {
	if len(c.Targets) != 1 {
		return 0, errors.New("BCB-AES-GCM: one target per BCB, so no IV is used twice (RFC 9173 errata 7002)")
	}
	return sealBCB(b, c)
}

// sealBCB encrypts every target of a new BCB. Several targets share the key
// and IV, so outside addBCB only the RFC 9173 A.4 reproduction uses that.
func sealBCB(b *Bundle, c BCBConfig) (uint64, error) {
	variant := cmp.Or(c.Variant, aesA256GCM)
	n := aesKeyLen(variant)
	if n == 0 {
		return 0, fmt.Errorf("BCB-AES-GCM: unsupported AES variant %d", variant)
	}
	if len(c.Key) != n {
		return 0, fmt.Errorf("BCB-AES-GCM: a %d-byte key does not suit this AES variant", len(c.Key))
	}
	if c.Scope > scopeAll {
		return 0, errors.New("BCB-AES-GCM: reserved scope flags must be 0")
	}
	if c.Flags&blkDiscard != 0 {
		return 0, errors.New("a BCB must not be discarded unprocessed (RFC 9172 §3.8)")
	}
	if c.CRCType > crc32C {
		return 0, errors.New("bundle: unknown CRC type")
	}
	if err := checkTargetList(c.Targets); err != nil {
		return 0, err
	}
	iv := c.IV
	if iv == nil {
		iv = make([]byte, bcbIVLen)
		if _, err := rand.Read(iv); err != nil {
			return 0, err
		}
	}
	if len(iv) < bcbIVMin || len(iv) > bcbIVMax {
		return 0, fmt.Errorf("BCB-AES-GCM: a %d-byte IV is outside 8 to 16 bytes", len(iv))
	}
	cov, err := coverage(b)
	if err != nil {
		return 0, err
	}
	flags := c.Flags
	for _, t := range c.Targets {
		if t == 0 {
			return 0, errors.New("a BCB must not target the primary block (RFC 9172 §3.8)")
		}
		tb := b.Block(t)
		if tb == nil {
			return 0, fmt.Errorf("BCB target %d is missing", t)
		}
		if tb.Type == blockBCB {
			return 0, errors.New("a BCB must not target another BCB (RFC 9172 §3.8)")
		}
		if len(cov.bcb[t]) > 0 {
			return 0, fmt.Errorf("block %d is already encrypted (RFC 9172 §3.2)", t)
		}
		if tb.Type == blockPayload {
			flags |= blkReplicate
		}
		if tb.Type == blockBIB {
			for _, bt := range cov.bibTargets[t] {
				if !slices.Contains(c.Targets, bt) && len(cov.bcb[bt]) == 0 {
					return 0, errors.New("a BCB may encrypt a BIB only with that BIB's targets (RFC 9172 §3.8)")
				}
			}
		}
	}
	for bib, bts := range cov.bibTargets {
		if slices.Contains(c.Targets, bib) {
			continue
		}
		for _, bt := range bts {
			if slices.Contains(c.Targets, bt) {
				return 0, fmt.Errorf("block %d is protected by BIB %d, which RFC 9172 §3.9 needs encrypted with it; "+
					"at the security source use BCB-AES-GCM alone, it authenticates", bt, bib)
			}
		}
	}
	num, err := newSecBlockNum(b, c.BlockNum)
	if err != nil {
		return 0, err
	}
	at, err := insertIndex(b, c.Before)
	if err != nil {
		return 0, err
	}
	aead, err := gcmFor(c.Key, len(iv))
	if err != nil {
		return 0, err
	}
	params := []secItem{bytesItem(bcbParamIV, iv), uintItem(bcbParamAES, variant)}
	if len(c.KEK) > 0 {
		wrapped, err := aesKeyWrap(c.KEK, c.Key)
		if err != nil {
			return 0, err
		}
		params = append(params, bytesItem(bcbParamWrapped, wrapped))
	}
	params = append(params, uintItem(bcbParamScope, c.Scope))
	sec := Block{Type: blockBCB, Num: num, Flags: flags, CRCType: c.CRCType}
	cts := make([][]byte, len(c.Targets))
	results := make([][]secItem, len(c.Targets))
	for i, t := range c.Targets {
		tb := b.Block(t)
		aad, err := aadOf(b, c.Scope, *tb, sec)
		if err != nil {
			return 0, err
		}
		// The plaintext is the block-type-specific data without its CBOR
		// head (RFC 9173 §4.7.1); the tag goes in the results (§4.4).
		sealed := aead.Seal(nil, iv, tb.Data, aad)
		cut := len(sealed) - bcbTagLen
		cts[i] = sealed[:cut:cut]
		results[i] = []secItem{bytesItem(bcbResultTag, sealed[cut:])}
	}
	if sec.Data, err = (secBlock{Targets: c.Targets, Context: ctxBCBAESGCM, Source: c.Source,
		Params: params, Results: results}).encode(); err != nil {
		return 0, err
	}
	for i, t := range c.Targets { // CRCs come off the targets (§4.8.1); the AAD excludes them
		tb := b.Block(t)
		tb.Data, tb.CRCType = cts[i], crcNone
	}
	b.Blocks = slices.Insert(b.Blocks, at, sec)
	return num, nil
}

// openBCB decrypts every target of BCB number num (RFC 9173 §4.8.2) and
// removes the BCB, as the security acceptor does. Nothing changes unless
// every target authenticates. A BCB with several targets (one IV for all,
// as in RFC 9173 A.4) is accepted on receipt: refusing it would not undo
// the sender's IV reuse.
func openBCB(b *Bundle, num uint64, k SecKeys) error {
	if k.RestoreCRC > crc32C {
		return errors.New("bundle: unknown CRC type")
	}
	blk := b.Block(num)
	if blk == nil || blk.Type != blockBCB {
		return fmt.Errorf("block %d is not a BCB", num)
	}
	a, err := decodeSecBlock(blk.Data)
	if err != nil {
		return err
	}
	if a.Context != ctxBCBAESGCM {
		return fmt.Errorf("BCB %d: unsupported security context %d", num, a.Context)
	}
	p, err := parseGCMParams(a.Params)
	if err != nil {
		return err
	}
	key, err := k.key(p.Wrapped, p.HasWrapped)
	if err != nil {
		return err
	}
	if len(key) != aesKeyLen(p.Variant) {
		return fmt.Errorf("BCB-AES-GCM: a %d-byte key does not suit this AES variant", len(key))
	}
	aead, err := gcmFor(key, len(p.IV))
	if err != nil {
		return err
	}
	plain := make([][]byte, len(a.Targets))
	for i, t := range a.Targets {
		tb := b.Block(t)
		if t == 0 || tb == nil || tb.Type == blockBCB {
			return fmt.Errorf("BCB %d: target %d is missing or not allowed", num, t)
		}
		var ct []byte
		switch rs := a.Results[i]; {
		case len(rs) == 0: // the tag ends the ciphertext (RFC 9173 §4.4)
			ct = tb.Data
		case len(rs) == 1 && rs[0].ID == bcbResultTag:
			tag, err := rs[0].bytes()
			if err != nil || len(tag) != bcbTagLen {
				return errors.New("BCB-AES-GCM: the authentication tag must be 16 bytes")
			}
			ct = append(slices.Clip(tb.Data), tag...)
		default:
			return errors.New("BCB-AES-GCM: expected at most one tag per target")
		}
		aad, err := aadOf(b, p.Scope, *tb, *blk)
		if err != nil {
			return err
		}
		if plain[i], err = aead.Open(nil, p.IV, ct, aad); err != nil {
			return fmt.Errorf("BCB %d: cannot decrypt block %d (wrong key or altered bundle)", num, t)
		}
	}
	for i, t := range a.Targets {
		b.Block(t).Data = plain[i]
	}
	b.removeBlock(num)
	return restoreCRCs(b, a.Targets, k.RestoreCRC)
}
