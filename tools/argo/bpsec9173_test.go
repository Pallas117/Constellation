package main

// RFC 9173 golden and robustness tests (GAU-199). The hex in
// testdata/rfc9173/ is copied from https://www.rfc-editor.org/rfc/rfc9173.txt
// (Appendix A) and, for a3-errata9192.hex, from the RFC 9173 errata page;
// each file names the sections it comes from. Keys in this file are the
// published test values or throwaway test keys, never real ones.

import (
	"bytes"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// loadHex reads testdata/rfc9173/<file>: a line "name:" starts an entry,
// its hex follows on indented lines, and '#' starts a comment.
func loadHex(tb testing.TB, file string) map[string][]byte {
	tb.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "rfc9173", file))
	if err != nil {
		tb.Fatal(err)
	}
	acc := map[string]*strings.Builder{}
	name := ""
	for _, line := range strings.Split(string(raw), "\n") {
		line, _, _ = strings.Cut(line, "#")
		line = strings.TrimRight(line, " \t\r")
		if line == "" {
			continue
		}
		if line[0] != ' ' && line[0] != '\t' {
			n, rest, ok := strings.Cut(line, ":")
			if !ok {
				tb.Fatalf("%s: bad line %q", file, line)
			}
			name = n
			acc[name] = &strings.Builder{}
			acc[name].WriteString(strings.TrimSpace(rest))
			continue
		}
		if name == "" {
			tb.Fatalf("%s: hex before any name", file)
		}
		acc[name].WriteString(strings.TrimSpace(line))
	}
	out := map[string][]byte{}
	for n, sb := range acc {
		b, err := hex.DecodeString(sb.String())
		if err != nil {
			tb.Fatalf("%s %s: %v", file, n, err)
		}
		out[n] = b
	}
	return out
}

// vec returns a named value, failing the test if the file lacks it.
func vec(t *testing.T, m map[string][]byte, name string) []byte {
	t.Helper()
	v, ok := m[name]
	if !ok {
		t.Fatalf("test vector %q is missing", name)
	}
	return v
}

func mustParse(t *testing.T, raw []byte) *Bundle {
	t.Helper()
	b, err := ParseBundle(raw)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	return b
}

