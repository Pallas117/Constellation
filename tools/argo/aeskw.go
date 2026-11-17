package main

// AES Key Wrap (RFC 3394), written for RFC 9173 interoperability (GAU-199):
// a BPSec block may carry its HMAC or AES key wrapped under a pre-placed
// key-encryption key (KEK), and Go's standard library has no key wrap.
// NEEDS REVIEW before anything beyond the RFC 9173 contexts relies on it.
//
// Built on crypto/aes only, using the indexed form of RFC 3394 §2.2.1 and
// §2.2.2 with the default initial value (§2.2.3.1). It is checked against
// every RFC 3394 §4 test vector in bpsec9173_test.go. There is no padding
// variant (RFC 5649): RFC 9173 §6.4 only wraps whole 64-bit words.

import (
	"crypto/aes"
	"crypto/subtle"
	"encoding/binary"
	"errors"
)

// kwDefaultIV is RFC 3394 §2.2.3.1's initial value.
var kwDefaultIV = [8]byte{0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6, 0xa6}

// kwMaxKey bounds the key data: RFC 9173 keys are at most 64 bytes (an
// HMAC-SHA-512 key), so anything longer is refused rather than processed.
const kwMaxKey = 64

var errKeyWrap = errors.New("aes key wrap: bad length")

// aesKeyWrap wraps key (16 to 64 bytes, a multiple of 8) under kek (an
// AES-128, -192 or -256 key).
func aesKeyWrap(kek, key []byte) ([]byte, error) {
	if len(key) < 16 || len(key) > kwMaxKey || len(key)%8 != 0 {
		return nil, errKeyWrap
	}
	c, err := aes.NewCipher(kek)
	if err != nil {
		return nil, err
	}
	n := len(key) / 8
	out := make([]byte, 8+len(key))
	copy(out[8:], key)
	a := binary.BigEndian.Uint64(kwDefaultIV[:])
	var buf [16]byte
	for j := range 6 {
		for i := 1; i <= n; i++ {
			binary.BigEndian.PutUint64(buf[:8], a)
			copy(buf[8:], out[8*i:8*i+8])
			c.Encrypt(buf[:], buf[:])
			a = binary.BigEndian.Uint64(buf[:8]) ^ uint64(n*j+i)
			copy(out[8*i:8*i+8], buf[8:])
		}
	}
	binary.BigEndian.PutUint64(out[:8], a)
	return out, nil
}

// aesKeyUnwrap reverses aesKeyWrap and checks the integrity value in
// constant time. It returns nothing on failure.
func aesKeyUnwrap(kek, wrapped []byte) ([]byte, error) {
	if len(wrapped) < 24 || len(wrapped) > 8+kwMaxKey || len(wrapped)%8 != 0 {
		return nil, errKeyWrap
	}
	c, err := aes.NewCipher(kek)
	if err != nil {
		return nil, err
	}
	n := len(wrapped)/8 - 1
	r := make([]byte, 8*n)
	copy(r, wrapped[8:])
	a := binary.BigEndian.Uint64(wrapped[:8])
	var buf [16]byte
	for j := 5; j >= 0; j-- {
		for i := n; i >= 1; i-- {
			binary.BigEndian.PutUint64(buf[:8], a^uint64(n*j+i))
			copy(buf[8:], r[8*(i-1):8*i])
			c.Decrypt(buf[:], buf[:])
			a = binary.BigEndian.Uint64(buf[:8])
			copy(r[8*(i-1):8*i], buf[8:])
		}
	}
	var got [8]byte
	binary.BigEndian.PutUint64(got[:], a)
	if subtle.ConstantTimeCompare(got[:], kwDefaultIV[:]) != 1 {
		clear(r)
		return nil, errors.New("aes key unwrap: integrity check failed")
	}
	return r, nil
}
