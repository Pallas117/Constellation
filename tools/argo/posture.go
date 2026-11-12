package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Device security posture (GAU-238): what each enrolled device is checked
// against, in docs/DEVICE_SECURITY_BASELINE.md (DRAFT until Josh approves it).
//
// Every check is read-only: it runs a system tool that prints a setting, or
// reads a file. Argo never changes a setting, never asks for admin rights and
// never runs a Tailscale command that changes anything. A check that cannot
// be read is "unknown", never "ok". Output carries statuses and fixed
// sentences only: no serial numbers, MAC or IP addresses, host or user names.

const (
	postureOK      = "ok"
	postureWarn    = "warn"
	postureFail    = "fail"
	postureUnknown = "unknown"
)

// postureIDs are the baseline items, in display order. The backend allowlist
// (POSTURE_ITEMS in backend/mesh/store.ts) must match; a contract test reads
// this line.
var postureIDs = []string{"disk", "firewall", "updates", "integrity", "tailkey", "argo", "sharing"}

var postureNames = map[string]string{
	"disk":      "Disk encryption",
	"firewall":  "Firewall",
	"updates":   "Automatic security updates",
	"integrity": "System integrity",
	"tailkey":   "Tailnet key expiry",
	"argo":      "Argo up to date",
	"sharing":   "Sharing services",
}

// PostureItem is one baseline check. Detail and Fix are fixed sentences.
type PostureItem struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
	Detail string `json:"detail"`
	Fix    string `json:"fix,omitempty"`
}

// Posture is the result of one run.
type Posture struct {
	At       time.Time     `json:"at"`
	Platform string        `json:"platform"`
	Items    []PostureItem `json:"items"`
}

func item(id, status, detail, fix string) PostureItem {
	if status == postureOK {
		fix = ""
	}
	return PostureItem{ID: id, Name: postureNames[id], Status: status, Detail: detail, Fix: fix}
}

// postureEnv is everything a check may touch, so tests run on fixtures.
type postureEnv struct {
	run       func(ctx context.Context, name string, args ...string) (string, error) // output of a read-only tool
	readFile  func(path string) ([]byte, error)
	readDir   func(path string) ([]string, error)
	lanIP     func(ctx context.Context) string // this host's address on the default route's interface; "" when offline
	dial      func(addr string) bool
	tailscale string // path of the Tailscale CLI
	now       time.Time
	keyPinned bool        // a release key is pinned in this build (update.go)
	update    updateState // the last verified update check
}

const postureCmdTimeout = 5 * time.Second

// runReadOnly runs one system tool with a deadline and a fixed environment.
// It returns stdout, or stderr when stdout is empty; callers match fixed
// phrases and treat anything else as unknown.
func runReadOnly(ctx context.Context, name string, args ...string) (string, error) {
	c, cancel := context.WithTimeout(ctx, postureCmdTimeout)
	defer cancel()
	cmd := exec.CommandContext(c, name, args...)
	cmd.Env = []string{"LC_ALL=C", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "HOME=" + home()}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	if stdout.Len() == 0 {
		return stderr.String(), err
	}
	return stdout.String(), err
}

func realPostureEnv(s Store, now time.Time) postureEnv {
	return postureEnv{
		run:      runReadOnly,
		readFile: os.ReadFile,
		readDir: func(p string) ([]string, error) {
			es, err := os.ReadDir(p)
			var names []string
			for _, e := range es {
				names = append(names, e.Name())
			}
			return names, err
		},
		lanIP:     hostLanIP,
		dial:      dialQuick,
		tailscale: tailscaleCLI(),
		now:       now,
		keyPinned: len(pinnedReleaseKey()) > 0,
		update:    s.loadUpdateState(),
	}
}

// runPosture runs every baseline check for the given OS ("darwin", "linux").
func runPosture(ctx context.Context, goos string, e postureEnv) Posture {
	p := Posture{At: e.now.UTC().Truncate(time.Second), Platform: platformName(goos)}
	switch goos {
	case "darwin":
		p.Items = append(p.Items, macDisk(ctx, e), macFirewall(ctx, e), macUpdates(ctx, e), macIntegrity(ctx, e))
	case "linux":
		p.Items = append(p.Items, linuxDisk(e), linuxFirewall(ctx, e), linuxUpdates(ctx, e), linuxIntegrity(e))
	default:
		for _, id := range postureIDs[:4] {
			p.Items = append(p.Items, item(id, postureUnknown, "Argo has no check for this system", ""))
		}
	}
	p.Items = append(p.Items, tailKeyItem(ctx, e), argoItem(e), sharingItem(ctx, e))
	return p
}

