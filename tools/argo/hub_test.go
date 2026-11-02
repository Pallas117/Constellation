package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// The hub client against a stand-in Gauss: what it sends, and how it takes every kind of reply.

type hubCall struct{ method, path, auth, ctype string }

func testHub(t *testing.T, h http.HandlerFunc) (*httpHub, *[]hubCall) {
	t.Helper()
	var mu sync.Mutex
	calls := &[]hubCall{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		*calls = append(*calls, hubCall{r.Method, r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("Content-Type")})
		mu.Unlock()
		_, _ = io.Copy(io.Discard, r.Body)
		h(w, r)
	}))
	t.Cleanup(srv.Close)
	t.Setenv("HOME", t.TempDir())
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir(), "token"), []byte("tok-123\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	hub, err := newHTTPHub(Config{GaussURL: srv.URL})
	if err != nil {
		t.Fatal(err)
	}
	return hub, calls
}

func TestHubSendsTheTokenToEachRoute(t *testing.T) {
	key := strings.Repeat("ab", 16)
	hub, calls := testHub(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/mesh/bundles":
			_, _ = io.WriteString(w, `{"bundles":[{"id":"`+key+`","from":"a","size":3},{"id":"../etc","from":"x"}]}`)
		case r.URL.Path == "/api/mesh/bundles/status":
			_, _ = io.WriteString(w, `{"status":{"`+key+`":"delivered"}}`)
		case r.URL.Path == "/api/mesh/directory":
			_, _ = io.WriteString(w, `{"keys":[{"node":"talos"}]}`)
		case r.Method == http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost:
			w.WriteHeader(http.StatusCreated)
		default:
			_, _ = io.WriteString(w, "raw")
		}
	})
	ctx := context.Background()
	if err := hub.Put(ctx, []byte{1, 2, 3}); err != nil {
		t.Fatal(err)
	}
	items, err := hub.List(ctx)
	if err != nil || len(items) != 1 || items[0].Key != key {
		t.Fatalf("list = %+v, %v; a bad id from the hub must be dropped", items, err)
	}
	if b, err := hub.Get(ctx, key); err != nil || string(b) != "raw" {
		t.Fatalf("get = %q, %v", b, err)
	}
	if err := hub.Ack(ctx, key); err != nil {
		t.Fatal(err)
	}
	if st, err := hub.Status(ctx, []string{key}); err != nil || st[key] != "delivered" {
		t.Fatalf("status = %v, %v", st, err)
	}
	if keys, err := hub.Directory(ctx); err != nil || len(keys) != 1 || keys[0].Node != "talos" {
		t.Fatalf("directory = %+v, %v", keys, err)
	}
	if err := hub.Publish(ctx, PeerKey{Node: "talos"}); err != nil {
		t.Fatal(err)
	}
	want := []hubCall{
		{"POST", "/api/mesh/bundles", "", "application/octet-stream"},
		{"GET", "/api/mesh/bundles", "", ""},
		{"GET", "/api/mesh/bundles/" + key, "", ""},
		{"DELETE", "/api/mesh/bundles/" + key, "", ""},
		{"POST", "/api/mesh/bundles/status", "", "application/json"},
		{"GET", "/api/mesh/directory", "", ""},
		{"POST", "/api/mesh/keys", "", "application/json"},
	}
	if len(*calls) != len(want) {
		t.Fatalf("calls = %+v", *calls)
	}
	for i, c := range *calls {
		if c.auth != "Bearer tok-123" {
			t.Errorf("%s %s: auth %q", c.method, c.path, c.auth)
		}
		if c.method != want[i].method || c.path != want[i].path || c.ctype != want[i].ctype {
			t.Errorf("call %d = %+v, want %+v", i, c, want[i])
		}
	}
}

func TestHubRefusesBadIDsWithoutAsking(t *testing.T) {
	hub, calls := testHub(t, func(http.ResponseWriter, *http.Request) {})
	for _, k := range []string{"../../etc/passwd", "", strings.Repeat("A", 32), strings.Repeat("a", 33)} {
		if _, err := hub.Get(context.Background(), k); err == nil {
			t.Errorf("get %q accepted", k)
		}
		if err := hub.Ack(context.Background(), k); err == nil {
			t.Errorf("ack %q accepted", k)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("bad ids reached the hub: %+v", *calls)
	}
}

func TestHubReplyKinds(t *testing.T) {
	cases := []struct {
		name     string
		code     int
		body     string
		refused  bool
		conflict bool
		inErr    string
	}{
		{"json refusal is final", 400, `{"ok":false,"error":"bad bundle"}`, true, false, "HTTP 400"},
		{"too large is final", 413, `{"ok":false,"error":"too big"}`, true, false, "413"},
		{"key conflict", 409, `{"ok":false,"error":"different key"}`, false, true, "409"},
		{"old Gauss without the routes: retry", 404, "Cannot POST", false, false, "does not offer bundle relay"},
		{"server error: retry", 503, `{"ok":false,"error":"busy"}`, false, false, "503"},
		{"reply too large", 500, strings.Repeat("x", 8<<10), false, false, "too large"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			hub, _ := testHub(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(c.code)
				_, _ = io.WriteString(w, c.body)
			})
			err := hub.Put(context.Background(), []byte{1})
			if err == nil || !strings.Contains(err.Error(), c.inErr) {
				t.Fatalf("err = %v, want it to mention %q", err, c.inErr)
			}
			if errors.Is(err, errHubRefused) != c.refused || errors.Is(err, errHubConflict) != c.conflict {
				t.Fatalf("err = %v: refused=%v conflict=%v", err, errors.Is(err, errHubRefused), errors.Is(err, errHubConflict))
			}
		})
	}
}

func TestHubAckOfAGoneBundleIsDone(t *testing.T) {
	hub, _ := testHub(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) })
	if err := hub.Ack(context.Background(), strings.Repeat("0", 32)); err != nil {
		t.Fatalf("a 404 on ack means already gone: %v", err)
	}
}

func TestHubIgnoresProxyVariables(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("ALL_PROXY", "http://127.0.0.1:1")
	hub, calls := testHub(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusCreated) })
	if err := hub.Put(context.Background(), []byte{1}); err != nil || len(*calls) != 1 {
		t.Fatalf("a dead proxy variable must not divert the hub: %v, %d calls", err, len(*calls))
	}
}

func TestHubUnreachableIsRetryable(t *testing.T) {
	hub, _ := testHub(t, func(http.ResponseWriter, *http.Request) {})
	hub.base.Host = deadAddr(t)
	err := hub.Put(context.Background(), []byte{1})
	if err == nil || !strings.Contains(err.Error(), "hub unreachable") || errors.Is(err, errHubRefused) {
		t.Fatalf("err = %v", err)
	}
}

func TestHubOnlyTalksToThisMacOrTheTailnet(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	for _, u := range []string{"https://example.com", "http://192.168.1.10:3001", "http://10.0.0.1", "http://100.128.0.1", "http://evil.ts.net.example.com"} {
		if _, err := newHTTPHub(Config{GaussURL: u}); err == nil {
			t.Errorf("%s accepted", u)
		}
	}
	if _, err := newHTTPHub(Config{GaussURL: "http://100.100.1.2:3001"}); err == nil || !strings.Contains(err.Error(), "enroll") {
		t.Fatalf("tailnet URL without a token: %v", err)
	}
}
