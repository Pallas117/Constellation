// Argo keeps Claude Code connected on hostile networks: it probes, classifies
// the failure, applies the least invasive fix, verifies, and remembers what
// worked per network. It runs as a user LaunchAgent and never as root.
package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

const version = "0.1.0"
const label = "uk.lightbound.argo"

//go:embed launchd/uk.lightbound.argo.plist
var plistTemplate string

// Config lives in ~/.config/argo/config.json; the Gauss token in a 0600 file next to it.
type Config struct {
	GaussURL  string            `json:"gauss_url,omitempty"`  // must be a tailnet address
	Device    string            `json:"device,omitempty"`     // display name in Gauss
	ExitNodes map[string]string `json:"exit_nodes,omitempty"` // tailscale hostname → country (MY/SG only)
}

func configDir() string { return filepath.Join(home(), ".config/argo") }

func loadConfig() Config {
	var c Config
	if b, err := os.ReadFile(filepath.Join(configDir(), "config.json")); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}

func main() {
	cmd := "status"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}
	cfg, store := loadConfig(), DefaultStore()
	slack := loadSlack(cfg.Device)
	loop := Loop{Prober: SystemProber{ExitNodes: cfg.ExitNodes}, Store: store, Fx: realEffects{slack: slack}}
	flush := func() {
		if slack != nil {
			slack.Flush() // deliver alerts queued while offline
		}
	}
	if cfg.GaussURL != "" {
		loop.Pushers = append(loop.Pushers, func(st State) { pushToGauss(cfg, st) })
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	var err error
	switch cmd {
	case "status":
		fmt.Println(statusLine(store.Load(), time.Now()))
	case "doctor":
		err = doctor(ctx, loop.Prober)
	case "fix":
		loop.Out = func(s string) { fmt.Println(s) }
		err = withLock(store, func() { flush(); loop.Tick(ctx) })
	case "tick": // LaunchAgent entry point
		if store.Disabled() {
			return
		}
		err = withLock(store, func() { flush(); loop.Tick(ctx) })
	case "preflight":
		os.Exit(preflight())
	case "run":
		err = runStripped(os.Args[2:])
	case "report":
		report(store.Incidents())
	case "off":
		err = os.WriteFile(store.path("disabled"), nil, 0o600)
		fmt.Println("argo paused (LaunchAgent ticks are skipped). `argo on` to resume.")
	case "on":
		err = os.Remove(store.path("disabled"))
		if errors.Is(err, os.ErrNotExist) {
			err = nil
		}
		fmt.Println("argo active.")
	case "slack":
		err = slackSetup(os.Args[2:], cfg.Device)
	case "enroll":
		err = enroll(os.Args[2:])
	case "install":
		err = install()
	case "uninstall":
		err = uninstall(store)
	case "version":
		fmt.Println("argo", version)
	default:
		fmt.Fprintln(os.Stderr, "usage: argo [status|doctor|fix|report|on|off|preflight|run -- cmd|slack [test|off]|enroll URL DEVICE|install|uninstall|version]")
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "argo:", Mask(err.Error()))
		os.Exit(1)
	}
}

func withLock(s Store, f func()) error {
	unlock, err := s.Lock()
	if err != nil {
		return err
	}
	defer unlock()
	f()
	return nil
}

// statusLine is cheap: it reads the last saved state and never probes, so it
// is safe to use as the Claude Code status line.
func statusLine(st State, now time.Time) string {
	if st.CheckedAt.IsZero() {
		return "argo: no data (run `argo fix`)"
	}
	icon := map[bool]string{true: "●", false: "▲"}[!st.Class.Blocking()]
	ts := "ts:off"
	if st.Tailscale.Running {
		ts = "ts:on"
		if st.Tailscale.ExitNode != "" {
			ts = "ts:" + st.Tailscale.ExitNode
		}
	}
	line := fmt.Sprintf("%s %s %s %s", icon, st.Class, orUnknown(st.Loc), ts)
	if age := now.Sub(st.CheckedAt); age > 10*time.Minute {
		line += fmt.Sprintf(" (stale %s)", age.Round(time.Minute))
	}
	return line
}

func doctor(ctx context.Context, p Prober) error {
	s := p.Probe(ctx)
	class, reason := Classify(s)
	b, _ := json.MarshalIndent(s, "", "  ")
	fmt.Println(Mask(string(b)))
	fmt.Printf("\nclass: %s — %s\n", class, reason)
	for _, a := range Plan(class, s, "") {
		fmt.Println("→", a.Say)
		if a.Command != "" {
			fmt.Println("   ", a.Command)
		}
	}
	return nil
}

