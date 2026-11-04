package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Golden bundles shared with the Gauss hub's tests (backend/mesh/bundles.test.ts),
// so the Go encoder and the TypeScript parser can't drift apart.
// Regenerate with: ARGO_WRITE_FIXTURES=1 go test -run TestBundleFixtures .

const fixtureDir = "testdata/bundles"

type bundleFixture struct {
	File       string `json:"file"`
	Valid      bool   `json:"valid"`
	ID         string `json:"id,omitempty"`
	Source     string `json:"source,omitempty"`
	Dest       string `json:"dest,omitempty"`
	CreatedMS  uint64 `json:"createdMs,omitempty"`
	Seq        uint64 `json:"seq,omitempty"`
	LifetimeMS uint64 `json:"lifetimeMs,omitempty"`
}

type fixtureManifest struct {
	Bundles []bundleFixture `json:"bundles"`
	Keys    []struct {
		PeerKey
		Fingerprint string `json:"fingerprint"`
	} `json:"keys"`
}

func writeFixtures(t *testing.T) {
	clock := &fakeClock{t: time.Date(2026, 10, 23, 9, 0, 0, 0, time.UTC)}
	hub := newMemHub(clock.now, "judith", "ground-1")
	a, b := newNode(t, "judith", hub, clock), newNode(t, "ground-1", hub, clock)
	b.Sync(ctx)
	if _, _, err := a.Send(ctx, "ground-1", writeTemp(t, "pass-plan.txt", []byte("AOS 09:41 EL 62")), 48*time.Hour); err != nil {
		t.Fatal(err)
	}
	a.Sync(ctx)
	b.Sync(ctx) // receives and queues a signed receipt
	b.Sync(ctx)
	var m fixtureManifest
	add := func(name string, raw []byte, valid bool) {
		if err := os.WriteFile(filepath.Join(fixtureDir, name), raw, 0o644); err != nil {
			t.Fatal(err)
		}
		f := bundleFixture{File: name, Valid: valid}
		if valid {
			p, err := ParseBundle(raw)
			if err != nil {
				t.Fatal(err)
			}
			f.ID, f.Source, f.Dest, f.CreatedMS, f.Seq, f.LifetimeMS = p.Key(), string(p.Source), string(p.Dest), p.Created, p.Seq, p.Lifetime
		}
		m.Bundles = append(m.Bundles, f)
	}
	if err := os.MkdirAll(fixtureDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, q := range hub.queues["judith"] { // the receipt, waiting for judith
		add("receipt.bundle", q.raw, true)
	}
	raw, _ := os.ReadFile(a.outPath(a.onlyOutKey(t)))
	add("file-chunk.bundle", raw, true)
	b16 := testBundle()
	b16.CRCType, b16.Blocks[0].CRCType = crc16X25, crcNone
	r16, _ := b16.Marshal()
	add("crc16.bundle", r16, true)
	bad := append([]byte(nil), raw...)
	bad[8] ^= 0x01 // inside the primary block
	add("bad-crc.bundle", bad, false)
	for _, k := range []PeerKey{a.Keys.Public(), b.Keys.Public()} {
		m.Keys = append(m.Keys, struct {
			PeerKey
			Fingerprint string `json:"fingerprint"`
		}{k, k.Fingerprint()})
	}
	if err := os.WriteFile(filepath.Join(fixtureDir, "manifest.json"), mustJSON(m), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestBundleFixtures(t *testing.T) {
	if os.Getenv("ARGO_WRITE_FIXTURES") == "1" {
		writeFixtures(t)
	}
	b, err := os.ReadFile(filepath.Join(fixtureDir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var m fixtureManifest
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	if len(m.Bundles) < 4 || len(m.Keys) != 2 {
		t.Fatalf("manifest is incomplete: %d bundles, %d keys", len(m.Bundles), len(m.Keys))
	}
	for _, f := range m.Bundles {
		raw, err := os.ReadFile(filepath.Join(fixtureDir, f.File))
		if err != nil {
			t.Fatal(err)
		}
		p, err := ParseBundle(raw)
		if (err == nil) != f.Valid {
			t.Fatalf("%s: valid=%v, parse err=%v", f.File, f.Valid, err)
		}
		if f.Valid && (p.Key() != f.ID || string(p.Source) != f.Source || p.Created != f.CreatedMS) {
			t.Fatalf("%s: decoded %s %s %d", f.File, p.Key(), p.Source, p.Created)
		}
	}
	for _, k := range m.Keys {
		if k.valid() != nil || k.PeerKey.Fingerprint() != k.Fingerprint {
			t.Fatalf("key %s does not match its fingerprint", k.Node)
		}
	}
}
