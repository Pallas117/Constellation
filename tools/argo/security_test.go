package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf8"
)

// The hub and report clients carry the device token in an Authorization
// header. They must never follow a redirect: Go keeps that header on a
// same-host redirect, so a 3xx (or an https→http downgrade) would replay the
// token somewhere the Gauss API never sends it. The API itself never redirects.
func TestHubClientsDoNotFollowRedirects(t *testing.T) {
	var followed atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/elsewhere" {
			followed.Add(1)
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Redirect(w, r, "/elsewhere", http.StatusFound)
	}))
	defer srv.Close()
	t.Setenv("HOME", t.TempDir())
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(configDir(), "token"), []byte("argo_test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := Config{GaussURL: srv.URL, Device: "judith"}

	code, err := sendReport(cfg, State{})
	if err != nil {
		t.Fatal(err)
	}
	if code != http.StatusFound {
		t.Errorf("report: got HTTP %d, want the 302 itself", code)
	}

	h, err := newHTTPHub(cfg)
	if err != nil {
		t.Fatal(err)
	}
	_, code, err = h.do(context.Background(), http.MethodGet, "/api/mesh/bundles", nil, "", 4<<10)
	if err != nil {
		t.Fatal(err)
	}
	if code != http.StatusFound {
		t.Errorf("hub: got HTTP %d, want the 302 itself", code)
	}
	if n := followed.Load(); n != 0 {
		t.Errorf("the redirect target was requested %d time(s) with the token", n)
	}
}

// System tools Argo runs with user data on the command line (osascript carries
// the phone handle and text) resolve to their fixed macOS paths, not whatever a
// PATH entry puts first. Unknown names still go through PATH.
func TestToolPathPinsSystemTools(t *testing.T) {
	for name, p := range sysTools {
		if !filepath.IsAbs(p) || filepath.Base(p) != name {
			t.Errorf("sysTools[%q] = %q: must be an absolute path to that tool", name, p)
		}
		dir := filepath.Dir(p)
		if dir != "/usr/bin" && dir != "/bin" && dir != "/usr/sbin" && dir != "/sbin" {
			t.Errorf("sysTools[%q] = %q: not a system directory", name, p)
		}
	}
	if got := toolPath("argo-no-such-tool"); got != "argo-no-such-tool" {
		t.Errorf("unknown tool resolved to %q", got)
	}
	if runtime.GOOS == "darwin" {
		for _, name := range []string{"osascript", "open", "launchctl", "route", "arp", "lsof"} {
			if _, ok := sysTools[name]; !ok {
				t.Errorf("%s is not pinned", name)
			}
			if got := toolPath(name); !filepath.IsAbs(got) {
				t.Errorf("toolPath(%q) = %q, want an absolute path", name, got)
			}
		}
	}
	if got := toolPath("/usr/bin/sqlite3"); got != "/usr/bin/sqlite3" {
		t.Errorf("absolute path changed to %q", got)
	}
}

// A received file name is cut to 128 bytes without splitting a UTF-8 sequence.
func TestSafeNameKeepsValidUTF8(t *testing.T) {
	in := strings.Repeat("é", 70) + ".txt" // 144 bytes
	got := safeName(in)
	if !utf8.ValidString(got) {
		t.Errorf("safeName produced invalid UTF-8: %q", got)
	}
	if len(got) > 128 || len(got) < 126 {
		t.Errorf("len = %d, want 126..128", len(got))
	}
	if !strings.HasPrefix(got, "éé") {
		t.Errorf("got %q", got)
	}
}
