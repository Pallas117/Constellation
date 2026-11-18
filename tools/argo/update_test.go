package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Every key here is made in the test and thrown away; no release key exists.

var updNow = time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

const updPlatform = "linux/arm64"

func script(ver string) []byte { return []byte("#!/bin/sh\necho argo " + ver + "\n") }

type release struct {
	t      *testing.T
	pub    ed25519.PublicKey
	priv   ed25519.PrivateKey
	srv    *httptest.Server
	hits   atomic.Int64
	files  map[string][]byte // path → body
	status map[string]int    // path → status override
	redir  map[string]string // path → Location
}

func newRelease(t *testing.T, tlsServer bool) *release {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	r := &release{t: t, pub: pub, priv: priv, files: map[string][]byte{}, status: map[string]int{}, redir: map[string]string{}}
	h := http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		r.hits.Add(1)
		if loc, ok := r.redir[q.URL.Path]; ok {
			http.Redirect(w, q, loc, http.StatusFound)
			return
		}
		b, ok := r.files[q.URL.Path]
		if !ok {
			http.NotFound(w, q)
			return
		}
		if s := r.status[q.URL.Path]; s != 0 {
			w.WriteHeader(s)
		}
		_, _ = w.Write(b)
	})
	if tlsServer {
		r.srv = httptest.NewTLSServer(h)
	} else {
		r.srv = httptest.NewServer(h) // loopback: allowed over plain http by the hub's URL rule
	}
	t.Cleanup(r.srv.Close)
	return r
}

func sign(priv ed25519.PrivateKey, raw []byte) []byte {
	return []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, append([]byte(manifestContext), raw...))))
}

// publish serves a manifest for bin at version ver and returns it; edit lets a test bend it before signing.
func (r *release) publish(ver string, bin []byte, edit func(*Manifest)) Manifest {
	sum := sha256.Sum256(bin)
	m := Manifest{Version: ver, Commit: "0123abc", Created: updNow.Add(-time.Hour), Expires: updNow.Add(7 * 24 * time.Hour),
		Artifacts: map[string]Artifact{updPlatform: {URL: r.srv.URL + "/argo-bin", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(bin))}}}
	if edit != nil {
		edit(&m)
	}
	raw, _ := json.Marshal(m)
	r.files["/manifest.json"] = raw
	r.files["/manifest.json.sig"] = sign(r.priv, raw)
	r.files["/argo-bin"] = bin
	return m
}

func (r *release) url() string { return r.srv.URL + "/manifest.json" }

// updaterFor is an updater running 0.1.0 whose target is a throwaway script in a temp dir.
func (r *release) updaterFor(t *testing.T) updater {
	t.Helper()
	dir := t.TempDir()
	target := filepath.Join(dir, "argo")
	if err := os.WriteFile(target, script("0.1.0"), 0o755); err != nil {
		t.Fatal(err)
	}
	goos, goarch, _ := strings.Cut(updPlatform, "/")
	return updater{pub: r.pub, client: newUpdateClient(nil), running: "0.1.0", goos: goos, goarch: goarch,
		now: func() time.Time { return updNow }, store: Store{Dir: t.TempDir()}, target: target}
}

func checkAndApply(u updater, src string) error {
	m, a, err := u.check(context.Background(), src)
	if err != nil {
		return err
	}
	return u.apply(context.Background(), m, a)
}

// untouched fails the test unless the target is still the 0.1.0 script and no temp file is left.
func untouched(t *testing.T, u updater) {
	t.Helper()
	if b, _ := os.ReadFile(u.target); !bytes.Equal(b, script("0.1.0")) {
		t.Errorf("the installed binary changed: %q", b)
	}
	names, _ := os.ReadDir(filepath.Dir(u.target))
	for _, n := range names {
		if n.Name() != "argo" && n.Name() != "argo.prev" {
			t.Errorf("left behind: %s", n.Name())
		}
	}
}

func TestUpdateNoKeyPinnedOnlyReports(t *testing.T) {
	if pinnedReleaseKey() != nil && releasePublicKey == "" {
		t.Fatal("an empty placeholder must mean no key")
	}
	for _, bad := range []string{"", "not base64!", base64.StdEncoding.EncodeToString([]byte("short"))} {
		old := releasePublicKey
		releasePublicKey = bad
		if pinnedReleaseKey() != nil {
			t.Errorf("%q accepted as a release key", bad)
		}
		releasePublicKey = old
	}
	r := newRelease(t, false)
	r.publish("0.2.0", script("0.2.0"), nil)
	u := r.updaterFor(t)
	u.pub = nil
	var out bytes.Buffer
	if err := updateCmd(context.Background(), []string{"check", "--manifest", r.url()}, Config{}, u, &out); err != nil {
		t.Fatalf("check without a key should only report: %v", err)
	}
	if !strings.Contains(out.String(), "No release key is pinned") {
		t.Errorf("check does not say why: %s", out.String())
	}
	err := updateCmd(context.Background(), []string{"apply", "--manifest", r.url()}, Config{}, u, &out)
	if !errors.Is(err, errNoReleaseKey) {
		t.Errorf("apply without a key: %v", err)
	}
	if r.hits.Load() != 0 {
		t.Errorf("fetched %d times with no key to verify against", r.hits.Load())
	}
	untouched(t, u)
}

