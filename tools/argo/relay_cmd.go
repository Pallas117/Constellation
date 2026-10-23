package main

// Commands for delay-tolerant delivery (relay.go) and link stability
// (linkstats.go), kept apart from main.go's switch.

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

func inboxDir(cfg Config) string {
	if cfg.InboxDir != "" {
		return cfg.InboxDir
	}
	return filepath.Join(home(), "Downloads", "Argo")
}

// relayFor builds this device's bundle agent; it creates the node keys the
// first time. Received files only raise a desktop notification; problems
// (refused bundles, key changes, expiry) also go to the phone.
func relayFor(cfg Config, store Store, phone *Phone) (*Relay, bool, error) {
	if !deviceRE.MatchString(cfg.Device) {
		return nil, false, errors.New(`this device has no name yet: run "argo enroll <gauss-url> <name>" (or set "device" in ~/.config/argo/config.json)`)
	}
	keys, created, err := loadOrCreateKeys(keyPath(), cfg.Device)
	if err != nil {
		return nil, false, err
	}
	r := &Relay{Dir: filepath.Join(store.Dir, "dtn"), Keys: keys, InboxDir: inboxDir(cfg),
		Notify: func(title, msg string) {
			if title == "Argo: file received" {
				desktopNotify(title, msg)
				return
			}
			realEffects{phone: phone}.Notify(title, msg)
		}}
	if cfg.GaussURL != "" {
		if hub, err := newHTTPHub(cfg); err == nil {
			r.Hub = hub
		}
	}
	return r, created, nil
}