// preflight is the fast, local-only check run before each `claude` launch.
func preflight() int {
	code := 0
	for _, v := range proxyVars {
		if u := os.Getenv(v); u != "" && !dialAlive(u) {
			fmt.Fprintf(os.Stderr, "argo: %s=%s is dead; use `argo run -- claude`\n", v, maskURL(u))
			code = 1
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if procs := findStaleProcs(run(ctx, "ps", "-E", "-ww", "-x", "-o", "pid=,command="), dialAlive); len(procs) > 0 {
		fmt.Fprintf(os.Stderr, "argo: %d claude process(es) stuck on dead proxy %s; run `claude daemon stop --any`\n", len(procs), procs[0].Proxy)
		code = 1
	}
	return code
}

// runStripped execs a command with dead proxy variables removed. Live proxies
// and CA settings (NODE_EXTRA_CA_CERTS etc.) are left untouched.
func runStripped(args []string) error {
	if len(args) > 0 && args[0] == "--" {
		args = args[1:]
	}
	if len(args) == 0 {
		return errors.New("usage: argo run -- <command> [args]")
	}
	path, err := exec.LookPath(args[0])
	if err != nil {
		return err
	}
	var env []string
	for _, kv := range os.Environ() {
		k, v, _ := strings.Cut(kv, "=")
		if isProxyVar(k) && !dialAlive(v) {
			fmt.Fprintf(os.Stderr, "argo: dropping dead %s\n", k)
			continue
		}
		env = append(env, kv)
	}
	return syscall.Exec(path, args, env)
}

func isProxyVar(k string) bool {
	for _, v := range proxyVars {
		if k == v {
			return true
		}
	}
	return false
}

func report(in []Incident) {
	opens, resolved := map[Class]int{}, 0
	var classes []string
	for _, i := range in {
		switch i.Event {
		case "open":
			if opens[i.Class] == 0 {
				classes = append(classes, string(i.Class))
			}
			opens[i.Class]++
		case "resolved":
			if i.Fix != "" {
				resolved++
			}
		}
	}
	total := 0
	sort.Strings(classes)
	fmt.Println("Incidents by class:")
	for _, c := range classes {
		fmt.Printf("  %-14s %d\n", c, opens[Class(c)])
		total += opens[Class(c)]
	}
	if total == 0 {
		fmt.Println("  (none)")
		return
	}
	fmt.Printf("Fix success rate: %d/%d (%.0f%%)\n", resolved, total, 100*float64(resolved)/float64(total))
	fmt.Println("Last 10 events:")
	for _, i := range in[max(0, len(in)-10):] {
		fmt.Printf("  %s  %-9s %-13s %s%s\n", i.Time.Local().Format("01-02 15:04"), i.Event, i.Class, i.Fix, i.Detail)
	}
}

// ---- Gauss reporting ----

// tailnetOnly refuses to send status anywhere but a Tailscale address, so a
// mistyped or hostile URL cannot exfiltrate device state.
func tailnetOnly(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	h := u.Hostname()
	if strings.HasSuffix(h, ".ts.net") {
		return u, nil
	}
	if ip := net.ParseIP(h); ip != nil {
		_, cgnat, _ := net.ParseCIDR("100.64.0.0/10")
		_, ula, _ := net.ParseCIDR("fd7a:115c:a1e0::/48")
		if cgnat.Contains(ip) || ula.Contains(ip) {
			return u, nil
		}
	}
	return nil, fmt.Errorf("gauss_url %q is not a tailnet address (100.64.0.0/10 or *.ts.net)", h)
}

// pushToGauss sends a minimal record: no public IP, no MAC, no SSID, no env.
func pushToGauss(cfg Config, st State) {
	u, err := tailnetOnly(cfg.GaussURL)
	if err != nil {
		return
	}
	tok, err := os.ReadFile(filepath.Join(configDir(), "token"))
	if err != nil {
		return
	}
	body, _ := json.Marshal(map[string]any{
		"device": cfg.Device, "class": st.Class, "reason": Mask(st.Reason), "loc": st.Loc,
		"network": st.Fingerprint, "tailscale": st.Tailscale.Running, "exitNode": st.Tailscale.ExitNode,
		"breakerOpen": time.Now().Before(st.BreakerUntil), "argoVersion": version, "checkedAt": st.CheckedAt,
	})
	u.Path = "/api/mesh/report"
	req, _ := http.NewRequest(http.MethodPost, u.String(), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(tok)))
	c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}}
	if resp, err := c.Do(req); err == nil {
		resp.Body.Close()
	}
}

// enroll stores the Gauss URL and reads the device token from stdin so it
// never appears in shell history or `ps`.
func enroll(args []string) error {
	if len(args) != 2 {
		return errors.New("usage: argo enroll <gauss-tailnet-url> <device-name>  (token on stdin)")
	}
	if _, err := tailnetOnly(args[0]); err != nil {
		return err
	}
	fmt.Fprint(os.Stderr, "Paste the device token from Gauss → Mesh, then Enter: ")
	var tok string
	if _, err := fmt.Fscanln(os.Stdin, &tok); err != nil || tok == "" {
		return errors.New("no token read")
	}
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(configDir(), "token"), []byte(tok+"\n"), 0o600); err != nil {
		return err
	}
	cfg := loadConfig()
	cfg.GaussURL, cfg.Device = args[0], args[1]
	b, _ := json.MarshalIndent(cfg, "", "  ")
	fmt.Println("enrolled; status will be reported to", args[0])
	return os.WriteFile(filepath.Join(configDir(), "config.json"), b, 0o600)
}

// ---- install / uninstall ----

func plistPath() string { return filepath.Join(home(), "Library/LaunchAgents", label+".plist") }

// install writes the LaunchAgent plist but does not load it: launchctl is a
// system change the user runs themselves.
func install() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	logDir := DefaultStore().Dir
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return err
	}
	p := strings.NewReplacer("{{ARGO}}", exe, "{{LOG}}", filepath.Join(logDir, "launchd.log")).Replace(plistTemplate)
	if err := os.WriteFile(plistPath(), []byte(p), 0o644); err != nil {
		return err
	}
	fmt.Printf("wrote %s\nLoad it with:\n  launchctl bootstrap gui/%d %s\n", plistPath(), os.Getuid(), plistPath())
	return nil
}

func uninstall(s Store) error {
	if exec.Command("launchctl", "print", fmt.Sprintf("gui/%d/%s", os.Getuid(), label)).Run() == nil {
		return fmt.Errorf("the LaunchAgent is still loaded; first run:\n  launchctl bootout gui/%d/%s", os.Getuid(), label)
	}
	for _, p := range []string{plistPath(), s.Dir, configDir()} {
		if err := os.RemoveAll(p); err != nil {
			return err
		}
		fmt.Println("removed", p)
	}
	fmt.Println("argo uninstalled. Delete the binary yourself if you no longer need it.")
	return nil
}