func TestUpdateRefusesBadOrMissingSignature(t *testing.T) {
	_, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	cases := map[string]func(r *release){
		"missing signature":     func(r *release) { delete(r.files, "/manifest.json.sig") },
		"empty signature":       func(r *release) { r.files["/manifest.json.sig"] = nil },
		"signed by another key": func(r *release) { r.files["/manifest.json.sig"] = sign(otherPriv, r.files["/manifest.json"]) },
		"manifest changed after": func(r *release) {
			r.files["/manifest.json"] = bytes.Replace(r.files["/manifest.json"], []byte("0.2.0"), []byte("0.9.0"), 1)
		},
		"signature without context": func(r *release) {
			r.files["/manifest.json.sig"] = []byte(base64.StdEncoding.EncodeToString(ed25519.Sign(r.priv, r.files["/manifest.json"])))
		},
		"signature not base64": func(r *release) { r.files["/manifest.json.sig"] = []byte("AAAA not a signature") },
	}
	for name, bend := range cases {
		t.Run(name, func(t *testing.T) {
			r := newRelease(t, false)
			r.publish("0.2.0", script("0.2.0"), nil)
			bend(r)
			u := r.updaterFor(t)
			if err := checkAndApply(u, r.url()); !errors.Is(err, errBadSignature) {
				t.Fatalf("want bad signature, got %v", err)
			}
			untouched(t, u)
			if st := u.store.loadUpdateState(); !st.CheckedAt.IsZero() || st.Available || st.HighestSeen != "" {
				t.Errorf("an unverified manifest was recorded: %+v", st)
			}
		})
	}
}

func TestUpdateRefusesExpiredManifest(t *testing.T) {
	for name, edit := range map[string]func(*Manifest){
		"expired":         func(m *Manifest) { m.Created, m.Expires = updNow.Add(-48*time.Hour), updNow.Add(-time.Second) },
		"no expiry":       func(m *Manifest) { m.Expires = time.Time{} },
		"valid too long":  func(m *Manifest) { m.Expires = m.Created.Add(maxManifestLife + time.Hour) },
		"from the future": func(m *Manifest) { m.Created, m.Expires = updNow.Add(48*time.Hour), updNow.Add(72*time.Hour) },
	} {
		t.Run(name, func(t *testing.T) {
			r := newRelease(t, false)
			r.publish("0.2.0", script("0.2.0"), edit)
			u := r.updaterFor(t)
			err := checkAndApply(u, r.url())
			if err == nil {
				t.Fatal("accepted")
			}
			if name == "expired" && !errors.Is(err, errExpired) {
				t.Errorf("want expired, got %v", err)
			}
			untouched(t, u)
		})
	}
}

func TestUpdateRefusesDowngradeAndReplay(t *testing.T) {
	for _, ver := range []string{"0.1.0", "0.0.9", "v0.1.0"} {
		r := newRelease(t, false)
		r.publish(ver, script(ver), nil)
		u := r.updaterFor(t)
		if err := checkAndApply(u, r.url()); !errors.Is(err, errNotNewer) {
			t.Errorf("%s over 0.1.0: want not newer, got %v", ver, err)
		}
		untouched(t, u)
	}
	// Replay: this device has verified 0.3.0; an older, still valid, correctly signed 0.2.0 is refused.
	r := newRelease(t, false)
	u := r.updaterFor(t)
	r.publish("0.3.0", script("0.3.0"), nil)
	if _, _, err := u.check(context.Background(), r.url()); err != nil {
		t.Fatal(err)
	}
	r.publish("0.2.0", script("0.2.0"), nil)
	if err := checkAndApply(u, r.url()); !errors.Is(err, errRollback) {
		t.Errorf("replayed older manifest: want rollback, got %v", err)
	}
	if st := u.store.loadUpdateState(); st.HighestSeen != "0.3.0" || st.Latest != "0.3.0" || !st.Available {
		t.Errorf("the replay changed what the device knows: %+v", st)
	}
	untouched(t, u)
	// A running version that is not a version cannot prove anything is newer.
	r.publish("0.4.0", script("0.4.0"), nil)
	u.running = "dev"
	if err := checkAndApply(u, r.url()); err == nil {
		t.Error("applied over an unparseable running version")
	}
	for _, c := range []struct {
		a, b string
		want int
	}{{"0.2.0", "0.10.0", -1}, {"1.0.0", "0.99.99", 1}, {"0.1.0+abc123", "0.1.0", 0}} {
		if got, ok := versionCmp(c.a, c.b); !ok || got != c.want {
			t.Errorf("versionCmp(%s, %s) = %d %v", c.a, c.b, got, ok)
		}
	}
	for _, bad := range []string{"", "1.2", "1.2.3-rc1", "1.2.x", "latest", "1.2.3.4"} {
		if _, ok := parseVersion(bad); ok {
			t.Errorf("%q parsed as a version", bad)
		}
	}
}

