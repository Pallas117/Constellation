package main

// Bundle Protocol version 7 (RFC 9171) encoding: the primary block, canonical
// blocks, CRC-16/X-25 and CRC-32C, endpoint IDs and status reports. Argo
// writes CRC-32C on every block and never fragments (it splits files into
// chunks at the application layer instead, so each chunk is retried alone).

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/crc32"
	"strconv"
	"strings"
	"time"
)

// Bundle processing control flags (RFC 9171 §4.2.3).
const (
	flagFragment       = 0x000001
	flagAdminRecord    = 0x000002
	flagNoFragment     = 0x000004
	flagStatusTime     = 0x000040
	flagReportDelivery = 0x020000
)

// Block type codes (§9.1). 192-255 are reserved for private or experimental use.
const (
	blockPayload     = 1
	blockArgoSig     = 192 // Argo integrity block (bpsec.go)
	blockArgoSeal    = 193 // Argo confidentiality block (bpsec.go)
	crcNone          = 0
	crc16X25         = 1
	crc32C           = 2
	bundleVersion    = 7
	maxBundleBlocks  = 16
	maxEIDLen        = 255
	statusReportType = 1
)

// dtnEpoch is DTN time zero (§4.2.6): 2000-01-01 00:00:00 UTC.
var dtnEpoch = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

func dtnTime(t time.Time) uint64 {
	if t.Before(dtnEpoch) {
		return 0
	}
	return uint64(t.Sub(dtnEpoch) / time.Millisecond)
}

func fromDTNTime(ms uint64) time.Time { return dtnEpoch.Add(time.Duration(ms) * time.Millisecond) }

// EID is an endpoint ID in text form: dtn://node/service, dtn:none or ipn:N.S.
type EID string

const dtnNone EID = "dtn:none"

func nodeEID(name string) EID { return EID("dtn://" + name + "/") }

// NodeName is the node part of a dtn-scheme EID ("" for anything else).
func (e EID) NodeName() string {
	rest, ok := strings.CutPrefix(string(e), "dtn://")
	if !ok {
		return ""
	}
	name, _, _ := strings.Cut(rest, "/")
	return name
}

// Node is the node ID (the EID with an empty service) of a dtn-scheme EID.
func (e EID) Node() EID {
	if n := e.NodeName(); n != "" {
		return nodeEID(n)
	}
	return e
}

func (e EID) Service() string {
	rest, ok := strings.CutPrefix(string(e), "dtn://")
	if !ok {
		return ""
	}
	_, svc, _ := strings.Cut(rest, "/")
	return svc
}

func validDTNSSP(ssp string) bool {
	if len(ssp) > maxEIDLen || !strings.HasPrefix(ssp, "//") {
		return false
	}
	name, _, ok := strings.Cut(ssp[2:], "/")
	if !ok || name == "" {
		return false
	}
	for _, c := range ssp {
		if c <= 0x20 || c >= 0x7f {
			return false
		}
	}
	return true
}

func encodeEID(e *cborEnc, id EID) error {
	switch s := string(id); {
	case id == dtnNone:
		e.array(2)
		e.uint(1)
		e.uint(0)
	case strings.HasPrefix(s, "dtn:"):
		if !validDTNSSP(s[4:]) {
			return fmt.Errorf("bad dtn EID %q", s)
		}
		e.array(2)
		e.uint(1)
		e.text(s[4:])
	case strings.HasPrefix(s, "ipn:"):
		parts := strings.Split(s[4:], ".")
		if len(parts) != 2 {
			return fmt.Errorf("bad ipn EID %q", s)
		}
		node, err1 := strconv.ParseUint(parts[0], 10, 64)
		svc, err2 := strconv.ParseUint(parts[1], 10, 64)
		if err1 != nil || err2 != nil {
			return fmt.Errorf("bad ipn EID %q", s)
		}
		e.array(2)
		e.uint(2)
		e.array(2)
		e.uint(node)
		e.uint(svc)
	default:
		return fmt.Errorf("unsupported EID scheme %q", s)
	}
	return nil
}

