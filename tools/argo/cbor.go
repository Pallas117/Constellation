package main

// A small CBOR (RFC 8949) codec for bundles: just the parts BPv7 needs.
// The encoder writes core deterministic encoding (§4.2.1: shortest-form
// heads, definite lengths) except where RFC 9171 asks for the bundle's
// indefinite-length outer array. The decoder accepts any well-formed input
// within hard limits, so a hostile bundle can't make it allocate or recurse
// without bound; callers keep the raw bytes when they need to check a CRC.

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

const (
	cborUint   = 0
	cborNeg    = 1
	cborBytes  = 2
	cborText   = 3
	cborArray  = 4
	cborMap    = 5
	cborTag    = 6
	cborSimple = 7

	cborMaxDepth = 16
	cborFalse    = 0xf4
	cborTrue     = 0xf5
	cborBreak    = 0xff
)

var errCBOR = errors.New("cbor: malformed input")

type cborEnc struct{ b []byte }

func (e *cborEnc) head(major byte, v uint64) {
	m := major << 5
	switch {
	case v < 24:
		e.b = append(e.b, m|byte(v))
	case v <= math.MaxUint8:
		e.b = append(e.b, m|24, byte(v))
	case v <= math.MaxUint16:
		e.b = binary.BigEndian.AppendUint16(append(e.b, m|25), uint16(v))
	case v <= math.MaxUint32:
		e.b = binary.BigEndian.AppendUint32(append(e.b, m|26), uint32(v))
	default:
		e.b = binary.BigEndian.AppendUint64(append(e.b, m|27), v)
	}
}

func (e *cborEnc) uint(v uint64) { e.head(cborUint, v) }

func (e *cborEnc) int(v int64) {
	if v >= 0 {
		e.head(cborUint, uint64(v))
		return
	}
	e.head(cborNeg, uint64(-(v + 1)))
}

func (e *cborEnc) bytes(p []byte) { e.head(cborBytes, uint64(len(p))); e.b = append(e.b, p...) }
func (e *cborEnc) text(s string)  { e.head(cborText, uint64(len(s))); e.b = append(e.b, s...) }
func (e *cborEnc) array(n int)    { e.head(cborArray, uint64(n)) }
func (e *cborEnc) indefArray()    { e.b = append(e.b, cborArray<<5|31) }
func (e *cborEnc) brk()           { e.b = append(e.b, cborBreak) }
func (e *cborEnc) raw(p []byte)   { e.b = append(e.b, p...) }

func (e *cborEnc) bool(v bool) {
	if v {
		e.b = append(e.b, cborTrue)
	} else {
		e.b = append(e.b, cborFalse)
	}
}

type cborDec struct {
	b []byte
	i int
}

func (d *cborDec) done() bool { return d.i >= len(d.b) }

func (d *cborDec) peek() (major byte, ok bool) {
	if d.done() {
		return 0, false
	}
	return d.b[d.i] >> 5, true
}

func (d *cborDec) isBreak() bool { return !d.done() && d.b[d.i] == cborBreak }

// head reads an item head. indef reports additional info 31 (indefinite length).
func (d *cborDec) head() (major byte, v uint64, indef bool, err error) {
	if d.done() {
		return 0, 0, false, errCBOR
	}
	ib := d.b[d.i]
	d.i++
	major, info := ib>>5, ib&0x1f
	n := 0
	switch {
	case info < 24:
		return major, uint64(info), false, nil
	case info == 24:
		n = 1
	case info == 25:
		n = 2
	case info == 26:
		n = 4
	case info == 27:
		n = 8
	case info == 31 && (major == cborBytes || major == cborText || major == cborArray || major == cborMap):
		return major, 0, true, nil
	default:
		return 0, 0, false, errCBOR
	}
	if len(d.b)-d.i < n {
		return 0, 0, false, errCBOR
	}
	for _, c := range d.b[d.i : d.i+n] {
		v = v<<8 | uint64(c)
	}
	d.i += n
	return major, v, false, nil
}

func (d *cborDec) want(major byte) (uint64, error) {
	m, v, indef, err := d.head()
	if err != nil {
		return 0, err
	}
	if m != major || indef {
		return 0, fmt.Errorf("cbor: want major type %d, got %d", major, m)
	}
	return v, nil
}

func (d *cborDec) uint() (uint64, error) { return d.want(cborUint) }

func (d *cborDec) int() (int64, error) {
	m, v, _, err := d.head()
	if err != nil {
		return 0, err
	}
	if v > math.MaxInt64 {
		return 0, errCBOR
	}
	switch m {
	case cborUint:
		return int64(v), nil
	case cborNeg:
		return -1 - int64(v), nil
	}
	return 0, fmt.Errorf("cbor: want an integer, got major type %d", m)
}

// span returns the next n bytes; n is checked against what is left, so a
// length field can never cause a large allocation.
func (d *cborDec) span(n uint64) ([]byte, error) {
	if n > uint64(len(d.b)-d.i) {
		return nil, errCBOR
	}
	p := d.b[d.i : d.i+int(n)]
	d.i += int(n)
	return p, nil
}

// bytes returns a definite-length byte string (BPv7 uses no chunked strings).
func (d *cborDec) bytes() ([]byte, error) {
	n, err := d.want(cborBytes)
	if err != nil {
		return nil, err
	}
	return d.span(n)
}

func (d *cborDec) text() (string, error) {
	n, err := d.want(cborText)
	if err != nil {
		return "", err
	}
	p, err := d.span(n)
	return string(p), err
}

// array reads a definite array header. Each element needs at least one byte,
// so a count larger than what is left is malformed.
func (d *cborDec) array() (int, error) {
	n, err := d.want(cborArray)
	if err != nil {
		return 0, err
	}
	if n > uint64(len(d.b)-d.i) {
		return 0, errCBOR
	}
	return int(n), nil
}

func (d *cborDec) bool() (bool, error) {
	if d.done() {
		return false, errCBOR
	}
	switch d.b[d.i] {
	case cborTrue:
		d.i++
		return true, nil
	case cborFalse:
		d.i++
		return false, nil
	}
	return false, errCBOR
}

// skip steps over one complete item of any type.
func (d *cborDec) skip() error { return d.skipDepth(0) }

func (d *cborDec) skipDepth(depth int) error {
	if depth > cborMaxDepth {
		return errCBOR
	}
	m, v, indef, err := d.head()
	if err != nil {
		return err
	}
	switch m {
	case cborUint, cborNeg, cborSimple:
		return nil
	case cborBytes, cborText:
		if indef {
			for !d.isBreak() {
				if err := d.skipDepth(depth + 1); err != nil {
					return err
				}
			}
			d.i++
			return nil
		}
		_, err := d.span(v)
		return err
	case cborTag:
		return d.skipDepth(depth + 1)
	}
	// arrays and maps
	per := uint64(1)
	if m == cborMap {
		per = 2
	}
	if indef {
		for !d.isBreak() {
			if d.done() {
				return errCBOR
			}
			if err := d.skipDepth(depth + 1); err != nil {
				return err
			}
		}
		d.i++
		return nil
	}
	if v > uint64(len(d.b)-d.i) {
		return errCBOR
	}
	for k := uint64(0); k < v*per; k++ {
		if err := d.skipDepth(depth + 1); err != nil {
			return err
		}
	}
	return nil
}

// item returns the raw encoding of the next item.
func (d *cborDec) item() ([]byte, error) {
	start := d.i
	if err := d.skip(); err != nil {
		return nil, err
	}
	return d.b[start:d.i], nil
}
