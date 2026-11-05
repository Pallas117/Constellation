package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

// Interop with Gauss without a running server: every route Argo calls must exist in the
// backend's mesh router, mounted under /api/mesh. The full round trip (two real Argo devices
// against the real routers) is scripts/argo-relay-e2e.ts; this catches a renamed route in
// the plain Go run, on any machine with the repo.
func TestEveryArgoRouteExistsInGauss(t *testing.T) {
	router, err := os.ReadFile("../../backend/mesh/router.ts")
	if err != nil {
		t.Skip("backend not next to tools/argo (container build): ", err)
	}
	server, err := os.ReadFile("../../backend/server.ts")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(server), `app.use("/api/mesh", mesh.agent)`) {
		t.Fatal(`backend/server.ts no longer mounts mesh.agent at /api/mesh`)
	}
	var src strings.Builder
	for _, f := range []string{"hub.go", "gausspush.go"} {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		src.Write(b)
	}
	routes := []struct{ method, path string }{
		{"post", "/report"},
		{"post", "/bundles"},
		{"get", "/bundles"},
		{"post", "/bundles/status"},
		{"get", "/bundles/:id"},
		{"delete", "/bundles/:id"},
		{"get", "/directory"},
		{"post", "/keys"},
	}
	for _, r := range routes {
		re := regexp.MustCompile(`agent\.` + r.method + `\("` + regexp.QuoteMeta(r.path) + `"`)
		if !re.Match(router) {
			t.Errorf("Gauss has no %s %s for Argo", strings.ToUpper(r.method), r.path)
		}
		argoPath := "/api/mesh" + strings.TrimSuffix(r.path, ":id")
		if !strings.Contains(src.String(), `"`+argoPath) {
			t.Errorf("Argo no longer calls %s (update this list with the route)", argoPath)
		}
	}
}

// The CBOR decoder reads bundles from the hub, a carried drive and peers: hostile bytes
// must give an error, never a panic, a hang or unbounded recursion.
func FuzzCBORSkip(f *testing.F) {
	var e cborEnc
	e.array(3)
	e.uint(7)
	e.text("argo")
	e.bytes([]byte{1, 2})
	f.Add(e.b)
	f.Add([]byte{0x9f, 0x9f, 0x9f, 0xff})
	f.Add([]byte{0xbf, 0x61, 0x61, 0xff})
	f.Add([]byte{0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff})
	deep := make([]byte, 10000)
	for i := range deep {
		deep[i] = 0x81
	}
	f.Add(deep)
	f.Fuzz(func(t *testing.T, data []byte) {
		d := cborDec{b: data}
		for !d.done() {
			before := d.i
			if err := d.skip(); err != nil {
				return
			}
			if d.i <= before || d.i > len(data) {
				t.Fatalf("skip moved %d -> %d of %d", before, d.i, len(data))
			}
		}
	})
}
