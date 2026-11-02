package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Egress log (2026-11-03, Josh: "make the processes through argo as private and
// empowering for users as possible"). Argo records on this Mac everything it
// sends off it, so `argo egress` can say what left and where it went:
//   - third-party sends (phone texts through macOS Messages) get one line each
//     in egress.jsonl: when, route, masked recipient, size and the masked text;
//   - own-network sends (the Gauss report every minute, relay bundles to the
//     hub, both refused unless the URL is this Mac or the tailnet) are daily
//     counters in egress-own.json, so the log stays small.
// `argo egress off` holds third-party sends: texts wait in the local queue
// (newest 20) until `argo egress on`. Nothing here is uploaded anywhere.

const (
	egressLogMax   = 512 << 10 // egress.jsonl rolls over to egress.jsonl.1 at this size
	egressTextMax  = 200       // characters of each text kept in the log
	egressOwnDays  = 14        // days of own-network counters kept
	egressShowDays = 7
)

type EgressEntry struct {
	At    time.Time `json:"at"`
	Via   string    `json:"via"`   // "messages"
	Route string    `json:"route"` // "sms-first" or "imessage-first"
	To    string    `json:"to"`    // masked recipient
	Bytes int       `json:"bytes"`
	Text  string    `json:"text"` // as sent (already masked), cut to egressTextMax
}

type egressCount struct {
	N     int   `json:"n"`
	Bytes int64 `json:"bytes"`
}

// routeNote says who carries a text on each route, for people deciding which to use.
var routeNote = map[string]string{
	"sms-first":      "SMS first: your mobile carrier carries the text unencrypted; iMessage only if SMS fails",
	"imessage-first": "iMessage first: end-to-end encrypted by Apple; SMS only if iMessage fails",
}

func egressHeld(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "egress.off"))
	return err == nil
}

// logEgress appends one third-party send. Best effort: a full disk must not stop alerts.
func logEgress(dir string, e EgressEntry) {
	if r := []rune(e.Text); len(r) > egressTextMax {
		e.Text = string(r[:egressTextMax-1]) + "…"
	}
	path := filepath.Join(dir, "egress.jsonl")
	if fi, err := os.Stat(path); err == nil && fi.Size() > egressLogMax {
		_ = os.Rename(path, path+".1")
	}
	_ = os.MkdirAll(dir, 0o700)
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	b, _ := json.Marshal(e)
	_, _ = f.Write(append(b, '\n'))
}

// countOwnEgress adds one send to this Mac's own network (the tailnet) to today's counters.
func countOwnEgress(dir, what, host string, n int, now time.Time) {
	path := filepath.Join(dir, "egress-own.json")
	days := loadOwnEgress(path)
	day := now.Local().Format("2006-01-02")
	if days[day] == nil {
		days[day] = map[string]egressCount{}
	}
	k := what + " → " + host
	c := days[day][k]
	c.N++
	c.Bytes += int64(n)
	days[day][k] = c
	cut := now.Local().AddDate(0, 0, -egressOwnDays).Format("2006-01-02")
	for d := range days {
		if d < cut {
			delete(days, d)
		}
	}
	b, _ := json.Marshal(days)
	_ = os.MkdirAll(dir, 0o700)
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0o600) == nil {
		_ = os.Rename(tmp, path) // whole file or nothing: the CLI and the tick can both write
	}
}

func loadOwnEgress(path string) map[string]map[string]egressCount {
	days := map[string]map[string]egressCount{}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &days)
	}
	return days
}

func readEgress(dir string) []EgressEntry {
	var out []EgressEntry
	for _, name := range []string{"egress.jsonl.1", "egress.jsonl"} {
		f, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			var e EgressEntry
			if json.Unmarshal(sc.Bytes(), &e) == nil {
				out = append(out, e)
			}
		}
		f.Close()
	}
	return out
}