func decodeEID(d *cborDec) (EID, error) {
	if n, err := d.array(); err != nil || n != 2 {
		return "", errors.New("bad EID")
	}
	scheme, err := d.uint()
	if err != nil {
		return "", err
	}
	switch scheme {
	case 1:
		if m, ok := d.peek(); ok && m == cborUint {
			if v, err := d.uint(); err != nil || v != 0 {
				return "", errors.New("bad dtn EID")
			}
			return dtnNone, nil
		}
		ssp, err := d.text()
		if err != nil || !validDTNSSP(ssp) {
			return "", errors.New("bad dtn EID")
		}
		return EID("dtn:" + ssp), nil
	case 2:
		n, err := d.array()
		if err != nil || n < 2 || n > 3 { // RFC 9758 adds an optional allocator ID in front
			return "", errors.New("bad ipn EID")
		}
		parts := make([]string, n)
		for i := range parts {
			v, err := d.uint()
			if err != nil {
				return "", err
			}
			parts[i] = strconv.FormatUint(v, 10)
		}
		return EID("ipn:" + strings.Join(parts, ".")), nil
	}
	return "", fmt.Errorf("unsupported EID scheme %d", scheme)
}

// Primary is the primary block (§4.3.1).
type Primary struct {
	Flags      uint64
	CRCType    uint64
	Dest       EID
	Source     EID
	ReportTo   EID
	Created    uint64 // DTN time, ms
	Seq        uint64
	Lifetime   uint64 // ms
	FragOffset uint64 // only when flagFragment is set
	TotalADU   uint64
}

// Block is a canonical block (§4.3.2).
type Block struct {
	Type, Num, Flags, CRCType uint64
	Data                      []byte
}

// Bundle holds the primary block and the canonical blocks, payload last.
type Bundle struct {
	Primary
	Blocks []Block
}

// Key identifies a bundle for dedup and for the hub: source node ID,
// creation time and sequence number (§4.2.7 / §5.9; Argo never fragments).
// The Gauss hub computes the same value (backend/mesh/bundles.ts).
func (p Primary) Key() string {
	h := sha256.Sum256([]byte(fmt.Sprintf("%s|%d|%d", p.Source, p.Created, p.Seq)))
	return hex.EncodeToString(h[:16])
}

func (p Primary) Expires() time.Time {
	return fromDTNTime(p.Created).Add(time.Duration(p.Lifetime) * time.Millisecond)
}

var crcTable = crc32.MakeTable(crc32.Castagnoli)

// crcX25 is CRC-16/X-25 (reflected 0x1021, init and xorout 0xFFFF).
func crcX25(p []byte) uint16 {
	crc := uint16(0xffff)
	for _, c := range p {
		crc ^= uint16(c)
		for range 8 {
			if crc&1 != 0 {
				crc = crc>>1 ^ 0x8408
			} else {
				crc >>= 1
			}
		}
	}
	return ^crc
}

func crcLen(t uint64) int {
	switch t {
	case crc16X25:
		return 2
	case crc32C:
		return 4
	}
	return 0
}

// sealCRC fills in the CRC that ends an encoded block: the CRC is computed
// over the whole block with the CRC value bytes zeroed (§4.2.1).
func sealCRC(block []byte, t uint64) {
	n := crcLen(t)
	if n == 0 {
		return
	}
	v := block[len(block)-n:]
	clear(v)
	switch t {
	case crc16X25:
		binary.BigEndian.PutUint16(v, crcX25(block))
	case crc32C:
		binary.BigEndian.PutUint32(v, crc32.Checksum(block, crcTable))
	}
}

func checkCRC(block []byte, t uint64) error {
	n := crcLen(t)
	if n == 0 {
		return nil
	}
	if len(block) < n {
		return errCBOR
	}
	got := append([]byte(nil), block[len(block)-n:]...)
	tmp := append([]byte(nil), block...)
	sealCRC(tmp, t)
	if string(tmp[len(tmp)-n:]) != string(got) {
		return errors.New("bundle: CRC mismatch")
	}
	return nil
}

func (p Primary) encode() ([]byte, error) {
	var e cborEnc
	n := 8
	if p.Flags&flagFragment != 0 {
		n += 2
	}
	if p.CRCType != crcNone {
		n++
	}
	e.array(n)
	e.uint(bundleVersion)
	e.uint(p.Flags)
	e.uint(p.CRCType)
	for _, id := range []EID{p.Dest, p.Source, p.ReportTo} {
		if err := encodeEID(&e, id); err != nil {
			return nil, err
		}
	}
	e.array(2)
	e.uint(p.Created)
	e.uint(p.Seq)
	e.uint(p.Lifetime)
	if p.Flags&flagFragment != 0 {
		e.uint(p.FragOffset)
		e.uint(p.TotalADU)
	}
	if k := crcLen(p.CRCType); k > 0 {
		e.bytes(make([]byte, k))
	}
	sealCRC(e.b, p.CRCType)
	return e.b, nil
}