// withRelayLock serialises relay runs (the LaunchAgent tick and commands)
// on a lock separate from the network loop's, waiting up to wait for it.
func withRelayLock(store Store, wait time.Duration, f func()) error {
	ls := Store{Dir: filepath.Join(store.Dir, "dtn")}
	deadline := time.Now().Add(wait)
	for {
		unlock, err := ls.Lock()
		if err == nil {
			defer unlock()
			f()
			return nil
		}
		if !time.Now().Before(deadline) {
			return errors.New("another argo relay run is in progress; try again in a minute")
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// relayMain runs one relay command under the relay lock.
func relayMain(cmd string, args []string, cfg Config, store Store, phone *Phone, out io.Writer) error {
	if cmd == "link" {
		return relayCmd(cmd, args, cfg, store, phone, out)
	}
	var err error
	if lerr := withRelayLock(store, 2*time.Minute, func() { err = relayCmd(cmd, args, cfg, store, phone, out) }); lerr != nil {
		return lerr
	}
	return err
}

// relayTick runs on every LaunchAgent tick once this device has node keys
// (made by `argo enroll` or any relay command), so an older Gauss without
// the bundle routes never sees this traffic from devices that don't use it.
func relayTick(ctx context.Context, cfg Config, store Store, phone *Phone) {
	if cfg.GaussURL == "" || store.Load().Class == Offline {
		return
	}
	if _, err := os.Stat(keyPath()); err != nil {
		return
	}
	r, _, err := relayFor(cfg, store, phone)
	if err != nil || r.Hub == nil {
		return
	}
	c, cancel := context.WithTimeout(ctx, 40*time.Second)
	defer cancel()
	_ = withRelayLock(store, 0, func() { r.Sync(c) }) // busy: a command is syncing right now
}

func relayCmd(cmd string, args []string, cfg Config, store Store, phone *Phone, out io.Writer) error {
	if cmd == "link" {
		fmt.Fprintln(out, linkReport(store.Incidents(), store.Load(), time.Now()).Text())
		return nil
	}
	r, created, err := relayFor(cfg, store, phone)
	if err != nil {
		return err
	}
	if created {
		fmt.Fprintf(out, "Created this device's keys (%s). Fingerprint: %s\n", keyPath(), r.Keys.Public().Fingerprint())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	switch cmd {
	case "send":
		fs := flag.NewFlagSet("send", flag.ContinueOnError)
		ttl := fs.Duration("ttl", defaultTTL, "how long to keep trying (max 720h)")
		if err := fs.Parse(reorderFlags(args)); err != nil {
			return err
		}
		if fs.NArg() != 2 {
			return errors.New("usage: argo send [-ttl 72h] <device> <file>")
		}
		_, n, err := r.Send(ctx, fs.Arg(0), fs.Arg(1), *ttl)
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "queued %s for %s (%d bundle%s, signed and encrypted; kept until %s confirms or %s passes)\n",
			safeName(filepath.Base(fs.Arg(1))), fs.Arg(0), n, plural(n), fs.Arg(0), ttl.String())
		if r.Hub != nil {
			fmt.Fprintln(out, "sync:", r.Sync(ctx))
		}
	case "sync":
		if r.Hub == nil {
			return errors.New("no Gauss hub configured (argo enroll); use `argo mule` to carry bundles instead")
		}
		fmt.Fprintln(out, "sync:", r.Sync(ctx))
	case "outbox":
		printOutbox(out, r.Outbox(), r.HubHealth(), time.Now())
	case "inbox":
		in := r.Inbox()
		if len(in) == 0 {
			fmt.Fprintln(out, "inbox: nothing received yet; files land in", r.InboxDir)
		}
		for _, x := range in {
			fmt.Fprintf(out, "%s  %-16s %s (%s)\n", x.At.Local().Format("2006-01-02 15:04"), x.From, x.Path, sizeText(x.Size))
		}
	case "keys":
		return keysCmd(ctx, r, args, out)
	case "mule":
		if len(args) != 2 || (args[0] != "export" && args[0] != "import") {
			return errors.New("usage: argo mule export|import <folder>")
		}
		if args[0] == "export" {
			n, err := r.MuleExport(args[1])
			if err != nil {
				return err
			}
			fmt.Fprintf(out, "wrote %d bundle%s and this device's public key to %s; carry it to the other device and run `argo mule import`\n", n, plural(n), args[1])
			return nil
		}
		rep, err := r.MuleImport(ctx, args[1])
		if err != nil {
			return err
		}
		for _, k := range rep.NewKeys {
			fmt.Fprintln(out, "trusted new key (check this code with its owner):", k)
		}
		fmt.Fprintf(out, "imported: received %d, confirmed %d, refused %d\n", rep.Received, rep.Delivered, rep.Rejected)
		for _, e := range rep.Errors {
			fmt.Fprintln(out, "  ", e)
		}
	}
	return nil
}

// reorderFlags lets flags follow the positional arguments (argo send dev file -ttl 2h).
func reorderFlags(args []string) []string {
	var flags, rest []string
	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "-") {
			flags = append(flags, args[i])
			if !strings.Contains(args[i], "=") && i+1 < len(args) {
				flags = append(flags, args[i+1])
				i++
			}
			continue
		}
		rest = append(rest, args[i])
	}
	return append(flags, rest...)
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func sizeText(n uint64) string {
	switch {
	case n >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
	case n >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(n)/(1<<10))
	}
	return fmt.Sprintf("%d B", n)
}

// printOutbox shows one line per file, however many chunks it has.
func printOutbox(out io.Writer, items []outItem, hub pathHealth, now time.Time) {
	type file struct {
		name, dest string
		created    time.Time
		expires    time.Time
		chunks     int
		count      map[string]int
	}
	files := map[string]*file{}
	var order []string
	for _, it := range items {
		f, ok := files[it.Transfer]
		if !ok {
			f = &file{name: it.Name, dest: it.Dest, created: it.Created, expires: it.Expires, chunks: it.Chunks, count: map[string]int{}}
			files[it.Transfer] = f
			order = append(order, it.Transfer)
		}
		f.count[it.State]++
	}
	link := "hub: not checked yet"
	if len(hub.Last) > 0 {
		link = "hub: up since " + hub.Since.Local().Format("Jan 2 15:04")
		if !hub.Up() {
			link = "hub: down since " + hub.Since.Local().Format("Jan 2 15:04") + " (retrying with backoff)"
		}
	}
	fmt.Fprintln(out, link)
	if len(order) == 0 {
		fmt.Fprintln(out, "outbox: empty")
		return
	}
	sort.SliceStable(order, func(i, j int) bool { return files[order[i]].created.After(files[order[j]].created) })
	for _, id := range order {
		f := files[id]
		var parts []string
		for _, s := range []string{stateDelivered, statePickedUp, stateAtHub, stateQueued, stateExpired, stateRefused} {
			if n := f.count[s]; n > 0 {
				parts = append(parts, fmt.Sprintf("%d %s", n, s))
			}
		}
		left := ""
		if f.count[stateDelivered] < f.chunks && now.Before(f.expires) {
			left = fmt.Sprintf(", gives up in %s", humanSecs(int64(f.expires.Sub(now)/time.Second)))
		}
		fmt.Fprintf(out, "%s  %s → %s: %d/%d confirmed (%s%s)\n", f.created.Local().Format("2006-01-02 15:04"), f.name, f.dest, f.count[stateDelivered], f.chunks, strings.Join(parts, ", "), left)
	}
}

func keysCmd(ctx context.Context, r *Relay, args []string, out io.Writer) error {
	sub := ""
	if len(args) > 0 {
		sub = args[0]
	}
	switch sub {
	case "":
		k := r.Keys.Public()
		fmt.Fprintf(out, "%s  %s\n  signing: Ed25519 · encryption: HPKE ML-KEM-768+X25519, AES-256-GCM\n  Compare this code with the other person before trusting files from them.\n", k.Node, k.Fingerprint())
	case "list":
		pins := r.Pins()
		names := make([]string, 0, len(pins))
		for n := range pins {
			names = append(names, n)
		}
		sort.Strings(names)
		if len(names) == 0 {
			fmt.Fprintln(out, "no other devices trusted yet")
		}
		for _, n := range names {
			fmt.Fprintf(out, "%-20s %s\n", n, pins[n].Fingerprint())
		}
	case "publish":
		if r.Hub == nil {
			return errors.New("no Gauss hub configured (argo enroll)")
		}
		if err := r.Hub.Publish(ctx, r.Keys.Public()); err != nil {
			return err
		}
		fmt.Fprintln(out, "published", r.Keys.Public().Fingerprint())
	case "trust":
		if len(args) != 2 {
			return errors.New("usage: argo keys trust <device>")
		}
		k, err := r.TrustNew(ctx, args[1])
		if err != nil {
			return err
		}
		fmt.Fprintf(out, "now trusting %s %s\n", k.Node, k.Fingerprint())
	default:
		return errors.New("usage: argo keys [list|publish|trust <device>]")
	}
	return nil
}