func TestUpdateRefusesWrongPlatform(t *testing.T) {
	r := newRelease(t, false)
	r.publish("0.2.0", script("0.2.0"), func(m *Manifest) {
		m.Artifacts = map[string]Artifact{"windows/amd64": m.Artifacts[updPlatform]}
	})
	u := r.updaterFor(t)
	if err := checkAndApply(u, r.url()); !errors.Is(err, errWrongPlatform) {
		t.Fatalf("want wrong platform, got %v", err)
	}
	untouched(t, u)
	if st := u.store.loadUpdateState(); st.Available {
		t.Error("a release with no build for this platform was reported as available")
	}
}

func TestUpdateRefusesSizeAndHashMismatch(t *testing.T) {
	good := script("0.2.0")
	cases := map[string]func(r *release, m *Manifest){
		"size over the cap": func(_ *release, m *Manifest) {
			a := m.Artifacts[updPlatform]
			a.Size = maxArtifactBytes + 1
			m.Artifacts[updPlatform] = a
		},
		"zero size": func(_ *release, m *Manifest) {
			a := m.Artifacts[updPlatform]
			a.Size = 0
			m.Artifacts[updPlatform] = a
		},
		"no hash": func(_ *release, m *Manifest) {
			a := m.Artifacts[updPlatform]
			a.SHA256 = "abcd"
			m.Artifacts[updPlatform] = a
		},
		"download longer than signed": func(r *release, _ *Manifest) {
			r.files["/argo-bin"] = append(append([]byte{}, good...), "echo extra\n"...)
		},
		"download shorter than signed": func(r *release, _ *Manifest) { r.files["/argo-bin"] = good[:len(good)-3] },
		"same size, other bytes":       func(r *release, _ *Manifest) { r.files["/argo-bin"] = script("0.2.1") },
	}
	for name, bend := range cases {
		t.Run(name, func(t *testing.T) {
			r := newRelease(t, false)
			r.publish("0.2.0", good, func(m *Manifest) { bend(r, m) })
			bend(r, &Manifest{Artifacts: map[string]Artifact{}}) // publish resets the served binary: bend it again
			u := r.updaterFor(t)
			if err := checkAndApply(u, r.url()); err == nil {
				t.Fatal("applied")
			}
			untouched(t, u)
		})
	}
}

func TestUpdateURLRule(t *testing.T) {
	for _, ok := range []string{"https://releases.example/argo/manifest.json", "http://127.0.0.1:3001/m.json", "http://localhost:3001/m.json",
		"http://100.101.102.103:3001/m.json", "http://hub.tail1234.ts.net/m.json", "https://hub.tail1234.ts.net/m.json"} {
		if _, err := updateURL(ok); err != nil {
			t.Errorf("%s refused: %v", ok, err)
		}
	}
	for _, bad := range []string{"http://releases.example/m.json", "http://192.168.1.10/m.json", "ftp://127.0.0.1/m.json", "file:///tmp/m.json",
		"https://user:secret@releases.example/m.json", "//releases.example/m.json", "https:///m.json", ""} {
		if _, err := updateURL(bad); err == nil {
			t.Errorf("%q accepted", bad)
		} else if strings.Contains(err.Error(), "secret") {
			t.Errorf("the error repeats a credential: %v", err)
		}
	}
	// The same rule covers the build's URL inside a signed manifest.
	r := newRelease(t, false)
	r.publish("0.2.0", script("0.2.0"), func(m *Manifest) {
		a := m.Artifacts[updPlatform]
		a.URL = "http://releases.example/argo"
		m.Artifacts[updPlatform] = a
	})
	u := r.updaterFor(t)
	if err := checkAndApply(u, r.url()); err == nil {
		t.Error("a plain-http public download was accepted")
	}
	untouched(t, u)
}