// worstStatus combines parts of one item: fail beats unknown beats warn beats ok.
// Unknown outranks warn so a part that could not be read is never hidden.
func worstStatus(statuses ...string) string {
	rank := map[string]int{postureOK: 0, postureWarn: 1, postureUnknown: 2, postureFail: 3}
	out := postureOK
	for _, s := range statuses {
		if rank[s] > rank[out] {
			out = s
		}
	}
	return out
}

// Tailnet key expiry, from `tailscale status --json` (read-only). Only
// Self.KeyExpiry and BackendState are read; names and addresses are ignored.
const tailKeyWarnDays = 14

func tailKeyItem(ctx context.Context, e postureEnv) PostureItem {
	const id = "tailkey"
	fix := "Sign in to Tailscale again on this device (Tailscale menu > Log in, or `tailscale login`) to renew its key"
	out, err := e.run(ctx, e.tailscale, "status", "--json")
	var st struct {
		BackendState string
		Self         *struct {
			KeyExpiry *time.Time
		}
	}
	if err != nil && out == "" || json.Unmarshal([]byte(out), &st) != nil || st.BackendState == "" {
		return item(id, postureUnknown, "Tailscale did not answer", "Check that Tailscale is installed and running")
	}
	switch st.BackendState {
	case "NeedsLogin":
		return item(id, postureFail, "This device is signed out of the tailnet", fix)
	case "Running", "Starting":
	default:
		return item(id, postureUnknown, "Tailscale is not connected", "Turn Tailscale on, then run `argo posture` again")
	}
	if st.Self == nil {
		return item(id, postureUnknown, "Tailscale gave no details for this device", "")
	}
	if st.Self.KeyExpiry == nil {
		return item(id, postureOK, "This device's key does not expire (expiry is turned off for it in the Tailscale admin console)", "")
	}
	left := st.Self.KeyExpiry.Sub(e.now)
	days := int(left.Hours() / 24)
	switch {
	case left <= 0:
		return item(id, postureFail, "This device's tailnet key has expired", fix)
	case days < tailKeyWarnDays:
		return item(id, postureWarn, fmt.Sprintf("This device's tailnet key expires in %d day%s", days, plural(days)), fix)
	}
	return item(id, postureOK, fmt.Sprintf("Key valid for %d more days", days), "")
}

// updateStateMaxAge: an update check older than this no longer proves Argo is current.
const updateStateMaxAge = 3 * 24 * time.Hour

func argoItem(e postureEnv) PostureItem {
	const id = "argo"
	u := e.update
	switch {
	case !e.keyPinned:
		return item(id, postureUnknown, "No signed release list exists yet, so Argo cannot tell whether it is current", "Nothing to do until releases are signed (docs/ARGO_UPDATE.md)")
	case u.CheckedAt.IsZero() || e.now.Sub(u.CheckedAt) > updateStateMaxAge || u.Running != version:
		return item(id, postureUnknown, "No recent verified update check", "Run `argo update check` while on the tailnet")
	case u.Available:
		return item(id, postureWarn, "A newer signed Argo release is available", "Run `argo update check` to see it, then update Argo")
	}
	return item(id, postureOK, "This is the newest signed release", "")
}

// Sharing services reachable from the local network: the same test and the
// same port list as the Wi-Fi check (wifi.go). The tailnet is not the local
// network, so a service bound only to the tailnet address does not count.
func sharingItem(ctx context.Context, e postureEnv) PostureItem {
	const id = "sharing"
	ip := e.lanIP(ctx)
	if ip == "" || strings.HasPrefix(ip, "127.") {
		return item(id, postureUnknown, "Not on a network, so nothing could be tested", "Run `argo posture` again once connected")
	}
	open := exposedServices(ip, e.dial)
	if len(open) == 0 {
		return item(id, postureOK, "No sharing service answers on the local network", "")
	}
	return item(id, postureWarn, "Reachable by others on this network: "+strings.Join(open, ", "), sharingAdvice)
}

