package main

import (
	"bytes"
	"encoding/hex"
	"hash/crc32"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// RFC 8949 Appendix A examples for the encodings Argo writes.
func TestCBOREncodeRFC8949Vectors(t *testing.T) {
	cases := []struct {
		hex string
		enc func(e *cborEnc)
	}{
		{"00", func(e *cborEnc) { e.uint(0) }},
		{"17", func(e *cborEnc) { e.uint(23) }},
		{"1818", func(e *cborEnc) { e.uint(24) }},
		{"1903e8", func(e *cborEnc) { e.uint(1000) }},
		{"1a000f4240", func(e *cborEnc) { e.uint(1000000) }},
		{"1b000000e8d4a51000", func(e *cborEnc) { e.uint(1000000000000) }},
		{"1bffffffffffffffff", func(e *cborEnc) { e.uint(18446744073709551615) }},
		{"20", func(e *cborEnc) { e.int(-1) }},
		{"3863", func(e *cborEnc) { e.int(-100) }},
		{"3903e7", func(e *cborEnc) { e.int(-1000) }},
		{"40", func(e *cborEnc) { e.bytes(nil) }},
		{"4401020304", func(e *cborEnc) { e.bytes([]byte{1, 2, 3, 4}) }},
		{"6449455446", func(e *cborEnc) { e.text("IETF") }},
		{"62c3bc", func(e *cborEnc) { e.text("ü") }},
		{"83010203", func(e *cborEnc) { e.array(3); e.uint(1); e.uint(2); e.uint(3) }},
		{"9f0102ff", func(e *cborEnc) { e.indefArray(); e.uint(1); e.uint(2); e.brk() }},
		{"f4", func(e *cborEnc) { e.bool(false) }},
		{"f5", func(e *cborEnc) { e.bool(true) }},
	}
	for _, c := range cases {
		var e cborEnc
		c.enc(&e)
		if got := hex.EncodeToString(e.b); got != c.hex {
			t.Errorf("got %s, want %s", got, c.hex)
		}
	}
}

func TestCBORDecodeAndSkip(t *testing.T) {
	// Items Argo never writes but must step over: a map, a tag, indefinite strings, floats.
	for _, h := range []string{"a201020304", "c074323031332d30332d32315432303a30343a30305a", "5f42010243030405ff", "7f657374726561646d696e67ff", "f97c00", "fb3ff199999999999a", "9f018202039f0405ffff"} {
		raw, _ := hex.DecodeString(h)
		d := cborDec{b: raw}
		if err := d.skip(); err != nil || !d.done() {
			t.Errorf("skip %s: err=%v done=%v", h, err, d.done())
		}
	}
	for _, h := range []string{"", "18", "1a0000", "5a00000010ff", "9b0000000000000005", "1f", "7f61ff"} {
		raw, _ := hex.DecodeString(h)
		d := cborDec{b: raw}
		if err := d.skip(); err == nil {
			t.Errorf("skip %q should fail", h)
		}
	}
	deep := bytes.Repeat([]byte{0x81}, 40)
	d := cborDec{b: append(deep, 0x00)}
	if d.skip() == nil {
		t.Error("nesting deeper than the limit must fail")
	}
	d = cborDec{b: []byte{0x9b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff}}
	if _, err := d.array(); err == nil {
		t.Error("a huge array count must fail without allocating")
	}
}

func TestCRCCheckValues(t *testing.T) {
	if got := crcX25([]byte("123456789")); got != 0x906e {
		t.Errorf("CRC-16/X-25 check = %#x, want 0x906e", got)
	}
	if got := crc32.Checksum([]byte("123456789"), crcTable); got != 0xe3069283 {
		t.Errorf("CRC-32C check = %#x, want 0xe3069283", got)
	}
}

func testBundle() *Bundle {
	return &Bundle{
		Primary: Primary{Flags: flagNoFragment | flagReportDelivery, CRCType: crc32C, Dest: "dtn://ground-1/files", Source: "dtn://judith/",
			ReportTo: "dtn://judith/argo", Created: dtnTime(time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)), Seq: 7, Lifetime: 3_600_000},
		Blocks: []Block{{Type: blockPayload, Num: 1, CRCType: crc32C, Data: []byte("hello, ground station")}},
	}
}