func mustMarshal(t *testing.T, b *Bundle) []byte {
	t.Helper()
	raw, err := b.Marshal()
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

func sameHex(t *testing.T, what string, got, want []byte) {
	t.Helper()
	if !bytes.Equal(got, want) {
		t.Errorf("%s differs:\n got  %x\n want %x", what, got, want)
	}
}

func clone9173(t *testing.T, b *Bundle) *Bundle { return mustParse(t, mustMarshal(t, b)) }

// resultBytes returns the only result for target i of an ASB.
func resultBytes(t *testing.T, asbData []byte, i int) []byte {
	t.Helper()
	a, err := decodeSecBlock(asbData)
	if err != nil || len(a.Results[i]) != 1 {
		t.Fatalf("ASB: %v", err)
	}
	v, err := a.Results[i][0].bytes()
	if err != nil {
		t.Fatal(err)
	}
	return v
}

// A.1: a BIB with HMAC 512/512 over the payload, no extra scope.
func TestRFC9173A1Integrity(t *testing.T) {
	h := loadHex(t, "a1.hex")
	key := vec(t, h, "key")

	orig := mustParse(t, vec(t, h, "original-bundle"))
	sameHex(t, "A.1.1.3 original bundle re-encoded", mustMarshal(t, orig), vec(t, h, "original-bundle"))
	pb, err := orig.Primary.encode()
	if err != nil {
		t.Fatal(err)
	}
	sameHex(t, "A.1.1.1 primary block", pb, vec(t, h, "primary"))
	sameHex(t, "A.1.1.2 payload block", orig.Block(1).encode(), vec(t, h, "payload-block"))
	sameHex(t, "A.1.1.2 payload data", orig.Payload(), vec(t, h, "payload-data"))

	// The published bundle verifies, and accepting the BIB gives back the original.
	final := mustParse(t, vec(t, h, "final-bundle"))
	sameHex(t, "A.1.4 final bundle re-encoded", mustMarshal(t, final), vec(t, h, "final-bundle"))
	in, err := ipptOf(final, 0, 1, *final.Block(2), false)
	if err != nil {
		t.Fatal(err)
	}
	sameHex(t, "A.1.3.1 IPPT", in, vec(t, h, "ippt"))
	if _, err := checkBIB(final, 2, SecKeys{Key: key}); err != nil {
		t.Fatalf("published A.1 BIB does not verify: %v", err)
	}
	if err := acceptBIB(final, 2, SecKeys{Key: key}); err != nil {
		t.Fatal(err)
	}
	sameHex(t, "A.1 bundle after accepting the BIB", mustMarshal(t, final), vec(t, h, "original-bundle"))

	// Re-encode from the published inputs.
	num, err := addBIB(orig, BIBConfig{Source: "ipn:2.1", Targets: []uint64{1}, Variant: hmacSHA512, Scope: 0, Key: key})
	if err != nil || num != 2 {
		t.Fatalf("addBIB = %d, %v", num, err)
	}
	sameHex(t, "A.1.3.1 signature", resultBytes(t, orig.Block(2).Data, 0), vec(t, h, "signature"))
	sameHex(t, "A.1.3.2 ASB", orig.Block(2).Data, vec(t, h, "asb"))
	sameHex(t, "A.1.3.3 BIB", orig.Block(2).encode(), vec(t, h, "bib-block"))
	sameHex(t, "A.1.4 final bundle", mustMarshal(t, orig), vec(t, h, "final-bundle"))
}

// A.2: a BCB with A128GCM over the payload, its key carried AES-KW wrapped.
func TestRFC9173A2ConfidentialityKeyWrap(t *testing.T) {
	h := loadHex(t, "a2.hex")
	cek, kek, iv := vec(t, h, "cek"), vec(t, h, "kek"), vec(t, h, "iv")

	w, err := aesKeyWrap(kek, cek)
	if err != nil {
		t.Fatal(err)
	}
	sameHex(t, "A.2.3.1 AES wrapped key", w, vec(t, h, "wrapped-key"))
	k, err := aesKeyUnwrap(kek, vec(t, h, "wrapped-key"))
	if err != nil {
		t.Fatal(err)
	}
	sameHex(t, "A.2.3.1 unwrapped key", k, cek)

	final := mustParse(t, vec(t, h, "final-bundle"))
	sameHex(t, "A.2.4 final bundle re-encoded", mustMarshal(t, final), vec(t, h, "final-bundle"))
	aad, err := aadOf(final, 0, *final.Block(1), *final.Block(2))
	if err != nil {
		t.Fatal(err)
	}
	sameHex(t, "A.2.3.1 AAD", aad, vec(t, h, "aad"))
	// The block carries a wrapped key, so only the KEK opens it: a
	// pre-placed key is never used in its place.
	if openBCB(final, 2, SecKeys{Key: cek}) == nil {
		t.Error("a wrapped-key BCB opened without the KEK")
	}
	if err := openBCB(final, 2, SecKeys{KEK: kek}); err != nil {
		t.Fatalf("published A.2 BCB does not decrypt: %v", err)
	}
	sameHex(t, "A.2 bundle after decryption", mustMarshal(t, final), vec(t, h, "original-bundle"))

	orig := mustParse(t, vec(t, h, "original-bundle"))
	num, err := addBCB(orig, BCBConfig{Source: "ipn:2.1", Targets: []uint64{1}, Variant: aesA128GCM, Scope: 0,
		Key: cek, KEK: kek, IV: iv, Flags: blkReplicate})
	if err != nil || num != 2 {
		t.Fatalf("addBCB = %d, %v", num, err)
	}
	sameHex(t, "A.2.3.1 payload ciphertext", orig.Payload(), vec(t, h, "ciphertext"))
	sameHex(t, "A.2.3.1 authentication tag", resultBytes(t, orig.Block(2).Data, 0), vec(t, h, "tag"))
	sameHex(t, "A.2.3.2 ASB", orig.Block(2).Data, vec(t, h, "asb"))
	sameHex(t, "A.2.3.3 BCB", orig.Block(2).encode(), vec(t, h, "bcb-block"))
	sameHex(t, "A.2.4 final bundle", mustMarshal(t, orig), vec(t, h, "final-bundle"))
}

// A.3: a BCB from the source over the payload, then a BIB from waypoint
// ipn:3.0 over the primary block and the Bundle Age Block.
func TestRFC9173A3MultipleSources(t *testing.T) {
	h := loadHex(t, "a3.hex")
	e := loadHex(t, "a3-errata9192.hex")
	bibKey, cek, iv := vec(t, h, "bib-key"), vec(t, h, "cek"), vec(t, h, "iv")

	final := mustParse(t, vec(t, h, "final-bundle"))
	sameHex(t, "A.3.5 final bundle re-encoded", mustMarshal(t, final), vec(t, h, "final-bundle"))
	bib := *final.Block(3)
	for _, c := range []struct {
		what   string
		target uint64
		bare   bool
		want   []byte
	}{
		{"A.3.3.1 primary block IPPT (published)", 0, false, vec(t, h, "primary-ippt")},
		{"A.3.3.1 primary block IPPT (errata 9192)", 0, true, vec(t, e, "primary-ippt")},
		{"A.3.3.1 Bundle Age Block IPPT", 2, false, vec(t, h, "age-ippt")},
	} {
		in, err := ipptOf(final, 0, c.target, bib, c.bare)
		if err != nil {
			t.Fatal(err)
		}
		sameHex(t, c.what, in, c.want)
	}
	// The published primary-block MAC uses the byte-string form, and the
	// errata's corrected MAC the bare form; neither verifies the other way.
	if _, err := checkBIB(final, 3, SecKeys{Key: bibKey}); err != nil {
		t.Errorf("published A.3 BIB does not verify: %v", err)
	}
	if _, err := checkBIB(final, 3, SecKeys{Key: bibKey, BarePrimary: true}); err == nil {
		t.Error("the bare primary-block form accepted the published A.3 MAC")
	}
	errata := mustParse(t, vec(t, e, "final-bundle"))
	if _, err := checkBIB(errata, 3, SecKeys{Key: bibKey, BarePrimary: true}); err != nil {
		t.Errorf("errata 9192 BIB does not verify in the bare form: %v", err)
	}
	if _, err := checkBIB(errata, 3, SecKeys{Key: bibKey}); err == nil {
		t.Error("the byte-string form accepted the errata 9192 MAC")
	}

	aad, err := aadOf(final, 0, *final.Block(1), *final.Block(4))
	if err != nil {
		t.Fatal(err)
	}
	sameHex(t, "A.3.4.1 AAD", aad, vec(t, h, "aad"))
	if err := openBCB(final, 4, SecKeys{Key: cek}); err != nil {
		t.Fatalf("published A.3 BCB does not decrypt: %v", err)
	}
	if err := acceptBIB(final, 3, SecKeys{Key: bibKey}); err != nil {
		t.Fatal(err)
	}
	sameHex(t, "A.3 bundle after both blocks are removed", mustMarshal(t, final), vec(t, h, "original-bundle"))

	// Re-encode: the source adds the BCB, then the waypoint adds the BIB.
	for _, form := range []struct {
		name string
		bare bool
		want map[string][]byte
	}{{"published", false, h}, {"errata 9192", true, e}} {
		orig := mustParse(t, vec(t, h, "original-bundle"))
		sameHex(t, "A.3.1.2 Bundle Age Block", orig.Block(2).encode(), vec(t, h, "age-block"))
		if _, err := addBCB(orig, BCBConfig{Source: "ipn:2.1", Targets: []uint64{1}, Variant: aesA128GCM, Scope: 0,
			Key: cek, IV: iv, BlockNum: 4, Before: 2, Flags: blkReplicate}); err != nil {
			t.Fatal(err)
		}
		sameHex(t, "A.3.4.1 payload ciphertext", orig.Payload(), vec(t, h, "ciphertext"))
		sameHex(t, "A.3.4.1 authentication tag", resultBytes(t, orig.Block(4).Data, 0), vec(t, h, "tag"))
		sameHex(t, "A.3.4.2 BCB ASB", orig.Block(4).Data, vec(t, h, "bcb-asb"))
		sameHex(t, "A.3.4.3 BCB", orig.Block(4).encode(), vec(t, h, "bcb-block"))
		if _, err := addBIB(orig, BIBConfig{Source: "ipn:3.0", Targets: []uint64{0, 2}, Variant: hmacSHA256, Scope: 0,
			Key: bibKey, BlockNum: 3, BarePrimary: form.bare}); err != nil {
			t.Fatal(err)
		}
		sameHex(t, form.name+" A.3.3.1 primary block MAC", resultBytes(t, orig.Block(3).Data, 0), vec(t, form.want, "primary-signature"))
		sameHex(t, form.name+" A.3.3.1 Bundle Age Block MAC", resultBytes(t, orig.Block(3).Data, 1), vec(t, h, "age-signature"))
		sameHex(t, form.name+" A.3.3.2 BIB ASB", orig.Block(3).Data, vec(t, form.want, "bib-asb"))
		sameHex(t, form.name+" A.3.3.3 BIB", orig.Block(3).encode(), vec(t, form.want, "bib-block"))
		sameHex(t, form.name+" A.3.5 final bundle", mustMarshal(t, orig), vec(t, form.want, "final-bundle"))
	}
}

// A.4: a BIB over the payload with full scope, then one BCB over the BIB
// and the payload with full scope.
func TestRFC9173A4FullScope(t *testing.T) {
	h := loadHex(t, "a4.hex")
	bibKey, bcbKey, iv := vec(t, h, "bib-key"), vec(t, h, "bcb-key"), vec(t, h, "iv")

	final := mustParse(t, vec(t, h, "final-bundle"))
	sameHex(t, "A.4.5 final bundle re-encoded", mustMarshal(t, final), vec(t, h, "final-bundle"))
	var hdr cborEnc
	blockHeader(&hdr, *final.Block(2))
	sameHex(t, "A.4.4.1 BCB header", hdr.b, vec(t, h, "bcb-header"))
	for _, c := range []struct {
		what   string
		target uint64
		want   []byte
	}{{"A.4.4.1 payload AAD", 1, vec(t, h, "payload-aad")}, {"A.4.4.1 BIB AAD", 3, vec(t, h, "bib-aad")}} {
		aad, err := aadOf(final, scopeAll, *final.Block(c.target), *final.Block(2))
		if err != nil {
			t.Fatal(err)
		}
		sameHex(t, c.what, aad, c.want)
	}
	// RFC 9172 §3.9: an encrypted BIB is never checked.
	if _, err := checkBIB(final, 3, SecKeys{Key: bibKey}); err == nil {
		t.Error("an encrypted BIB was checked")
	}
	if err := openBCB(final, 2, SecKeys{Key: bcbKey}); err != nil {
		t.Fatalf("published A.4 BCB does not decrypt: %v", err)
	}
	sameHex(t, "A.4 decrypted BIB", final.Block(3).Data, vec(t, h, "bib-asb"))
	in, err := ipptOf(final, scopeAll, 1, *final.Block(3), false)
	if err != nil {
		t.Fatal(err)
	}
	sameHex(t, "A.4.3.1 IPPT", in, vec(t, h, "ippt"))
	if err := acceptBIB(final, 3, SecKeys{Key: bibKey}); err != nil {
		t.Fatalf("decrypted A.4 BIB does not verify: %v", err)
	}
	sameHex(t, "A.4 bundle after both blocks are removed", mustMarshal(t, final), vec(t, h, "original-bundle"))

	// Re-encode.
	orig := mustParse(t, vec(t, h, "original-bundle"))
	if _, err := addBIB(orig, BIBConfig{Source: "ipn:2.1", Targets: []uint64{1}, Variant: hmacSHA384, Scope: scopeAll,
		Key: bibKey, BlockNum: 3}); err != nil {
		t.Fatal(err)
	}
	var bh cborEnc
	blockHeader(&bh, *orig.Block(3))
	sameHex(t, "A.4.3.1 BIB header", bh.b, vec(t, h, "bib-header"))
	var ph cborEnc
	blockHeader(&ph, *orig.Block(1))
	sameHex(t, "A.4.3.1 payload header", ph.b, vec(t, h, "payload-header"))
	sameHex(t, "A.4.3.1 payload MAC", resultBytes(t, orig.Block(3).Data, 0), vec(t, h, "payload-signature"))
	sameHex(t, "A.4.3.2 BIB ASB", orig.Block(3).Data, vec(t, h, "bib-asb"))
	sameHex(t, "A.4.3.3 BIB", orig.Block(3).encode(), vec(t, h, "bib-block"))

	cfg := BCBConfig{Source: "ipn:2.1", Targets: []uint64{3, 1}, Variant: aesA256GCM, Scope: scopeAll,
		Key: bcbKey, IV: iv, BlockNum: 2, Before: 1, Flags: blkReplicate}
	// addBCB refuses the published two-target BCB (one IV used twice,
	// errata 7002) and each target on its own (RFC 9172 §3.8, §3.9).
	before := mustMarshal(t, orig)
	for _, targets := range [][]uint64{{3, 1}, {1}, {3}} {
		c := cfg
		c.Targets = targets
		if _, err := addBCB(orig, c); err == nil {
			t.Errorf("addBCB accepted targets %v", targets)
		}
	}
	sameHex(t, "bundle after refused addBCB calls", mustMarshal(t, orig), before)
	// sealBCB, the same code without the one-target policy, reproduces A.4.
	if num, err := sealBCB(orig, cfg); err != nil || num != 2 {
		t.Fatalf("sealBCB = %d, %v", num, err)
	}
	sameHex(t, "A.4.4.1 BIB ciphertext", orig.Block(3).Data, vec(t, h, "bib-ciphertext"))
	sameHex(t, "A.4.4.1 payload ciphertext", orig.Payload(), vec(t, h, "payload-ciphertext"))
	sameHex(t, "A.4.4.1 BIB tag", resultBytes(t, orig.Block(2).Data, 0), vec(t, h, "bib-tag"))
	sameHex(t, "A.4.4.1 payload tag", resultBytes(t, orig.Block(2).Data, 1), vec(t, h, "payload-tag"))
	sameHex(t, "A.4.4.2 BCB ASB", orig.Block(2).Data, vec(t, h, "bcb-asb"))
	sameHex(t, "A.4.4.3 BCB", orig.Block(2).encode(), vec(t, h, "bcb-block"))
	sameHex(t, "A.4.5 final bundle", mustMarshal(t, orig), vec(t, h, "final-bundle"))
}

// RFC 3394 §4.1 to §4.6, then the ways an unwrap must fail.
func TestRFC9173AESKeyWrapRFC3394(t *testing.T) {
	const kek128, kek192, kek256 = "000102030405060708090A0B0C0D0E0F", "000102030405060708090A0B0C0D0E0F1011121314151617",
		"000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F"
	const key128, key192, key256 = "00112233445566778899AABBCCDDEEFF", "00112233445566778899AABBCCDDEEFF0001020304050607",
		"00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F"
	for _, v := range []struct{ sec, kek, key, wrapped string }{
		{"4.1", kek128, key128, "1FA68B0A8112B447AEF34BD8FB5A7B829D3E862371D2CFE5"},
		{"4.2", kek192, key128, "96778B25AE6CA435F92B5B97C050AED2468AB8A17AD84E5D"},
		{"4.3", kek256, key128, "64E8C3F9CE0F5BA263E9777905818A2A93C8191E7D6E8AE7"},
		{"4.4", kek192, key192, "031D33264E15D33268F24EC260743EDCE1C6C7DDEE725A936BA814915C6762D2"},
		{"4.5", kek256, key192, "A8F9BC1612C68B3FF6E6F4FBE30E71E4769C8B80A32CB8958CD5D17D6B254DA1"},
		{"4.6", kek256, key256, "28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21"},
	} {
		kek, _ := hex.DecodeString(v.kek)
		key, _ := hex.DecodeString(v.key)
		want, _ := hex.DecodeString(v.wrapped)
		got, err := aesKeyWrap(kek, key)
		if err != nil {
			t.Fatalf("RFC 3394 §%s: %v", v.sec, err)
		}
		sameHex(t, "RFC 3394 §"+v.sec+" wrap", got, want)
		back, err := aesKeyUnwrap(kek, want)
		if err != nil {
			t.Fatalf("RFC 3394 §%s unwrap: %v", v.sec, err)
		}
		sameHex(t, "RFC 3394 §"+v.sec+" unwrap", back, key)
		for i := range want {
			bad := slices.Clone(want)
			bad[i] ^= 0x01
			if k, err := aesKeyUnwrap(kek, bad); err == nil || k != nil {
				t.Errorf("RFC 3394 §%s: unwrap accepted a flipped byte %d", v.sec, i)
			}
		}
		wrongKEK := slices.Clone(kek)
		wrongKEK[0] ^= 0x80
		if _, err := aesKeyUnwrap(wrongKEK, want); err == nil {
			t.Errorf("RFC 3394 §%s: unwrap accepted the wrong KEK", v.sec)
		}
	}
	kek := make([]byte, 16)
	for _, n := range []int{0, 8, 15, 20, 72} {
		if _, err := aesKeyWrap(kek, make([]byte, n)); err == nil {
			t.Errorf("wrapped a %d-byte key", n)
		}
	}
	for _, n := range []int{0, 16, 23, 25, 80} {
		if _, err := aesKeyUnwrap(kek, make([]byte, n)); err == nil {
			t.Errorf("unwrapped %d bytes", n)
		}
	}
	if _, err := aesKeyWrap(make([]byte, 15), make([]byte, 16)); err == nil {
		t.Error("wrapped with a 15-byte KEK")
	}
}

// flipEach flips each byte of raw[from:to] in turn. Every altered bundle
// must be refused, by the parser or by refused.
func flipEach(t *testing.T, what string, raw []byte, from, to int, refused func(*Bundle) bool) {
	t.Helper()
	if from < 0 || to > len(raw) || from >= to {
		t.Fatalf("%s: bad range %d..%d", what, from, to)
	}
	for i := from; i < to; i++ {
		for _, mask := range []byte{0x01, 0xff} {
			mut := slices.Clone(raw)
			mut[i] ^= mask
			b, err := ParseBundle(mut)
			if err != nil {
				continue
			}
			if !refused(b) {
				t.Errorf("%s: byte %d changed %#02x -> %#02x and was not detected", what, i, raw[i], mut[i])
			}
		}
	}
}

func TestRFC9173TamperDetected(t *testing.T) {
	a1, a2, a3, a4 := loadHex(t, "a1.hex"), loadHex(t, "a2.hex"), loadHex(t, "a3.hex"), loadHex(t, "a4.hex")
	// Every example bundle opens with 0x9f and the 28-byte primary block, and
	// ends with the payload's 35 data bytes and 0xff.
	const primaryEnd = 1 + 28
	payload := func(raw []byte) (int, int) { return len(raw) - 1 - 35, len(raw) - 1 }
	span := func(raw, part []byte) (int, int) {
		i := bytes.Index(raw, part)
		if i < 0 {
			t.Fatalf("%x not found", part)
		}
		return i, i + len(part)
	}

	// A.1 (scope 0) covers only the payload data.
	raw := vec(t, a1, "final-bundle")
	k1 := SecKeys{Key: vec(t, a1, "key")}
	from, to := payload(raw)
	flipEach(t, "A.1 payload", raw, from, to, func(b *Bundle) bool { _, err := checkBIB(b, 2, k1); return err != nil })

	// A.2: the payload ciphertext and the tag.
	raw = vec(t, a2, "final-bundle")
	k2 := SecKeys{KEK: vec(t, a2, "kek")}
	open2 := func(b *Bundle) bool { return openBCB(b, 2, k2) != nil }
	from, to = payload(raw)
	flipEach(t, "A.2 payload ciphertext", raw, from, to, open2)
	from, to = span(raw, vec(t, a2, "tag"))
	flipEach(t, "A.2 tag", raw, from, to, open2)
	from, to = span(raw, vec(t, a2, "wrapped-key"))
	flipEach(t, "A.2 wrapped key", raw, from, to, open2)

	// A.3: the primary block and the Bundle Age Block are BIB targets.
	raw = vec(t, a3, "final-bundle")
	k3 := SecKeys{Key: vec(t, a3, "bib-key")}
	check3 := func(b *Bundle) bool { _, err := checkBIB(b, 3, k3); return err != nil }
	flipEach(t, "A.3 primary block", raw, 1, primaryEnd, check3)
	from, to = span(raw, vec(t, a3, "age-block"))
	flipEach(t, "A.3 Bundle Age Block data", raw, from+5, to, check3)
	from, to = payload(raw)
	flipEach(t, "A.3 payload ciphertext", raw, from, to, func(b *Bundle) bool { return openBCB(b, 4, SecKeys{Key: vec(t, a3, "cek")}) != nil })

	// A.4 (scope 7): the primary block is in every AAD, and both targets are encrypted.
	raw = vec(t, a4, "final-bundle")
	k4 := SecKeys{Key: vec(t, a4, "bcb-key")}
	open4 := func(b *Bundle) bool { return openBCB(b, 2, k4) != nil }
	flipEach(t, "A.4 primary block", raw, 1, primaryEnd, open4)
	from, to = payload(raw)
	flipEach(t, "A.4 payload ciphertext", raw, from, to, open4)
	from, to = span(raw, vec(t, a4, "bib-ciphertext"))
	flipEach(t, "A.4 BIB ciphertext", raw, from, to, open4)

	// A failed decryption changes nothing, even when an earlier target opened.
	mut := slices.Clone(raw)
	mut[len(mut)-2] ^= 0x01 // the payload is the second target; the BIB opens first
	b := mustParse(t, mut)
	if openBCB(b, 2, k4) == nil {
		t.Fatal("altered payload decrypted")
	}
	sameHex(t, "bundle after a failed decryption", mustMarshal(t, b), mut)

	// The AAD covers the target's header: a changed processing flag fails.
	b = mustParse(t, raw)
	b.Block(1).Flags |= 0x04
	if openBCB(b, 2, k4) == nil {
		t.Error("A.4: a changed payload block flag was not detected")
	}

	// After decryption the BIB (scope 7) still covers the primary block, the
	// payload and both headers.
	b = mustParse(t, raw)
	if err := openBCB(b, 2, k4); err != nil {
		t.Fatal(err)
	}
	plain := mustMarshal(t, b)
	kb := SecKeys{Key: vec(t, a4, "bib-key")}
	checkB := func(b *Bundle) bool { _, err := checkBIB(b, 3, kb); return err != nil }
	flipEach(t, "A.4 primary block after decryption", plain, 1, primaryEnd, checkB)
	from, to = payload(plain)
	flipEach(t, "A.4 payload after decryption", plain, from, to, checkB)
	b = mustParse(t, plain)
	b.Block(3).Flags |= 0x02
	if _, err := checkBIB(b, 3, kb); err == nil {
		t.Error("A.4: a changed BIB flag was not detected")
	}
}

func TestRFC9173WrongKey(t *testing.T) {
	a1, a2, a3, a4 := loadHex(t, "a1.hex"), loadHex(t, "a2.hex"), loadHex(t, "a3.hex"), loadHex(t, "a4.hex")
	flip := func(k []byte) []byte { k = slices.Clone(k); k[len(k)-1] ^= 0x01; return k }

	raw := vec(t, a1, "final-bundle")
	for _, k := range []SecKeys{{Key: flip(vec(t, a1, "key"))}, {Key: make([]byte, 64)}, {KEK: make([]byte, 16)}, {}} {
		b := mustParse(t, raw)
		if acceptBIB(b, 2, k) == nil {
			t.Errorf("A.1 BIB accepted with key %x / KEK %x", k.Key, k.KEK)
		}
		sameHex(t, "A.1 after a refused key", mustMarshal(t, b), raw)
	}

	raw = vec(t, a2, "final-bundle")
	for _, k := range []SecKeys{{KEK: flip(vec(t, a2, "kek"))}, {KEK: make([]byte, 16)}, {KEK: make([]byte, 15)}, {Key: vec(t, a2, "cek")}} {
		b := mustParse(t, raw)
		if openBCB(b, 2, k) == nil {
			t.Errorf("A.2 BCB opened with key %x / KEK %x", k.Key, k.KEK)
		}
		sameHex(t, "A.2 after a refused key", mustMarshal(t, b), raw)
	}

	raw = vec(t, a3, "final-bundle")
	for _, k := range []SecKeys{{Key: flip(vec(t, a3, "cek"))}, {Key: slices.Concat(vec(t, a3, "cek"), vec(t, a3, "cek"))}} {
		if openBCB(mustParse(t, raw), 4, k) == nil {
			t.Errorf("A.3 BCB opened with key %x", k.Key)
		}
	}
	if _, err := checkBIB(mustParse(t, raw), 3, SecKeys{Key: flip(vec(t, a3, "bib-key"))}); err == nil {
		t.Error("A.3 BIB verified with the wrong key")
	}

	raw = vec(t, a4, "final-bundle")
	for _, k := range []SecKeys{{Key: flip(vec(t, a4, "bcb-key"))}, {Key: vec(t, a4, "bcb-key")[:16]}} {
		if openBCB(mustParse(t, raw), 2, k) == nil {
			t.Errorf("A.4 BCB opened with key %x", k.Key)
		}
	}
}

// withASB rewrites security block num of a parsed bundle through edit.
func withASB(t *testing.T, raw []byte, num uint64, edit func(*secBlock)) *Bundle {
	t.Helper()
	b := mustParse(t, raw)
	a, err := decodeSecBlock(b.Block(num).Data)
	if err != nil {
		t.Fatal(err)
	}
	edit(&a)
	if b.Block(num).Data, err = a.encode(); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestRFC9173Refusals(t *testing.T) {
	a1, a3 := loadHex(t, "a1.hex"), loadHex(t, "a3.hex")
	key := vec(t, a1, "key")
	bib := vec(t, a1, "final-bundle")
	setParam := func(id uint64, v []byte) func(*secBlock) {
		return func(a *secBlock) {
			for i := range a.Params {
				if a.Params[i].ID == id {
					a.Params[i].Value = v
					return
				}
			}
			a.Params = append(a.Params, secItem{ID: id, Value: v})
		}
	}
	u := func(v uint64) []byte { return uintItem(0, v).Value }
	bs := func(p []byte) []byte { return bytesItem(0, p).Value }

	// Received BIBs.
	for name, edit := range map[string]func(*secBlock){
		"SHA variant 4":        setParam(bibParamSHA, u(4)),
		"SHA variant 8":        setParam(bibParamSHA, u(8)),
		"SHA variant as bytes": setParam(bibParamSHA, bs([]byte{7})),
		"scope over 16 bits":   setParam(bibParamScope, u(0x10000)),
		"unknown parameter":    setParam(9, u(1)),
		"BCB context on a BIB": func(a *secBlock) { a.Context = ctxBCBAESGCM },
		"unknown context":      func(a *secBlock) { a.Context = 3 },
		"two results":          func(a *secBlock) { a.Results[0] = append(a.Results[0], a.Results[0][0]) },
		"no result":            func(a *secBlock) { a.Results[0] = nil },
		"result id 2":          func(a *secBlock) { a.Results[0][0].ID = 2 },
		"MAC as an integer":    func(a *secBlock) { a.Results[0][0].Value = u(1) },
		"missing target":       func(a *secBlock) { a.Targets[0] = 9 },
		"default SHA-384 instead of 512": func(a *secBlock) {
			a.Params = slices.DeleteFunc(a.Params, func(p secItem) bool { return p.ID == bibParamSHA })
		},
		"wrapped key that does not unwrap": setParam(bibParamWrapped, bs(make([]byte, 24))),
	} {
		b := withASB(t, bib, 2, edit)
		if _, err := checkBIB(b, 2, SecKeys{Key: key, KEK: make([]byte, 16)}); err == nil {
			t.Errorf("BIB with %s was accepted", name)
		}
	}

	// Received BCBs (A.3's BCB, block 4).
	bcb := vec(t, a3, "final-bundle")
	cek := vec(t, a3, "cek")
	for name, edit := range map[string]func(*secBlock){
		"AES variant 2 (A192GCM)": setParam(bcbParamAES, u(2)),
		"AES variant 4":           setParam(bcbParamAES, u(4)),
		"7-byte IV":               setParam(bcbParamIV, bs(make([]byte, 7))),
		"17-byte IV":              setParam(bcbParamIV, bs(make([]byte, 17))),
		"no IV": func(a *secBlock) {
			a.Params = slices.DeleteFunc(a.Params, func(p secItem) bool { return p.ID == bcbParamIV })
		},
		"scope over 16 bits":   setParam(bcbParamScope, u(0x10000)),
		"unknown parameter":    setParam(7, u(1)),
		"BIB context on a BCB": func(a *secBlock) { a.Context = ctxBIBHMACSHA2 },
		"15-byte tag":          func(a *secBlock) { a.Results[0][0].Value = bs(make([]byte, 15)) },
		"two tags":             func(a *secBlock) { a.Results[0] = append(a.Results[0], a.Results[0][0]) },
		"primary block target": func(a *secBlock) { a.Targets[0] = 0 },
		"missing target":       func(a *secBlock) { a.Targets[0] = 9 },
		"tag dropped":          func(a *secBlock) { a.Results[0] = nil },
		"scope changed to 1":   setParam(bcbParamScope, u(1)),
	} {
		b := withASB(t, bcb, 4, edit)
		if openBCB(b, 4, SecKeys{Key: cek}) == nil {
			t.Errorf("BCB with %s was accepted", name)
		}
	}
	if openBCB(mustParse(t, bcb), 4, SecKeys{Key: append(slices.Clone(cek), cek...)}) == nil {
		t.Error("an A128GCM BCB opened with a 32-byte key")
	}
	if openBCB(mustParse(t, bcb), 4, SecKeys{Key: cek, RestoreCRC: 3}) == nil {
		t.Error("an unknown CRC type was accepted")
	}

	// Sources.
	orig := vec(t, a1, "original-bundle")
	for name, c := range map[string]BIBConfig{
		"SHA variant 4":             {Variant: 4, Key: key},
		"SHA variant 8":             {Variant: 8, Key: key},
		"8-byte key":                {Key: make([]byte, 8)},
		"20-byte key":               {Key: make([]byte, 20)},
		"40-byte key for HMAC 256":  {Variant: hmacSHA256, Key: make([]byte, 40)},
		"72-byte key for HMAC 512":  {Variant: hmacSHA512, Key: make([]byte, 72)},
		"reserved scope bit":        {Key: key, Scope: 8},
		"unknown CRC type":          {Key: key, CRCType: 3},
		"bad source":                {Key: key, Source: "mailto:x"},
		"block number taken":        {Key: key, BlockNum: 1},
		"insert before a ghost":     {Key: key, Before: 7},
		"15-byte KEK":               {Key: key, KEK: make([]byte, 15)},
		"no targets":                {Key: key, Targets: []uint64{}},
		"duplicate targets":         {Key: key, Targets: []uint64{1, 1}},
		"missing target":            {Key: key, Targets: []uint64{5}},
		"payload twice (via 0 + 1)": {Key: key, Targets: []uint64{0, 1, 1}},
	} {
		if c.Source == "" {
			c.Source = "ipn:2.1"
		}
		if c.Targets == nil {
			c.Targets = []uint64{1}
		}
		b := mustParse(t, orig)
		if _, err := addBIB(b, c); err == nil {
			t.Errorf("addBIB accepted %s", name)
		}
		sameHex(t, "bundle after a refused addBIB ("+name+")", mustMarshal(t, b), orig)
	}
	k16, k32 := make([]byte, 16), make([]byte, 32)
	for name, c := range map[string]BCBConfig{
		"AES variant 2":           {Variant: 2, Key: make([]byte, 24)},
		"32-byte key for A128GCM": {Variant: aesA128GCM, Key: k32},
		"16-byte key for A256GCM": {Key: k16},
		"24-byte key":             {Key: make([]byte, 24)},
		"7-byte IV":               {Key: k32, IV: make([]byte, 7)},
		"17-byte IV":              {Key: k32, IV: make([]byte, 17)},
		"empty IV":                {Key: k32, IV: []byte{}},
		"reserved scope bit":      {Key: k32, Scope: 8},
		"discard flag":            {Key: k32, Flags: blkDiscard},
		"primary block target":    {Key: k32, Targets: []uint64{0}},
		"two targets":             {Key: k32, Targets: []uint64{1, 2}},
		"no targets":              {Key: k32, Targets: []uint64{}},
		"missing target":          {Key: k32, Targets: []uint64{5}},
		"unknown CRC type":        {Key: k32, CRCType: 7},
	} {
		if c.Source == "" {
			c.Source = "ipn:2.1"
		}
		if c.Targets == nil {
			c.Targets = []uint64{1}
		}
		b := mustParse(t, orig)
		if _, err := addBCB(b, c); err == nil {
			t.Errorf("addBCB accepted %s", name)
		}
		sameHex(t, "bundle after a refused addBCB ("+name+")", mustMarshal(t, b), orig)
	}
}

// The order and combination rules of RFC 9172 §3.2, §3.7, §3.8 and §3.9.
func TestRFC9173BlockRules(t *testing.T) {
	orig := vec(t, loadHex(t, "a1.hex"), "original-bundle")
	k16, k32 := bytes.Repeat([]byte{0x5a}, 16), bytes.Repeat([]byte{0xa5}, 32)
	bibOn := func(targets ...uint64) BIBConfig {
		return BIBConfig{Source: "ipn:2.1", Targets: targets, Scope: scopeAll, Key: k16}
	}
	bcbOn := func(target uint64) BCBConfig {
		return BCBConfig{Source: "ipn:2.1", Targets: []uint64{target}, Scope: scopeAll, Key: k32}
	}

	// Encrypted payload: no BIB on it, no second BCB, no BIB on the BCB.
	b := mustParse(t, orig)
	n, err := addBCB(b, bcbOn(1))
	if err != nil {
		t.Fatal(err)
	}
	if f := b.Block(n).Flags; f&blkReplicate == 0 {
		t.Errorf("BCB over the payload has flags %#x; RFC 9172 §3.8 needs replicate-in-every-fragment", f)
	}
	if _, err := addBCB(b, bcbOn(1)); err == nil {
		t.Error("the payload was encrypted twice")
	}
	if _, err := addBIB(b, bibOn(1)); err == nil {
		t.Error("a BIB was added over an encrypted block")
	}
	if _, err := addBIB(b, bibOn(n)); err == nil {
		t.Error("a BIB targeted a BCB")
	}
	if _, err := addBCB(b, bcbOn(n)); err == nil {
		t.Error("a BCB targeted a BCB")
	}

	// Signed payload: no second BIB, no BCB over the payload or the BIB alone.
	b = mustParse(t, orig)
	n, err = addBIB(b, bibOn(0, 1))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []BIBConfig{bibOn(1), bibOn(0), bibOn(n)} {
		if _, err := addBIB(b, c); err == nil {
			t.Errorf("a second BIB was added over %v", c.Targets)
		}
	}
	for _, target := range []uint64{1, n} {
		if _, err := addBCB(b, bcbOn(target)); err == nil {
			t.Errorf("a BCB was added over block %d of a BIB-protected bundle", target)
		}
	}

	// A fresh random IV each time: two encryptions of the same bundle differ
	// and both decrypt.
	var ivs [][]byte
	for range 2 {
		b = mustParse(t, orig)
		n, err := addBCB(b, bcbOn(1))
		if err != nil {
			t.Fatal(err)
		}
		a, _ := decodeSecBlock(b.Block(n).Data)
		p, err := parseGCMParams(a.Params)
		if err != nil || len(p.IV) != bcbIVLen {
			t.Fatalf("IV %x, %v", p.IV, err)
		}
		ivs = append(ivs, p.IV)
		if err := openBCB(b, n, SecKeys{Key: k32}); err != nil {
			t.Fatal(err)
		}
		sameHex(t, "decrypted bundle", mustMarshal(t, b), orig)
	}
	if bytes.Equal(ivs[0], ivs[1]) {
		t.Error("two encryptions used the same IV")
	}
}

// Every variant, scope and key option survives encoding and comes back.
func TestRFC9173RoundTrip(t *testing.T) {
	bases := map[string]*Bundle{"ipn": mustParse(t, vec(t, loadHex(t, "a1.hex"), "original-bundle")), "dtn": testBundle()}
	kek := bytes.Repeat([]byte{0x4b}, 32)
	for baseName, base := range bases {
		base.CRCType = crc32C
		base.Blocks[len(base.Blocks)-1].CRCType = crc32C
		raw := mustMarshal(t, base)
		src := base.Source.Node()
		for _, variant := range []uint64{hmacSHA256, hmacSHA384, hmacSHA512} {
			size := hmacHash(variant)().Size()
			for scope := range uint64(scopeAll + 1) {
				for _, targets := range [][]uint64{{1}, {0}, {0, 1}} {
					for _, wrap := range []bool{false, true} {
						b := mustParse(t, raw)
						key := bytes.Repeat([]byte{byte(scope + 1)}, size)
						c := BIBConfig{Source: src, Targets: targets, Variant: variant, Scope: scope, Key: key, CRCType: crc32C}
						k := SecKeys{Key: key, RestoreCRC: crc32C}
						if wrap {
							c.KEK, k = kek, SecKeys{KEK: kek, RestoreCRC: crc32C}
						}
						n, err := addBIB(b, c)
						if err != nil {
							t.Fatalf("%s BIB %d/%d/%v: %v", baseName, variant, scope, targets, err)
						}
						if slices.Contains(targets, 1) && b.Block(1).CRCType != crcNone {
							t.Error("the BIB target kept its CRC (RFC 9173 §3.8.1)")
						}
						got := mustParse(t, mustMarshal(t, b))
						if err := acceptBIB(got, n, k); err != nil {
							t.Fatalf("%s BIB %d/%d/%v/%v: %v", baseName, variant, scope, targets, wrap, err)
						}
						sameHex(t, baseName+" bundle after BIB round trip", mustMarshal(t, got), raw)
					}
				}
			}
		}
		for _, variant := range []uint64{aesA128GCM, aesA256GCM} {
			key := bytes.Repeat([]byte{byte(variant)}, aesKeyLen(variant))
			for scope := range uint64(scopeAll + 1) {
				for _, ivLen := range []int{bcbIVMin, bcbIVLen, bcbIVMax} {
					for _, wrap := range []bool{false, true} {
						b := mustParse(t, raw)
						c := BCBConfig{Source: src, Targets: []uint64{1}, Variant: variant, Scope: scope, Key: key,
							IV: bytes.Repeat([]byte{byte(ivLen)}, ivLen), CRCType: crc32C}
						k := SecKeys{Key: key, RestoreCRC: crc32C}
						if wrap {
							c.KEK, k = kek, SecKeys{KEK: kek, RestoreCRC: crc32C}
						}
						n, err := addBCB(b, c)
						if err != nil {
							t.Fatalf("%s BCB %d/%d/%d: %v", baseName, variant, scope, ivLen, err)
						}
						if bytes.Equal(b.Payload(), base.Payload()) {
							t.Fatal("the payload was not encrypted")
						}
						got := mustParse(t, mustMarshal(t, b))
						if err := openBCB(got, n, k); err != nil {
							t.Fatalf("%s BCB %d/%d/%d/%v: %v", baseName, variant, scope, ivLen, wrap, err)
						}
						sameHex(t, baseName+" bundle after BCB round trip", mustMarshal(t, got), raw)
					}
				}
			}
		}
	}

	// RFC 9173 §4.4: the tag may instead end the ciphertext, with no result.
	b := mustParse(t, vec(t, loadHex(t, "a3.hex"), "final-bundle"))
	a, _ := decodeSecBlock(b.Block(4).Data)
	tag, _ := a.Results[0][0].bytes()
	a.Results[0] = []secItem{}
	b.Block(4).Data, _ = a.encode()
	b.Block(1).Data = append(slices.Clone(b.Block(1).Data), tag...)
	if err := openBCB(b, 4, SecKeys{Key: vec(t, loadHex(t, "a3.hex"), "cek")}); err != nil {
		t.Fatalf("tag inside the ciphertext: %v", err)
	}
	sameHex(t, "payload with the tag inside the ciphertext", b.Payload(), vec(t, loadHex(t, "a1.hex"), "payload-data"))
}

func TestRFC9173MalformedASB(t *testing.T) {
	var good [][]byte
	for _, f := range []struct{ file, name string }{{"a1.hex", "asb"}, {"a2.hex", "asb"}, {"a3.hex", "bib-asb"},
		{"a3.hex", "bcb-asb"}, {"a4.hex", "bib-asb"}, {"a4.hex", "bcb-asb"}} {
		good = append(good, vec(t, loadHex(t, f.file), f.name))
	}
	for i, p := range good {
		a, err := decodeSecBlock(p)
		if err != nil {
			t.Fatalf("published ASB %d: %v", i, err)
		}
		enc, err := a.encode()
		if err != nil {
			t.Fatal(err)
		}
		sameHex(t, "published ASB re-encoded", enc, p)
		for n := range len(p) {
			if _, err := decodeSecBlock(p[:n]); err == nil {
				t.Errorf("ASB %d truncated to %d bytes was accepted", i, n)
			}
		}
		if _, err := decodeSecBlock(append(slices.Clone(p), 0x00)); err == nil {
			t.Errorf("ASB %d with a trailing byte was accepted", i)
		}
	}

	src := []byte{0x82, 0x02, 0x82, 0x02, 0x01} // ipn:2.1
	seq := func(parts ...[]byte) []byte { return bytes.Join(parts, nil) }
	nest := bytes.Repeat([]byte{0x81}, 40)
	for name, p := range map[string][]byte{
		"empty":                   {},
		"no targets":              seq([]byte{0x80, 0x01, 0x00}, src, []byte{0x80}),
		"duplicate targets":       seq([]byte{0x82, 0x01, 0x01, 0x01, 0x00}, src, []byte{0x82, 0x80, 0x80}),
		"17 targets":              seq([]byte{0x91}, []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17}, []byte{0x01, 0x00}, src),
		"fewer result lists":      seq([]byte{0x82, 0x01, 0x02, 0x01, 0x00}, src, []byte{0x81, 0x80}),
		"more result lists":       seq([]byte{0x81, 0x01, 0x01, 0x00}, src, []byte{0x82, 0x80, 0x80}),
		"params flag, no params":  seq([]byte{0x81, 0x01, 0x01, 0x01}, src, []byte{0x81, 0x80}),
		"params flag, empty list": seq([]byte{0x81, 0x01, 0x01, 0x01}, src, []byte{0x80, 0x81, 0x80}),
		"duplicate parameter":     seq([]byte{0x81, 0x01, 0x01, 0x01}, src, []byte{0x82, 0x82, 0x01, 0x05, 0x82, 0x01, 0x06, 0x81, 0x80}),
		"parameter not a pair":    seq([]byte{0x81, 0x01, 0x01, 0x01}, src, []byte{0x81, 0x83, 0x01, 0x05, 0x05, 0x81, 0x80}),
		"9 parameters": seq([]byte{0x81, 0x01, 0x01, 0x01}, src, []byte{0x89}, bytes.Repeat([]byte{0x82, 0x00, 0x00}, 1),
			[]byte{0x82, 0x01, 0x00, 0x82, 0x02, 0x00, 0x82, 0x03, 0x00, 0x82, 0x04, 0x00, 0x82, 0x05, 0x00, 0x82, 0x06, 0x00, 0x82, 0x07, 0x00, 0x82, 0x08, 0x00},
			[]byte{0x81, 0x80}),
		"5 results":           seq([]byte{0x81, 0x01, 0x01, 0x00}, src, []byte{0x81, 0x85}, bytes.Repeat([]byte{0x82, 0x01, 0x40}, 5)),
		"negative context":    seq([]byte{0x81, 0x01, 0x20, 0x00}, src, []byte{0x81, 0x80}),
		"text context":        seq([]byte{0x81, 0x01, 0x61, 0x31, 0x00}, src, []byte{0x81, 0x80}),
		"unknown EID scheme":  seq([]byte{0x81, 0x01, 0x01, 0x00, 0x82, 0x03, 0x00}, []byte{0x81, 0x80}),
		"huge target count":   {0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
		"huge byte string":    seq([]byte{0x81, 0x01, 0x01, 0x00}, src, []byte{0x81, 0x81, 0x82, 0x01, 0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}),
		"indefinite targets":  seq([]byte{0x9f, 0x01, 0xff, 0x01, 0x00}, src, []byte{0x81, 0x80}),
		"deeply nested value": seq([]byte{0x81, 0x01, 0x01, 0x00}, src, []byte{0x81, 0x81, 0x82, 0x01}, nest, []byte{0x00}),
		"break as a value":    seq([]byte{0x81, 0x01, 0x01, 0x00}, src, []byte{0x81, 0x81, 0x82, 0x01, 0xff}),
	} {
		if _, err := decodeSecBlock(p); err == nil {
			t.Errorf("malformed ASB (%s) was accepted", name)
		}
	}
	// Reserved security context flags are ignored when reading (RFC 9172 §3.6).
	if _, err := decodeSecBlock(seq([]byte{0x81, 0x01, 0x01, 0x06}, src, []byte{0x81, 0x80})); err != nil {
		t.Errorf("reserved context flags were not ignored: %v", err)
	}
}

func FuzzRFC9173(f *testing.F) {
	for _, file := range []string{"a1.hex", "a2.hex", "a3.hex", "a3-errata9192.hex", "a4.hex"} {
		for name, v := range loadHex(f, file) {
			if strings.Contains(name, "asb") || strings.Contains(name, "bundle") || name == "wrapped-key" {
				f.Add(v)
			}
		}
	}
	// Test keys only: the published A.x keys, so the seeds reach the crypto.
	keys := []SecKeys{
		{Key: []byte("\x1a\x2b\x1a\x2b\x1a\x2b\x1a\x2b\x1a\x2b\x1a\x2b\x1a\x2b\x1a\x2b"), KEK: []byte("abcdefghijklmnop")},
		{Key: []byte("qwertyuiopasdfgh")},
		{Key: []byte("qwertyuiopasdfghqwertyuiopasdfgh"), BarePrimary: true},
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		if a, err := decodeSecBlock(data); err == nil {
			if enc, err := a.encode(); err == nil {
				back, err := decodeSecBlock(enc)
				if err != nil || !reflect.DeepEqual(a, back) {
					t.Fatalf("ASB does not survive re-encoding: %v", err)
				}
			}
			_, _ = parseHMACParams(a.Params)
			_, _ = parseGCMParams(a.Params)
		}
		_, _ = aesKeyUnwrap(keys[0].KEK, data)
		b, err := ParseBundle(data)
		if err != nil {
			return
		}
		for _, blk := range slices.Clone(b.Blocks) {
			for _, k := range keys {
				switch blk.Type {
				case blockBIB:
					_ = acceptBIB(b, blk.Num, k)
				case blockBCB:
					_ = openBCB(b, blk.Num, k)
				}
			}
		}
		if _, err := b.Marshal(); err != nil {
			t.Fatalf("bundle no longer encodes after BPSec processing: %v", err)
		}
	})
}