// ----- output -----

func postureText(w io.Writer, p Posture) {
	fmt.Fprintf(w, "Argo posture (%s), read-only. Baseline: docs/DEVICE_SECURITY_BASELINE.md (DRAFT)\n", p.Platform)
	count := map[string]int{}
	for _, it := range p.Items {
		count[it.Status]++
		fmt.Fprintf(w, "%-8s %-27s %s\n", it.Status, it.Name, it.Detail)
		if it.Fix != "" {
			fmt.Fprintf(w, "%-8s fix: %s\n", "", it.Fix)
		}
	}
	fmt.Fprintf(w, "%d ok, %d warn, %d fail, %d unknown\n", count[postureOK], count[postureWarn], count[postureFail], count[postureUnknown])
}

// postureCmd is `argo posture [--json]`. It also refreshes the copy the mesh
// report carries.
func postureCmd(ctx context.Context, args []string, s Store, w io.Writer) error {
	asJSON := false
	for _, a := range args {
		if a != "--json" {
			return fmt.Errorf("usage: argo posture [--json]")
		}
		asJSON = true
	}
	p := runPosture(ctx, runtime.GOOS, realPostureEnv(s, time.Now()))
	c := s.loadPosture()
	c.Posture = p
	_ = s.savePosture(c)
	if asJSON {
		b, _ := json.MarshalIndent(p, "", "  ")
		_, err := fmt.Fprintln(w, string(b))
		return err
	}
	postureText(w, p)
	return nil
}

// ----- cache and mesh report -----

const (
	postureEvery     = time.Hour // how often the tick re-runs the checks
	postureSendEvery = time.Hour // how often an unchanged result is sent to Gauss again
	postureMaxAge    = 3 * time.Hour
)

// postureCache is ~/.local/state/argo/posture.json (0600).
type postureCache struct {
	Posture
	SentAt   time.Time `json:"sent_at,omitempty"`
	SentHash string    `json:"sent_hash,omitempty"`
}

func (s Store) loadPosture() postureCache {
	var c postureCache
	if b, err := os.ReadFile(s.path("posture.json")); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}

func (s Store) savePosture(c postureCache) error { return writeJSON0600(s, "posture.json", c) }

// writeJSON0600 writes a state file whole or not at all.
func writeJSON0600(s Store, name string, v any) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := s.path(name + ".tmp")
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path(name))
}

// postureCompact is what Gauss gets: item → status and when it was checked.
func postureCompact(p Posture) (map[string]any, string) {
	items := map[string]string{}
	var key strings.Builder
	for _, it := range p.Items {
		items[it.ID] = it.Status
		key.WriteString(it.ID + "=" + it.Status + ";")
	}
	return map[string]any{"at": p.At.UTC().Format(time.RFC3339), "items": items}, key.String()
}

// addPosture attaches the posture block when it changed or the last send is
// an hour old; Gauss keeps the last block between reports. It returns a
// function to call once Gauss has accepted the report.
func addPosture(report map[string]any, s Store, now time.Time) (sent func()) {
	c := s.loadPosture()
	if c.At.IsZero() || len(c.Items) == 0 || now.Sub(c.At) > postureMaxAge {
		return func() {}
	}
	block, hash := postureCompact(c.Posture)
	if hash == c.SentHash && now.Sub(c.SentAt) >= 0 && now.Sub(c.SentAt) < postureSendEvery {
		return func() {}
	}
	report["posture"] = block
	return func() {
		cur := s.loadPosture() // the tick may have refreshed it meanwhile
		cur.SentAt, cur.SentHash = now, hash
		_ = s.savePosture(cur)
	}
}

// securityTick runs from the minute tick: the posture checks about hourly and
// the update check at most daily (only once a release key is pinned). Neither
// changes anything on the device.
func securityTick(ctx context.Context, cfg Config, s Store, now time.Time) {
	updateTick(ctx, cfg, s, now)
	c := s.loadPosture()
	if !c.At.IsZero() && now.Sub(c.At) >= 0 && now.Sub(c.At) < postureEvery {
		return
	}
	c.Posture = runPosture(ctx, runtime.GOOS, realPostureEnv(s, now))
	_ = s.savePosture(c)
}