// maskHandle keeps enough of the recipient to recognise it: "+60…89", "j…@icloud.com".
func maskHandle(h string) string {
	if at := strings.LastIndex(h, "@"); at > 0 {
		return h[:1] + "…" + h[at:]
	}
	if len(h) > 6 {
		return h[:3] + "…" + h[len(h)-2:]
	}
	return "…"
}

func kb(n int64) string {
	if n < 1024 {
		return fmt.Sprintf("%d B", n)
	}
	if n < 1<<20 {
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(n)/(1<<20))
}

// egressCmd: `argo egress` shows what left this Mac; `argo egress off|on` holds or releases third-party sends.
func egressCmd(args []string, s Store, phone *Phone, w io.Writer, now time.Time) error {
	off := filepath.Join(s.Dir, "egress.off")
	switch {
	case len(args) == 1 && args[0] == "off":
		if err := os.MkdirAll(s.Dir, 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(off, []byte(now.Format(time.RFC3339)+"\n"), 0o600); err != nil {
			return err
		}
		fmt.Fprintln(w, "third-party sends held: texts wait on this Mac (newest 20). `argo egress on` sends them.")
		return nil
	case len(args) == 1 && args[0] == "on":
		if err := os.Remove(off); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if phone != nil {
			phone.Flush()
		}
		fmt.Fprintln(w, "third-party sends on.")
		return nil
	case len(args) > 0:
		return errors.New("usage: argo egress [off|on]")
	}

	since := now.AddDate(0, 0, -egressShowDays)
	var recent []EgressEntry
	var sent int64
	routes := map[string]bool{}
	for _, e := range readEgress(s.Dir) {
		if e.At.After(since) {
			recent = append(recent, e)
			sent += int64(e.Bytes)
			routes[e.Route] = true
		}
	}
	fmt.Fprintf(w, "What Argo sent off this Mac in the last %d days (log on this Mac: %s)\n", egressShowDays, filepath.Join(s.Dir, "egress.jsonl"))
	fmt.Fprintf(w, "Third parties: %d texts, %s through macOS Messages\n", len(recent), kb(sent))
	if phone != nil {
		routes[phone.Route] = true
	}
	for _, r := range []string{"sms-first", "imessage-first"} {
		if routes[r] {
			fmt.Fprintln(w, "  "+routeNote[r])
		}
	}
	show := recent
	if len(show) > 10 {
		show = show[len(show)-10:]
	}
	for _, e := range show {
		fmt.Fprintf(w, "  %s  %s  %s  %s\n", e.At.Local().Format("01-02 15:04"), e.To, kb(int64(e.Bytes)), strings.ReplaceAll(e.Text, "\n", " · "))
	}

	totals := map[string]egressCount{}
	cut := since.Local().Format("2006-01-02")
	for day, m := range loadOwnEgress(s.path("egress-own.json")) {
		if day < cut {
			continue
		}
		for k, c := range m {
			t := totals[k]
			t.N += c.N
			t.Bytes += c.Bytes
			totals[k] = t
		}
	}
	keys := make([]string, 0, len(totals))
	for k := range totals {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	fmt.Fprintln(w, "Your own network (Argo refuses any Gauss URL that isn't this Mac or the tailnet):")
	if len(keys) == 0 {
		fmt.Fprintln(w, "  nothing")
	}
	for _, k := range keys {
		fmt.Fprintf(w, "  %s: %d sends, %s\n", k, totals[k].N, kb(totals[k].Bytes))
	}

	if egressHeld(s.Dir) {
		held := 0
		if phone != nil {
			held = len(phone.readQueue())
		}
		fmt.Fprintf(w, "Third-party sends: HELD (%d texts waiting). `argo egress on` sends them.\n", held)
	} else {
		fmt.Fprintln(w, "Third-party sends: on. `argo egress off` holds them on this Mac; `argo phone imessage` keeps texts end-to-end encrypted.")
	}
	return nil
}