func TestUpdateFollowsNoRedirectAndUsesNoProxy(t *testing.T) {
	c := newUpdateClient(nil)
	if tr := c.Transport.(*http.Transport); tr.Proxy != nil {
		t.Error("the update client would read proxy variables")
	} else if tr.TLSClientConfig != nil && tr.TLSClientConfig.InsecureSkipVerify {
		t.Error("TLS verification is off")
	}
	elsewhere := newRelease(t, false) // a valid, correctly signed release on another server
	elsewhere.publish("0.2.0", script("0.2.0"), nil)
	r := newRelease(t, false)
	r.pub, r.priv = elsewhere.pub, elsewhere.priv
	r.redir["/manifest.json"] = elsewhere.url()
	r.redir["/manifest.json.sig"] = elsewhere.url() + ".sig"
	u := r.updaterFor(t)
	err := checkAndApply(u, r.url())
	if err == nil || !strings.Contains(err.Error(), "redirect refused") {
		t.Fatalf("redirected manifest: %v", err)
	}
	if elsewhere.hits.Load() != 0 {
		t.Error("the redirect was followed")
	}
	// A redirected download is refused too.
	r2 := newRelease(t, false)
	r2.publish("0.2.0", script("0.2.0"), nil)
	r2.redir["/argo-bin"] = elsewhere.srv.URL + "/argo-bin"
	u2 := r2.updaterFor(t)
	if err := checkAndApply(u2, r2.url()); err == nil || !strings.Contains(err.Error(), "redirect refused") {
		t.Fatalf("redirected download: %v", err)
	}
	untouched(t, u2)
}

func TestUpdateOverHTTPSChecksTheCertificate(t *testing.T) {
	r := newRelease(t, true)
	r.publish("0.2.0", script("0.2.0"), nil)
	u := r.updaterFor(t) // system roots: the test server's certificate is not trusted
	if err := checkAndApply(u, r.url()); err == nil {
		t.Fatal("an untrusted certificate was accepted")
	}
	untouched(t, u)
	roots := x509.NewCertPool()
	roots.AddCert(r.srv.Certificate())
	u.client = newUpdateClient(roots)
	if err := checkAndApply(u, r.url()); err != nil {
		t.Fatalf("trusted https: %v", err)
	}
	if err := reportsVersion(context.Background(), u.target, "0.2.0"); err != nil {
		t.Error(err)
	}
}

func TestUpdateApplyKeepsBackupAndIsAtomic(t *testing.T) {
	r := newRelease(t, false)
	r.publish("0.2.0", script("0.2.0"), nil)
	u := r.updaterFor(t)
	if err := os.Chmod(u.target, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := checkAndApply(u, r.url()); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(u.target); !bytes.Equal(b, script("0.2.0")) {
		t.Errorf("target is %q", b)
	}
	if b, _ := os.ReadFile(u.target + ".prev"); !bytes.Equal(b, script("0.1.0")) {
		t.Errorf("backup is %q", b)
	}
	for _, p := range []string{u.target, u.target + ".prev"} {
		if fi, err := os.Stat(p); err != nil || fi.Mode().Perm() != 0o750 {
			t.Errorf("%s: mode %v %v", filepath.Base(p), fi.Mode().Perm(), err)
		}
	}
	names, _ := os.ReadDir(filepath.Dir(u.target))
	if len(names) != 2 {
		t.Errorf("temp files left: %v", names)
	}
	fi, err := os.Stat(u.store.path("update.json"))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("update state: %v %v", fi, err)
	}
}

func TestUpdateNewBinaryMustRunFirst(t *testing.T) {
	for name, bin := range map[string][]byte{
		"does not run":   []byte("this is not a program"),
		"exits non-zero": []byte("#!/bin/sh\necho argo 0.2.0\nexit 3\n"),
		"other version":  script("0.2.1"),
		"other program":  []byte("#!/bin/sh\necho hello 0.2.0\n"),
	} {
		t.Run(name, func(t *testing.T) {
			r := newRelease(t, false)
			r.publish("0.2.0", bin, nil)
			u := r.updaterFor(t)
			if err := checkAndApply(u, r.url()); err == nil {
				t.Fatal("applied")
			}
			untouched(t, u)
			if _, err := os.Stat(u.target + ".prev"); err == nil {
				t.Error("a backup was made although nothing was replaced")
			}
		})
	}
}

