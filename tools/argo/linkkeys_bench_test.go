package main

// Bundle security cost per bundle, node security (argo-sig-1 Ed25519 +
// argo-seal-1 HPKE ML-KEM-768 + X25519) against link keys (BIB-HMAC-SHA256 +
// BCB-AES-256-GCM, linkkeys.go). B-added is the bytes the security adds.
//
//	go test -run '^$' -bench BundleSecurity -benchtime 2000x .

import (
	"crypto/rand"
	"fmt"
	"path/filepath"
	"testing"
)

func benchNodeKeys(b *testing.B, name string) NodeKeys {
	k, _, err := loadOrCreateKeys(filepath.Join(b.TempDir(), "node.key"), name)
	if err != nil {
		b.Fatal(err)
	}
	return k
}

// benchBundle copies payload: protection changes the bundle in place.
func benchBundle(payload []byte) *Bundle {
	bd := testBundle()
	bd.Blocks[0].Data = append([]byte(nil), payload...)
	return bd
}

func benchMarshal(b *testing.B, bd *Bundle) []byte {
	raw, err := bd.Marshal()
	if err != nil {
		b.Fatal(err)
	}
	return raw
}

func BenchmarkBundleSecurity(b *testing.B) {
	from, to := benchNodeKeys(b, "judith"), benchNodeKeys(b, "ground-1")
	lk, err := newLinkKey(fromDTNTime(testBundle().Created))
	if err != nil {
		b.Fatal(err)
	}
	kinds := []struct {
		name    string
		protect func(*Bundle) error
		open    func(*Bundle) error
	}{
		{"node", func(bd *Bundle) error {
			if err := signBundle(bd, from); err != nil {
				return err
			}
			return sealBundle(bd, to.Public())
		}, func(bd *Bundle) error {
			if err := openBundle(bd, to); err != nil {
				return err
			}
			return verifyBundle(bd, from.Public())
		}},
		{"link", func(bd *Bundle) error { return linkProtect(bd, lk, true) },
			func(bd *Bundle) error { _, err := linkOpen(bd, []*linkKey{lk}, true); return err }},
		{"node-receipt", func(bd *Bundle) error { return signBundle(bd, from) },
			func(bd *Bundle) error { return verifyBundle(bd, from.Public()) }},
		{"link-receipt", func(bd *Bundle) error { return linkProtect(bd, lk, false) },
			func(bd *Bundle) error { _, err := linkOpen(bd, []*linkKey{lk}, false); return err }},
	}
	for _, n := range []int{256, 4 << 10, 64 << 10, chunkSize} {
		payload := make([]byte, n)
		_, _ = rand.Read(payload)
		base := len(benchMarshal(b, benchBundle(payload)))
		for _, k := range kinds {
			if k.name != "node" && k.name != "link" && n != 256 {
				continue // receipts are small
			}
			b.Run(fmt.Sprintf("send/%s/%dB", k.name, n), func(b *testing.B) {
				var raw []byte
				for b.Loop() {
					bd := benchBundle(payload)
					if err := k.protect(bd); err != nil {
						b.Fatal(err)
					}
					raw = benchMarshal(b, bd)
				}
				b.ReportMetric(float64(len(raw)-base), "B-added")
			})
			bd := benchBundle(payload)
			if err := k.protect(bd); err != nil {
				b.Fatal(err)
			}
			raw := benchMarshal(b, bd)
			b.Run(fmt.Sprintf("receive/%s/%dB", k.name, n), func(b *testing.B) {
				for b.Loop() {
					got, err := ParseBundle(raw)
					if err != nil {
						b.Fatal(err)
					}
					if err := k.open(got); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}
