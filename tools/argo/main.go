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
	"os/signal"
	"path/filepath"
	"runtime"
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
	PhoneTo   string            `json:"phone_to,omitempty"`   // your own iMessage handle for phone alerts
	// "sms" sends SMS first: iMessages to your own number arrive silently, with no banner.
	PhoneService string   `json:"phone_service,omitempty"`
	Watch        []Peer   `json:"watch,omitempty"`     // LaunchAgents Argo keeps alive; default: awake guard + mesh-heal
	Devices      []string `json:"devices,omitempty"`   // tailnet hostnames to watch; default: this user's phones
	InboxDir     string   `json:"inbox_dir,omitempty"` // where received files land; default ~/Downloads/Argo
}

func (c Config) peers() []Peer {
	if c.Watch == nil {
		return defaultPeers()
	}
	return c.Watch
}

func saveConfig(c Config) error {
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(filepath.Join(configDir(), "config.json"), b, 0o600)
}

// loopInterval parses ARGO_INTERVAL ("60s", "2m"); default 60s, never under 15s.
func loopInterval(v string) time.Duration {
	d, err := time.ParseDuration(strings.TrimSpace(v))
	if err != nil || d <= 0 {
		return time.Minute
	}
	if d < 15*time.Second {
		return 15 * time.Second
	}
	return d
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
	phone := newPhoneFor(cfg)
	loop := Loop{Prober: SystemProber{ExitNodes: cfg.ExitNodes, SignalCache: store.path("signal.json")}, Store: store, Fx: realEffects{phone: phone}}
	flush := func() {
		if phone != nil {
			phone.Flush() // deliver alerts queued while offline
		}
	}
	if cfg.GaussURL != "" {
		loop.Pushers = append(loop.Pushers, func(st State) { pushToGauss(cfg, st) })
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	// One scheduled check: the peer watchdog every time (cheap file stats), the
	// network probe only when skipTick says it is due.
	tick := func(ctx context.Context) error {
		if store.Disabled() {
			return nil
		}
		_ = withLock(store, func() { watchPeers(cfg.peers(), store, realWatchFx(phone, store), time.Now()) })
		relayTick(ctx, cfg, store, phone) // store-and-forward (relay.go); takes its own lock
		if gw, mac := localGateway(ctx); skipTick(store.Load(), gw, mac, time.Now()) {
			return nil
		}
		return withLock(store, func() {
			flush()
			loop.Tick(ctx)
			watchDevices(ctx, cfg.Devices, store, phone, time.Now())
			maybeSendWeekly(store, phone, time.Now())
		})
	}

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
		err = tick(ctx)
	case "loop": // container entry point: a tick every ARGO_INTERVAL (default 60s) until stopped
		every := loopInterval(os.Getenv("ARGO_INTERVAL"))
		stop := make(chan os.Signal, 1)
		signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
		loop.Out = func(s string) { fmt.Println(time.Now().UTC().Format(time.RFC3339), s) }
		fmt.Printf("argo %s: checking every %s\n", version, every)
		for {
			c, done := context.WithTimeout(context.Background(), 90*time.Second)
			if e := tick(c); e != nil {
				fmt.Fprintln(os.Stderr, "argo:", e)
			}
			done()
			select {
			case <-stop:
				return
			case <-time.After(every):
			}
		}
	case "summary": // what Argo caught, fixed and learned in the last 7 days
		now := time.Now()
		st := store.Load()
		text := weeklySummary(store.Incidents(), st.Networks, now.Add(-summaryEvery), now)
		fmt.Println(text)
		if len(os.Args) > 2 && os.Args[2] == "--send" {
			if phone == nil {
				err = errors.New("phone alerts are not set up; run `argo phone <number>`")
			} else {
				phone.Send("Argo weekly", text, now)
			}
		}
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
	case "watch": // run the peer watchdog once and say what it did
		err = withLock(store, func() {
			for _, l := range watchPeers(cfg.peers(), store, realWatchFx(phone, store), time.Now()) {
				fmt.Println(l)
			}
			fmt.Println("watch: done")
		})
	case "devices": // which watched tailnet devices (default: your phones) are offline
		lines := watchDevices(ctx, cfg.Devices, store, nil, time.Now())
		for _, l := range lines {
			fmt.Println(l)
		}
		if len(lines) == 0 {
			fmt.Println("devices: all watched devices are on the tailnet (or this Mac is off it)")
		}
	case "notify": // for mesh-heal, the awake guard and Claude Code hooks
		err = notifyCmd(os.Args[2:], phone, store, time.Now())
	case "phone":
		err = phoneSetup(os.Args[2:], cfg)
	case "enroll":
		err = enroll(os.Args[2:])
	case "install":
		err = install()
	case "uninstall":
		err = uninstall(store)
	case "send", "outbox", "inbox", "sync", "keys", "mule", "link":
		err = relayMain(cmd, os.Args[2:], cfg, store, phone, os.Stdout)
	case "version":
		fmt.Println("argo", version)
	default:
		fmt.Fprintln(os.Stderr, "usage: argo [status|doctor|fix|report|on|off|preflight|run -- cmd|phone <handle>|test|off|notify TITLE MSG|watch|summary [--send]|enroll URL DEVICE|install|uninstall|version]\n       argo [send [-ttl D] DEVICE FILE|outbox|inbox|sync|keys [list|publish|trust DEVICE]|mule export|import DIR|link]")
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "argo:", Mask(err.Error()))
		os.Exit(1)
	}
}