func TestUpdateRestoresPreviousWhenNewOneFailsInPlace(t *testing.T) {
	// Runs from its download name, fails once it is installed as "argo".
	bin := []byte("#!/bin/sh\ncase \"$0\" in *.argo-update-*) echo argo 0.2.0 ;; *) exit 1 ;; esac\n")
	r := newRelease(t, false)
	r.publish("0.2.0", bin, nil)
	u := r.updaterFor(t)
	err := checkAndApply(u, r.url())
	if err == nil || !strings.Contains(err.Error(), "previous Argo was put back") {
		t.Fatalf("want a restore, got %v", err)
	}
	if b, _ := os.ReadFile(u.target); !bytes.Equal(b, script("0.1.0")) {
		t.Errorf("the previous binary was not restored: %q", b)
	}
	if err := reportsVersion(context.Background(), u.target, "0.1.0"); err != nil {
		t.Error(err)
	}
}

func TestUpdateApplyOnMacNeedsExplicitFlag(t *testing.T) {
	r := newRelease(t, false)
	r.publish("0.2.0", script("0.2.0"), func(m *Manifest) {
		m.Artifacts = map[string]Artifact{"darwin/arm64": m.Artifacts[updPlatform]}
	})
	u := r.updaterFor(t)
	u.goos, u.goarch = "darwin", "arm64"
	var out bytes.Buffer
	if err := updateCmd(context.Background(), []string{"--manifest", r.url()}, Config{}, u, &out); err != nil {
		t.Fatalf("check is the default: %v", err)
	}
	if !strings.Contains(out.String(), "Update available: 0.2.0") || !strings.Contains(out.String(), "nothing updates by itself") {
		t.Errorf("check output: %s", out.String())
	}
	untouched(t, u)
	out.Reset()
	if err := updateCmd(context.Background(), []string{"apply", "--manifest", r.url()}, Config{}, u, &out); err == nil {
		t.Fatal("apply on macOS ran without the flag")
	}
	for _, want := range []string{"resets the permissions", "stable signing identity", macApplyFlag} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("refusal lacks %q: %s", want, out.String())
		}
	}
	untouched(t, u)
	if err := updateCmd(context.Background(), []string{"apply", "--manifest", r.url(), macApplyFlag}, Config{}, u, &out); err != nil {
		t.Fatalf("apply with the flag: %v", err)
	}
	if err := reportsVersion(context.Background(), u.target, "0.2.0"); err != nil {
		t.Error(err)
	}
	if err := updateCmd(context.Background(), []string{"install"}, Config{}, u, &out); err == nil {
		t.Error("an unknown subcommand was accepted")
	}
}

func TestUpdateTickOnlyChecksAndAtMostDaily(t *testing.T) {
	r := newRelease(t, false)
	r.publish("0.9.0", script("0.9.0"), func(m *Manifest) { // real clock in the tick: valid around now
		m.Created, m.Expires = time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour)
		m.Artifacts = map[string]Artifact{"darwin/arm64": m.Artifacts[updPlatform], "darwin/amd64": m.Artifacts[updPlatform],
			"linux/arm64": m.Artifacts[updPlatform], "linux/amd64": m.Artifacts[updPlatform]}
	})
	t.Setenv("ARGO_UPDATE_MANIFEST", r.url())
	s := Store{Dir: t.TempDir()}
	now := time.Now()

	updateTick(context.Background(), Config{}, s, now) // no key pinned: nothing at all
	if _, err := os.Stat(s.path("update.json")); err == nil || r.hits.Load() != 0 {
		t.Fatalf("the tick acted with no release key (hits %d)", r.hits.Load())
	}

	old := releasePublicKey
	releasePublicKey = base64.StdEncoding.EncodeToString(r.pub)
	defer func() { releasePublicKey = old }()
	updateTick(context.Background(), Config{}, s, now)
	updateTick(context.Background(), Config{}, s, now.Add(time.Hour))
	updateTick(context.Background(), Config{}, s, now.Add(23*time.Hour))
	if r.hits.Load() != 2 { // manifest + signature, once
		t.Errorf("fetched %d times in a day, want one check (2 requests)", r.hits.Load())
	}
	st := s.loadUpdateState()
	if !st.Available || st.Latest != "0.9.0" || st.Running != version {
		t.Errorf("state: %+v", st)
	}
	if _, ok := r.files["/argo-bin"]; !ok || r.hits.Load() != 2 {
		t.Error("the tick downloaded a build")
	}
	// The posture item follows the verified check.
	e := postureEnv{now: now, keyPinned: true, update: st}
	if it := argoItem(e); it.Status != postureWarn {
		t.Errorf("argo item with an update available: %+v", it)
	}
}