func TestBundleRoundTripAndCRC(t *testing.T) {
	b := testBundle()
	raw, err := b.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if raw[0] != 0x9f || raw[len(raw)-1] != 0xff {
		t.Fatal("bundle must be an indefinite-length array")
	}
	got, err := ParseBundle(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got.Primary != b.Primary || string(got.Payload()) != "hello, ground station" {
		t.Fatalf("round trip changed the bundle: %+v", got.Primary)
	}
	if got.Key() != b.Key() || len(b.Key()) != 32 {
		t.Fatal("bundle key must be stable")
	}
	for _, i := range []int{5, len(raw) / 2, len(raw) - 8} { // primary, payload data, payload CRC
		bad := append([]byte(nil), raw...)
		bad[i] ^= 0x01
		if _, err := ParseBundle(bad); err == nil {
			t.Errorf("flipping byte %d went unnoticed", i)
		}
	}
	if _, err := ParseBundle(append(raw, 0x00)); err == nil {
		t.Error("trailing bytes must be refused")
	}
	b16 := testBundle()
	b16.CRCType, b16.Blocks[0].CRCType = crc16X25, crcNone
	raw16, _ := b16.Marshal()
	if _, err := ParseBundle(raw16); err != nil {
		t.Errorf("CRC-16 primary and CRC-less block are valid: %v", err)
	}
}

func TestBundleStructureRules(t *testing.T) {
	cases := map[string]func(b *Bundle){
		"no payload":         func(b *Bundle) { b.Blocks[0].Type = 7 },
		"payload not last":   func(b *Bundle) { b.Blocks = append(b.Blocks, Block{Type: 7, Num: 2}) },
		"payload number":     func(b *Bundle) { b.Blocks[0].Num = 2 },
		"duplicate numbers":  func(b *Bundle) { b.Blocks = append([]Block{{Type: 7, Num: 1}}, b.Blocks...) },
		"bad EID":            func(b *Bundle) { b.Dest = "dtn://" },
		"unsupported scheme": func(b *Bundle) { b.Dest = "mailto:x" },
	}
	for name, mutate := range cases {
		b := testBundle()
		mutate(b)
		if _, err := b.Marshal(); err == nil {
			t.Errorf("%s: Marshal should fail", name)
		}
	}
	for _, id := range []EID{dtnNone, "dtn://a/", "dtn://node-1/files", "ipn:977.1"} {
		var e cborEnc
		if err := encodeEID(&e, id); err != nil {
			t.Fatal(err)
		}
		d := cborDec{b: e.b}
		if got, err := decodeEID(&d); err != nil || got != id {
			t.Errorf("EID %s round trip: %s %v", id, got, err)
		}
	}
	if EID("dtn://judith/files").Node() != "dtn://judith/" || EID("dtn://judith/files").Service() != "files" {
		t.Error("EID node/service split")
	}
}

func TestStatusReportRoundTrip(t *testing.T) {
	r := StatusReport{Delivered: true, At: 12345, Subject: "dtn://judith/", SubjectCreated: 99, SubjectSeq: 3}
	p, err := r.encode()
	if err != nil {
		t.Fatal(err)
	}
	got, err := decodeStatusReport(p)
	if err != nil || got != r {
		t.Fatalf("got %+v %v", got, err)
	}
	if r.Key() != (Primary{Source: "dtn://judith/", Created: 99, Seq: 3}).Key() {
		t.Error("a report must name the bundle it reports on")
	}
}

func newTestKeys(t *testing.T, name string) NodeKeys {
	t.Helper()
	k, created, err := loadOrCreateKeys(filepath.Join(t.TempDir(), "node.key"), name)
	if err != nil || !created {
		t.Fatal(err)
	}
	return k
}

func TestNodeKeysFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cfg", "node.key")
	k1, created, err := loadOrCreateKeys(path, "judith")
	if err != nil || !created {
		t.Fatal(err)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0o600 {
		t.Errorf("key file mode %v, want 0600", info.Mode().Perm())
	}
	k2, created, err := loadOrCreateKeys(path, "judith")
	if err != nil || created || k1.Public().Fingerprint() != k2.Public().Fingerprint() {
		t.Fatal("reloading must give the same identity")
	}
	if fp := k1.Public().Fingerprint(); len(strings.Fields(fp)) != 5 {
		t.Errorf("fingerprint %q", fp)
	}
	if err := os.WriteFile(path, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := loadOrCreateKeys(path, "judith"); err == nil {
		t.Error("a damaged key file must be an error, never silently replaced")
	}
}

func sealedTestBundle(t *testing.T, from, to NodeKeys, msg string) *Bundle {
	t.Helper()
	b := testBundle()
	b.Source, b.Dest = EID("dtn://"+from.Name+"/files"), EID("dtn://"+to.Name+"/files")
	b.Blocks[0].Data = []byte(msg)
	if err := signBundle(b, from); err != nil {
		t.Fatal(err)
	}
	if err := sealBundle(b, to.Public()); err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSealOpenVerify(t *testing.T) {
	judith, ground, other := newTestKeys(t, "judith"), newTestKeys(t, "ground-1"), newTestKeys(t, "other")
	b := sealedTestBundle(t, judith, ground, "orbit determination file")
	raw, err := b.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("orbit determination")) {
		t.Fatal("plaintext visible in the sealed bundle")
	}
	got, _ := ParseBundle(raw)
	if err := openBundle(got, ground); err != nil {
		t.Fatal(err)
	}
	if err := verifyBundle(got, judith.Public()); err != nil {
		t.Fatal(err)
	}
	if string(got.Payload()) != "orbit determination file" || len(got.Blocks) != 1 {
		t.Fatalf("after open+verify: %q, %d blocks", got.Payload(), len(got.Blocks))
	}

	open := func(raw []byte, k NodeKeys) error {
		b, err := ParseBundle(raw)
		if err != nil {
			return err
		}
		return openBundle(b, k)
	}
	other.Name = "ground-1" // right name, wrong key
	if open(raw, other) == nil {
		t.Error("opened with the wrong private key")
	}
	// A hub moving the ciphertext into a bundle with another creation time must fail:
	// the HPKE info binds the primary block.
	moved, _ := ParseBundle(raw)
	moved.Created++
	mraw, _ := moved.Marshal()
	if open(mraw, ground) == nil {
		t.Error("ciphertext accepted under a different primary block")
	}
	// Flip a ciphertext byte and fix up the CRC, as an attacker would.
	tampered, _ := ParseBundle(raw)
	tampered.Blocks[len(tampered.Blocks)-1].Data[3] ^= 0x80
	traw, _ := tampered.Marshal()
	if open(traw, ground) == nil {
		t.Error("altered ciphertext accepted")
	}
	// The right recipient, but the signature checked against someone else.
	got2, _ := ParseBundle(raw)
	_ = openBundle(got2, ground)
	if verifyBundle(got2, other.Public()) == nil {
		t.Error("signature accepted from the wrong key")
	}
	unsigned := testBundle()
	if verifyBundle(unsigned, judith.Public()) == nil || openBundle(unsigned, ground) == nil {
		t.Error("unsigned or unsealed bundles must be refused")
	}
	if signBundle(testBundle(), ground) == nil {
		t.Error("a node must not sign bundles from another source")
	}
}

func FuzzParseBundle(f *testing.F) {
	b := testBundle()
	raw, _ := b.Marshal()
	f.Add(raw)
	f.Add([]byte{0x9f, 0xff})
	f.Fuzz(func(t *testing.T, data []byte) {
		got, err := ParseBundle(data)
		if err != nil {
			return
		}
		if _, err := got.Marshal(); err != nil {
			t.Fatalf("parsed bundle does not re-encode: %v", err)
		}
		if a := got.BlockOfType(blockArgoSeal); a != nil {
			_, _ = decodeASB(a.Data)
		}
		_, _ = decodeStatusReport(got.Payload())
		_, _ = decodeADU(got.Payload())
	})
}
