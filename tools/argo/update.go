package main

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// `argo update` (GAU-238): signed releases, so "Argo on every device" can be
// kept current without trusting the network or the hub. Design and threat
// model: docs/ARGO_UPDATE.md. Nothing here applies an update by itself.
//
// Trust comes from one place: the Ed25519 release public key compiled into
// this binary. The manifest's detached signature is verified with it before
// a single field of the manifest is read.

// releasePublicKey is the pinned release key: base64 (standard) of the 32-byte
// Ed25519 public key. EMPTY = no key pinned: `argo update` then fetches
// nothing and refuses to apply. Josh sets it once a release key exists; the
// private key never enters this repository.
var releasePublicKey = ""

// manifestContext is signed in front of the manifest bytes, so a signature
// made by the release key for anything else is never a valid manifest
// signature.
const manifestContext = "argo-release-manifest-v1\n"

const (
	maxManifestBytes  = 64 << 10
	maxArtifactBytes  = 100 << 20
	maxManifestLife   = 90 * 24 * time.Hour // a manifest valid for longer is refused: it would let an old list be replayed for too long
	updateCheckEvery  = 24 * time.Hour
	updateManifestURI = "/argo/release/manifest.json" // proposed hub path (docs/ARGO_UPDATE.md); no route serves it yet
)

var (
	errNoReleaseKey  = errors.New("no release key pinned")
	errBadSignature  = errors.New("manifest signature is missing or wrong")
	errExpired       = errors.New("manifest has expired")
	errNotNewer      = errors.New("manifest version is not newer than this Argo")
	errRollback      = errors.New("manifest is older than one this device has already seen")
	errWrongPlatform = errors.New("manifest has no build for this platform")
)

// Manifest is one release: a build per GOOS/GOARCH.
type Manifest struct {
	Version   string              `json:"version"` // MAJOR.MINOR.PATCH
	Commit    string              `json:"commit"`
	Created   time.Time           `json:"created"`
	Expires   time.Time           `json:"expires"`
	Artifacts map[string]Artifact `json:"artifacts"` // "darwin/arm64" → build
}

// Artifact is the binary for one platform.
type Artifact struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"` // hex
	Size   int64  `json:"size"`   // bytes
}

func pinnedReleaseKey() ed25519.PublicKey {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(releasePublicKey))
	if err != nil || len(b) != ed25519.PublicKeySize {
		return nil
	}
	return ed25519.PublicKey(b)
}

var reSemver = regexp.MustCompile(`^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$`)

// parseVersion reads MAJOR.MINOR.PATCH. Build metadata after "+" is ignored
// (a stamped commit); anything else is not a version.
func parseVersion(s string) ([3]int, bool) {
	s, _, _ = strings.Cut(s, "+")
	m := reSemver.FindStringSubmatch(s)
	if m == nil {
		return [3]int{}, false
	}
	var v [3]int
	for i := range v {
		v[i], _ = strconv.Atoi(m[i+1])
	}
	return v, true
}

// versionCmp is -1, 0 or 1; ok is false when either is not a version.
func versionCmp(a, b string) (int, bool) {
	x, ok1 := parseVersion(a)
	y, ok2 := parseVersion(b)
	if !ok1 || !ok2 {
		return 0, false
	}
	for i := range x {
		if x[i] != y[i] {
			if x[i] < y[i] {
				return -1, true
			}
			return 1, true
		}
	}
	return 0, true
}

// updateURL is the fetch rule: https anywhere (certificate checked), plain
// http only where the hub client allows it (this machine or a tailnet
// address, tailnetOnly). No other scheme, no credentials in the URL.
func updateURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, errors.New("update URL does not parse")
	}
	if u.User != nil {
		return nil, errors.New("update URL must not carry credentials")
	}
	switch u.Scheme {
	case "https":
		if u.Hostname() == "" {
			return nil, errors.New("update URL has no host")
		}
		return u, nil
	case "http":
		if _, err := tailnetOnly(raw); err != nil {
			return nil, fmt.Errorf("plain http is only allowed from this machine or the tailnet: %q", u.Hostname())
		}
		return u, nil
	}
	return nil, fmt.Errorf("update URL scheme %q is not https", u.Scheme)
}