func (b Block) encode() []byte {
	var e cborEnc
	n := 5
	if b.CRCType != crcNone {
		n++
	}
	e.array(n)
	e.uint(b.Type)
	e.uint(b.Num)
	e.uint(b.Flags)
	e.uint(b.CRCType)
	e.bytes(b.Data)
	if k := crcLen(b.CRCType); k > 0 {
		e.bytes(make([]byte, k))
	}
	sealCRC(e.b, b.CRCType)
	return e.b
}

// Marshal encodes the bundle as an indefinite-length CBOR array (§4.1).
func (b *Bundle) Marshal() ([]byte, error) {
	if err := b.validate(); err != nil {
		return nil, err
	}
	pb, err := b.Primary.encode()
	if err != nil {
		return nil, err
	}
	var e cborEnc
	e.indefArray()
	e.raw(pb)
	for _, blk := range b.Blocks {
		e.raw(blk.encode())
	}
	e.brk()
	return e.b, nil
}

func (b *Bundle) validate() error {
	if len(b.Blocks) == 0 || len(b.Blocks) > maxBundleBlocks {
		return errors.New("bundle: needs 1 to 16 canonical blocks")
	}
	seen := map[uint64]bool{}
	for i, blk := range b.Blocks {
		last := i == len(b.Blocks)-1
		if (blk.Type == blockPayload) != last {
			return errors.New("bundle: exactly one payload block, and it must be last")
		}
		if last && blk.Num != 1 {
			return errors.New("bundle: payload block number must be 1")
		}
		if blk.Num == 0 || seen[blk.Num] {
			return errors.New("bundle: block numbers must be unique and non-zero")
		}
		if blk.CRCType > crc32C {
			return errors.New("bundle: unknown CRC type")
		}
		seen[blk.Num] = true
	}
	if b.CRCType > crc32C {
		return errors.New("bundle: unknown CRC type")
	}
	return nil
}

// Block returns the block with number num, or nil.
func (b *Bundle) Block(num uint64) *Block {
	for i := range b.Blocks {
		if b.Blocks[i].Num == num {
			return &b.Blocks[i]
		}
	}
	return nil
}

func (b *Bundle) BlockOfType(t uint64) *Block {
	for i := range b.Blocks {
		if b.Blocks[i].Type == t {
			return &b.Blocks[i]
		}
	}
	return nil
}

func (b *Bundle) Payload() []byte { return b.Blocks[len(b.Blocks)-1].Data }

func (b *Bundle) removeBlock(num uint64) {
	for i := range b.Blocks {
		if b.Blocks[i].Num == num {
			b.Blocks = append(b.Blocks[:i], b.Blocks[i+1:]...)
			return
		}
	}
}

func (b *Bundle) nextBlockNum() uint64 {
	n := uint64(2)
	for _, blk := range b.Blocks {
		if blk.Num >= n {
			n = blk.Num + 1
		}
	}
	return n
}

func decodePrimary(raw []byte) (Primary, error) {
	var p Primary
	d := cborDec{b: raw}
	n, err := d.array()
	if err != nil || n < 8 || n > 11 {
		return p, errors.New("bundle: bad primary block")
	}
	v, err := d.uint()
	if err != nil || v != bundleVersion {
		return p, errors.New("bundle: not BPv7")
	}
	if p.Flags, err = d.uint(); err != nil {
		return p, err
	}
	if p.CRCType, err = d.uint(); err != nil || p.CRCType > crc32C {
		return p, errors.New("bundle: bad CRC type")
	}
	for _, f := range []*EID{&p.Dest, &p.Source, &p.ReportTo} {
		if *f, err = decodeEID(&d); err != nil {
			return p, err
		}
	}
	if k, err := d.array(); err != nil || k != 2 {
		return p, errors.New("bundle: bad creation timestamp")
	}
	if p.Created, err = d.uint(); err != nil {
		return p, err
	}
	if p.Seq, err = d.uint(); err != nil {
		return p, err
	}
	if p.Lifetime, err = d.uint(); err != nil {
		return p, err
	}
	want := 8
	if p.Flags&flagFragment != 0 {
		want += 2
		if p.FragOffset, err = d.uint(); err != nil {
			return p, err
		}
		if p.TotalADU, err = d.uint(); err != nil {
			return p, err
		}
	}
	if p.CRCType != crcNone {
		want++
		c, err := d.bytes()
		if err != nil || len(c) != crcLen(p.CRCType) {
			return p, errors.New("bundle: bad CRC field")
		}
	}
	if n != want || !d.done() {
		return p, errors.New("bundle: primary block has the wrong number of fields")
	}
	return p, checkCRC(raw, p.CRCType)
}