// The LaunchAgent fires every minute. A full probe uses network data, so it
// only runs when it can matter: on the iPhone hotspot (the phone can switch
// SIM/data line without the Mac noticing), while something is broken, after
// the gateway changes, or when the last check is ~5 minutes old.
const fullCheckEvery = 290 * time.Second

func isIPhoneHotspot(gw string) bool { return gw == "172.20.10.1" } // Personal Hotspot always uses 172.20.10.0/28

func skipTick(st State, gw, mac string, now time.Time) bool {
	switch {
	case st.CheckedAt.IsZero(), st.Class.Blocking(), isIPhoneHotspot(gw):
		return false
	case gw != st.Gateway || mac != st.GatewayMAC:
		return false
	}
	return now.Sub(st.CheckedAt) < fullCheckEvery
}

// localGateway is the cheap, local-only part of a probe (no network traffic).

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
	fmt.Printf("network: %s\n", ScoreNet(s).Line())
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
	opens, fixed, selfResolved := map[Class]int{}, 0, 0
	var classes []string
	for _, i := range in {
		switch i.Event {
		case "open":
			if opens[i.Class] == 0 {
				classes = append(classes, string(i.Class))
			}
			opens[i.Class]++
		case "resolved":
			// "wait" means it came back on its own (e.g. network returned): not a fix.
			if i.Fix == "" || i.Fix == "wait" {
				selfResolved++
			} else {
				fixed++
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
	if needed := total - selfResolved; needed > 0 {
		fmt.Printf("Fixed: %d/%d incidents that needed a fix (%.0f%%)\n", fixed, needed, 100*float64(fixed)/float64(needed))
	}
	fmt.Printf("Resolved on their own (e.g. network came back): %d\n", selfResolved)
	fmt.Println("Last 10 events:")
	for _, i := range in[max(0, len(in)-10):] {
		fmt.Printf("  %s  %-9s %-13s %s%s\n", i.Time.Local().Format("01-02 15:04"), i.Event, i.Class, i.Fix, i.Detail)
	}
}

// ---- Gauss reporting ----

// tailnetOnly refuses to send status anywhere but this Mac (a local Gauss)
// or a Tailscale address, so a mistyped or hostile URL cannot exfiltrate
// device state.
func tailnetOnly(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	h := u.Hostname()
	if strings.HasSuffix(h, ".ts.net") || h == "localhost" {
		return u, nil
	}
	if ip := net.ParseIP(h); ip != nil {
		if ip.IsLoopback() {
			return u, nil
		}
		_, cgnat, _ := net.ParseCIDR("100.64.0.0/10")
		_, ula, _ := net.ParseCIDR("fd7a:115c:a1e0::/48")
		if cgnat.Contains(ip) || ula.Contains(ip) {
			return u, nil
		}
	}
	return nil, fmt.Errorf("gauss_url %q is not this Mac or a tailnet address (100.64.0.0/10 or *.ts.net)", h)
}

func hostCapacityNow() HostCapacity {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	return hostCapacity(ctx)
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
		"host":     hostCapacityNow(), // sizes and pressure only, so Gauss can tell which devices can host agents
		"platform": platformName(runtime.GOOS),
		"net":      netReport(st.Net),                                      // scores and their reasons; no SSID, BSSID or IP
		"link":     linkReport(DefaultStore().Incidents(), st, time.Now()), // availability from the local incident log
	})
	u.Path = "/api/mesh/report"
	req, _ := http.NewRequest(http.MethodPost, u.String(), bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(tok)))
	c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil}}
	resp, err := c.Do(req)
	if err != nil {
		return // offline or Gauss down: the next tick reports again
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 { // e.g. a class Gauss doesn't know yet: say so instead of failing silently
		fmt.Fprintf(os.Stderr, "%s argo: Gauss rejected the report for class %s: HTTP %d\n", time.Now().UTC().Format(time.RFC3339), st.Class, resp.StatusCode)
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
	fmt.Println("enrolled; status will be reported to", args[0])
	if err := saveConfig(cfg); err != nil {
		return err
	}
	// Node keys for store-and-forward delivery; the public half is published
	// now (or on the next tick) so other devices can send to this one.
	return withRelayLock(DefaultStore(), time.Minute, func() {
		if r, _, err := relayFor(cfg, DefaultStore(), nil); err == nil {
			fmt.Println("this device's key fingerprint:", r.Keys.Public().Fingerprint())
			if r.Hub != nil {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				r.Sync(ctx)
			}
		}
	})
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