// newUpdateClient never follows a redirect and never uses a proxy from the
// environment. TLS verification stays on; roots is nil for the system roots
// (tests pass their own test server's certificate).
func newUpdateClient(roots *x509.CertPool) *http.Client {
	tr := &http.Transport{Proxy: nil, ResponseHeaderTimeout: 20 * time.Second}
	if roots != nil {
		tr.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	return &http.Client{
		Timeout:       10 * time.Minute,
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

type updater struct {
	pub     ed25519.PublicKey
	client  *http.Client
	running string // this binary's version
	goos    string
	goarch  string
	now     func() time.Time
	store   Store
	target  string // the binary to replace; "" = this executable
}

func newUpdater(s Store) updater {
	return updater{pub: pinnedReleaseKey(), client: newUpdateClient(nil), running: version,
		goos: runtime.GOOS, goarch: runtime.GOARCH, now: time.Now, store: s}
}

// get fetches at most max bytes from a URL that passes updateURL. A redirect
// is an error, as is any status but 200.
func (u updater) get(ctx context.Context, raw string, max int64) ([]byte, error) {
	resp, err := u.open(ctx, raw)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > max {
		return nil, fmt.Errorf("response is larger than %d bytes", max)
	}
	return b, nil
}

func (u updater) open(ctx context.Context, raw string) (*http.Response, error) {
	pu, err := updateURL(raw)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pu.String(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := u.client.Do(req)
	if err != nil {
		return nil, errors.New(Mask(err.Error()))
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		if resp.StatusCode >= 300 && resp.StatusCode < 400 {
			return nil, fmt.Errorf("redirect refused (HTTP %d): updates are fetched from the given address only", resp.StatusCode)
		}
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return resp, nil
}

// verifyManifest is the whole trust decision, in order: signature, then
// expiry, then version, then platform, then the artifact's own limits.
// highestSeen is the newest version this device has verified before ("" = none).
func verifyManifest(raw, sig []byte, pub ed25519.PublicKey, now time.Time, running, highestSeen, platform string) (Manifest, Artifact, error) {
	var m Manifest
	if len(pub) != ed25519.PublicKeySize {
		return m, Artifact{}, errNoReleaseKey
	}
	sigBytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil || len(sigBytes) != ed25519.SignatureSize || len(raw) == 0 || len(raw) > maxManifestBytes ||
		!ed25519.Verify(pub, append([]byte(manifestContext), raw...), sigBytes) {
		return m, Artifact{}, errBadSignature
	}
	// Signed by the release key from here on; the checks below guard against an old or mistaken release.
	if err := json.Unmarshal(raw, &m); err != nil {
		return Manifest{}, Artifact{}, errors.New("signed manifest is not valid JSON")
	}
	switch {
	case m.Created.IsZero() || m.Expires.IsZero() || !m.Expires.After(m.Created):
		return m, Artifact{}, errors.New("manifest lacks a created or expiry time")
	case !now.Before(m.Expires):
		return m, Artifact{}, errExpired
	case m.Expires.Sub(m.Created) > maxManifestLife:
		return m, Artifact{}, fmt.Errorf("manifest is valid for more than %d days", int(maxManifestLife.Hours()/24))
	case m.Created.After(now.Add(24 * time.Hour)):
		return m, Artifact{}, errors.New("manifest is dated in the future (check this device's clock)")
	}
	cmp, ok := versionCmp(m.Version, running)
	if !ok {
		return m, Artifact{}, fmt.Errorf("cannot compare versions (this Argo %q, manifest %q)", running, m.Version)
	}
	if highestSeen != "" {
		if c, ok := versionCmp(m.Version, highestSeen); ok && c < 0 {
			return m, Artifact{}, errRollback
		}
	}
	if cmp <= 0 {
		return m, Artifact{}, errNotNewer
	}
	a, ok := m.Artifacts[platform]
	if !ok {
		return m, Artifact{}, errWrongPlatform
	}
	if a.Size <= 0 || a.Size > maxArtifactBytes {
		return m, Artifact{}, fmt.Errorf("build size %d is outside 1 byte to %d MB", a.Size, maxArtifactBytes>>20)
	}
	if h, err := hex.DecodeString(a.SHA256); err != nil || len(h) != sha256.Size {
		return m, Artifact{}, errors.New("build has no SHA-256")
	}
	if _, err := updateURL(a.URL); err != nil {
		return m, Artifact{}, err
	}
	return m, a, nil
}

// updateState is ~/.local/state/argo/update.json (0600): what the last
// verified check found, and the newest version ever verified (the rollback floor).
type updateState struct {
	AttemptAt   time.Time `json:"attempt_at,omitempty"` // last try, verified or not (daily throttle)
	CheckedAt   time.Time `json:"checked_at,omitempty"` // last check whose signature verified
	Running     string    `json:"running,omitempty"`    // the version that ran that check
	Latest      string    `json:"latest,omitempty"`
	Available   bool      `json:"available,omitempty"`
	HighestSeen string    `json:"highest_seen,omitempty"`
}

func (s Store) loadUpdateState() updateState {
	var st updateState
	if b, err := os.ReadFile(s.path("update.json")); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	return st
}

// check fetches and verifies the manifest. errNotNewer means "up to date"
// and is recorded as a good check; every other error leaves the last verified
// result alone.
func (u updater) check(ctx context.Context, manifestURL string) (Manifest, Artifact, error) {
	if len(u.pub) != ed25519.PublicKeySize {
		return Manifest{}, Artifact{}, errNoReleaseKey
	}
	st := u.store.loadUpdateState()
	st.AttemptAt = u.now()
	_ = writeJSON0600(u.store, "update.json", st)
	raw, err := u.get(ctx, manifestURL, maxManifestBytes)
	if err != nil {
		return Manifest{}, Artifact{}, fmt.Errorf("manifest: %w", err)
	}
	sig, err := u.get(ctx, manifestURL+".sig", 1024)
	if err != nil {
		return Manifest{}, Artifact{}, fmt.Errorf("%w (%v)", errBadSignature, err)
	}
	m, a, err := verifyManifest(raw, sig, u.pub, u.now(), u.running, st.HighestSeen, u.goos+"/"+u.goarch)
	if err == nil || errors.Is(err, errNotNewer) || errors.Is(err, errWrongPlatform) {
		// The signature, expiry and rollback floor all held: remember what was seen.
		if c, ok := versionCmp(m.Version, st.HighestSeen); st.HighestSeen == "" || ok && c > 0 {
			st.HighestSeen = m.Version
		}
		if !errors.Is(err, errWrongPlatform) { // a release without a build for this platform says nothing about this device
			st.CheckedAt, st.Running, st.Latest, st.Available = u.now(), u.running, m.Version, err == nil
		}
		_ = writeJSON0600(u.store, "update.json", st)
	}
	return m, a, err
}

// download writes the build to a new 0600 file next to the target and
// returns its path only if the size and SHA-256 match the signed manifest.
func (u updater) download(ctx context.Context, a Artifact, dir string) (string, error) {
	resp, err := u.open(ctx, a.URL)
	if err != nil {
		return "", fmt.Errorf("download: %w", err)
	}
	defer resp.Body.Close()
	f, err := os.CreateTemp(dir, ".argo-update-*") // 0600, same directory so the rename is atomic
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	fail := func(e error) (string, error) {
		f.Close()
		os.Remove(tmp)
		return "", e
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, a.Size+1))
	if err != nil {
		return fail(fmt.Errorf("download: %w", err))
	}
	if n != a.Size {
		return fail(fmt.Errorf("download is not the signed size (%d bytes expected)", a.Size))
	}
	want, _ := hex.DecodeString(a.SHA256)
	if subtle.ConstantTimeCompare(h.Sum(nil), want) != 1 {
		return fail(errors.New("download does not match the signed SHA-256"))
	}
	if err := f.Sync(); err != nil {
		return fail(err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return "", err
	}
	return tmp, nil
}

// reportsVersion runs `<bin> version` and wants "argo <want>" back.
func reportsVersion(ctx context.Context, bin, want string) error {
	c, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(c, bin, "version")
	cmd.Env = []string{"HOME=" + home(), "PATH=/usr/bin:/bin", "ARGO_NO_DESKTOP=1"}
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("the new build did not run: %v", err)
	}
	f := strings.Fields(string(out))
	if len(f) < 2 || f[0] != "argo" || strings.TrimPrefix(f[1], "v") != strings.TrimPrefix(want, "v") {
		return fmt.Errorf("the new build does not report version %s", want)
	}
	return nil
}

// apply replaces the target binary with the verified build. Order: download
// and hash, run it, keep the old binary as <target>.prev, rename over the
// target (atomic), run it again, and put the old one back if that fails.
func (u updater) apply(ctx context.Context, m Manifest, a Artifact) error {
	target := u.target
	if target == "" {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		if target, err = filepath.EvalSymlinks(exe); err != nil {
			return err
		}
	}
	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("the Argo binary to replace was not found")
	}
	tmp, err := u.download(ctx, a, filepath.Dir(target))
	if err != nil {
		return err
	}
	defer os.Remove(tmp) // a no-op once renamed
	if err := os.Chmod(tmp, 0o700); err != nil {
		return err
	}
	if err := reportsVersion(ctx, tmp, m.Version); err != nil {
		return err
	}
	backup := target + ".prev"
	if err := copyFile(target, backup, info.Mode().Perm()); err != nil {
		return fmt.Errorf("could not keep a backup of the current Argo: %w", err)
	}
	if err := os.Chmod(tmp, info.Mode().Perm()); err != nil {
		return err
	}
	if err := os.Rename(tmp, target); err != nil {
		return err
	}
	if err := reportsVersion(ctx, target, m.Version); err != nil {
		if rerr := os.Rename(backup, target); rerr != nil {
			return fmt.Errorf("%v; restoring the previous Argo also failed (%v): copy %s back by hand", err, rerr, filepath.Base(backup))
		}
		return fmt.Errorf("%v; the previous Argo was put back", err)
	}
	return nil
}

// copyFile copies src to dst through a temp file in the same directory.
func copyFile(src, dst string, perm os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.CreateTemp(filepath.Dir(dst), ".argo-prev-*")
	if err != nil {
		return err
	}
	defer os.Remove(out.Name())
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	if err := os.Chmod(out.Name(), perm); err != nil {
		return err
	}
	return os.Rename(out.Name(), dst)
}

// manifestURLFor picks where the manifest is read from: the flag, then
// ARGO_UPDATE_MANIFEST, then the Gauss hub this device is enrolled with.
func manifestURLFor(flagURL string, cfg Config) string {
	switch {
	case flagURL != "":
		return flagURL
	case os.Getenv("ARGO_UPDATE_MANIFEST") != "":
		return os.Getenv("ARGO_UPDATE_MANIFEST")
	case cfg.GaussURL != "":
		return strings.TrimRight(cfg.GaussURL, "/") + updateManifestURI
	}
	return ""
}

const macApplyFlag = "--reset-mac-permissions"

const macApplyWhy = "Not applied. On macOS, replacing the Argo binary resets the permissions you granted it (Messages automation for phone texts, Full Disk Access) until you allow them again at the Mac, because Argo does not yet have a stable signing identity.\nTo update anyway while you are at the Mac: argo update apply " + macApplyFlag + "\nAfterwards run `argo phone test` and click Allow."

// updateCmd is `argo update [check|apply] [--manifest URL] [--reset-mac-permissions]`.
func updateCmd(ctx context.Context, args []string, cfg Config, u updater, w io.Writer) error {
	sub, flagURL, macOK := "check", "", false
	for i := 0; i < len(args); i++ {
		switch a := args[i]; {
		case i == 0 && (a == "check" || a == "apply"):
			sub = a
		case a == "--manifest" && i+1 < len(args):
			i++
			flagURL = args[i]
		case a == macApplyFlag:
			macOK = true
		default:
			return errors.New("usage: argo update [check|apply] [--manifest URL] [" + macApplyFlag + "]")
		}
	}
	fmt.Fprintf(w, "argo %s (%s/%s)\n", u.running, u.goos, u.goarch)
	if len(u.pub) != ed25519.PublicKeySize {
		fmt.Fprintln(w, "No release key is pinned in this build, so no release list can be trusted. Nothing was fetched; updates stay manual (docs/ARGO_UPDATE.md).")
		if sub == "apply" {
			return fmt.Errorf("%w: refusing to apply", errNoReleaseKey)
		}
		return nil
	}
	src := manifestURLFor(flagURL, cfg)
	if src == "" {
		return errors.New("no manifest address: enroll with Gauss, or pass --manifest URL")
	}
	m, a, err := u.check(ctx, src)
	switch {
	case errors.Is(err, errNotNewer):
		fmt.Fprintf(w, "Up to date: the newest signed release is %s.\n", m.Version)
		return nil
	case err != nil:
		return fmt.Errorf("update refused: %w", err)
	}
	fmt.Fprintf(w, "Update available: %s (commit %s, signed, valid until %s, %d bytes).\n", m.Version, cleanCommit(m.Commit), m.Expires.UTC().Format("2006-01-02"), a.Size)
	if sub == "check" {
		fmt.Fprintln(w, "Not applied. `argo update apply` installs it; nothing updates by itself.")
		return nil
	}
	if u.goos == "darwin" && !macOK {
		fmt.Fprintln(w, macApplyWhy)
		return errors.New("apply needs " + macApplyFlag + " on macOS")
	}
	if err := u.apply(ctx, m, a); err != nil {
		return fmt.Errorf("update not applied: %w", err)
	}
	fmt.Fprintf(w, "Updated to %s. The previous Argo is kept next to it with the ending .prev.\n", m.Version)
	return nil
}

var reCommit = regexp.MustCompile(`^[0-9a-f]{7,64}$`)

func cleanCommit(c string) string {
	if reCommit.MatchString(c) {
		return c
	}
	return "unknown"
}

// updateTick checks for a release at most once a day and only records the
// answer (posture item "argo"). It never applies anything, and does nothing
// at all until a release key is pinned.
func updateTick(ctx context.Context, cfg Config, s Store, now time.Time) {
	u := newUpdater(s)
	src := manifestURLFor("", cfg)
	if len(u.pub) != ed25519.PublicKeySize || src == "" {
		return
	}
	if st := s.loadUpdateState(); now.Sub(st.AttemptAt) >= 0 && now.Sub(st.AttemptAt) < updateCheckEvery {
		return
	}
	c, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	_, _, _ = u.check(c, src)
}