func decodeBlock(raw []byte) (Block, error) {
	var b Block
	d := cborDec{b: raw}
	n, err := d.array()
	if err != nil || n < 5 || n > 6 {
		return b, errors.New("bundle: bad canonical block")
	}
	for _, f := range []*uint64{&b.Type, &b.Num, &b.Flags, &b.CRCType} {
		if *f, err = d.uint(); err != nil {
			return b, err
		}
	}
	if b.CRCType > crc32C || (b.CRCType == crcNone) != (n == 5) {
		return b, errors.New("bundle: bad block CRC type")
	}
	if b.Data, err = d.bytes(); err != nil {
		return b, err
	}
	if n == 6 {
		c, err := d.bytes()
		if err != nil || len(c) != crcLen(b.CRCType) {
			return b, errors.New("bundle: bad CRC field")
		}
	}
	if !d.done() {
		return b, errCBOR
	}
	b.Data = append([]byte(nil), b.Data...)
	return b, checkCRC(raw, b.CRCType)
}

// ParseBundle decodes and checks one bundle: structure, every CRC, one
// payload block last, unique block numbers, nothing after the end.
func ParseBundle(raw []byte) (*Bundle, error) {
	if len(raw) < 2 || raw[0] != cborArray<<5|31 {
		return nil, errors.New("bundle: not an indefinite-length array")
	}
	d := cborDec{b: raw, i: 1}
	pr, err := d.item()
	if err != nil {
		return nil, err
	}
	b := &Bundle{}
	if b.Primary, err = decodePrimary(pr); err != nil {
		return nil, err
	}
	for !d.isBreak() {
		if d.done() || len(b.Blocks) >= maxBundleBlocks {
			return nil, errors.New("bundle: unterminated or too many blocks")
		}
		br, err := d.item()
		if err != nil {
			return nil, err
		}
		blk, err := decodeBlock(br)
		if err != nil {
			return nil, err
		}
		b.Blocks = append(b.Blocks, blk)
	}
	d.i++
	if !d.done() {
		return nil, errors.New("bundle: trailing bytes")
	}
	return b, b.validate()
}

// StatusReport is the "delivered" status report Argo sends back as a signed
// receipt (§6.1.1). Other assertions are encoded as not asserted.
type StatusReport struct {
	Delivered      bool
	At             uint64 // DTN time of delivery
	Reason         uint64
	Subject        EID // source node ID of the bundle reported on
	SubjectCreated uint64
	SubjectSeq     uint64
}

func (r StatusReport) Key() string {
	return Primary{Source: r.Subject, Created: r.SubjectCreated, Seq: r.SubjectSeq}.Key()
}

func (r StatusReport) encode() ([]byte, error) {
	var e cborEnc
	e.array(2)
	e.uint(statusReportType)
	e.array(4)
	e.array(4)
	for i := range 4 {
		if i == 2 && r.Delivered {
			e.array(2)
			e.bool(true)
			e.uint(r.At)
			continue
		}
		e.array(1)
		e.bool(false)
	}
	e.uint(r.Reason)
	if err := encodeEID(&e, r.Subject); err != nil {
		return nil, err
	}
	e.array(2)
	e.uint(r.SubjectCreated)
	e.uint(r.SubjectSeq)
	return e.b, nil
}

func decodeStatusReport(p []byte) (StatusReport, error) {
	var r StatusReport
	d := cborDec{b: p}
	if n, err := d.array(); err != nil || n != 2 {
		return r, errors.New("admin record: bad shape")
	}
	if t, err := d.uint(); err != nil || t != statusReportType {
		return r, errors.New("admin record: not a status report")
	}
	n, err := d.array()
	if err != nil || (n != 4 && n != 6) {
		return r, errors.New("status report: bad shape")
	}
	if k, err := d.array(); err != nil || k != 4 {
		return r, errors.New("status report: bad status information")
	}
	for i := range 4 {
		k, err := d.array()
		if err != nil || k < 1 || k > 2 {
			return r, errors.New("status report: bad assertion")
		}
		asserted, err := d.bool()
		if err != nil {
			return r, err
		}
		var at uint64
		if k == 2 {
			if at, err = d.uint(); err != nil {
				return r, err
			}
		}
		if i == 2 {
			r.Delivered, r.At = asserted, at
		}
	}
	if r.Reason, err = d.uint(); err != nil {
		return r, err
	}
	if r.Subject, err = decodeEID(&d); err != nil {
		return r, err
	}
	if k, err := d.array(); err != nil || k != 2 {
		return r, errors.New("status report: bad timestamp")
	}
	if r.SubjectCreated, err = d.uint(); err != nil {
		return r, err
	}
	if r.SubjectSeq, err = d.uint(); err != nil {
		return r, err
	}
	return r, nil
}
