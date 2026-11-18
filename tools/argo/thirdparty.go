package main

// Third-party registry: every outside service the setup depends on is a node,
// the way mesh peers are. For each node Argo shows what Gauss data it can see
// (gauss-guard class), its scopes, where its credential lives, when it was
// last used and the exact place to revoke it, and it warns when a node is new,
// its scopes change, or an unregistered service shows up.
//
// The registry is the owner's file, ~/.config/argo/thirdparty.json (local
// class: it names accounts, so it never goes in the repo). Argo only reads it.
// Argo's own record (accepted baseline, last use, sightings) sits next to it in
// thirdparty.state.json. Argo never holds a credential: a node says WHERE the
// credential lives, and a node that looks like it holds one is refused.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// ThirdParty is one node of the registry.
type ThirdParty struct {
	ID         string   `json:"id"`
	Name       string   `json:"name,omitempty"`
	Kind       string   `json:"kind,omitempty"`      // connector | github-app | service | network | cli
	Sees       []string `json:"sees"`                // gauss-guard classes it can read: none, public, mesh, internal, local
	Scopes     []string `json:"scopes"`              // what it may do, in the vendor's words
	Credential string   `json:"credential"`          // where the credential lives; never the credential
	Revoke     string   `json:"revoke"`              // the exact place to revoke it
	LastUsed   string   `json:"last_used,omitempty"` // YYYY-MM-DD, when known
	Match      []string `json:"match,omitempty"`     // tool-name prefixes `argo thirdparty seen` credits to this node
	Notes      string   `json:"notes,omitempty"`
}

type tpRegistry struct {
	Nodes []ThirdParty `json:"nodes"`
}

// tpAccepted is what the owner last accepted for a node.
type tpAccepted struct {
	Sees   []string `json:"sees"`
	Scopes []string `json:"scopes"`
	Sum    string   `json:"sum"` // also covers kind, credential and revoke
}

type tpState struct {
	Accepted map[string]tpAccepted `json:"accepted"`            // nil (null) until the first check
	LastUsed map[string]string     `json:"last_used,omitempty"` // node id → YYYY-MM-DD, from `seen`
	Unknown  map[string]string     `json:"unknown,omitempty"`   // unregistered source → YYYY-MM-DD last seen
	Alerted  string                `json:"alerted,omitempty"`   // the review set last texted, so it goes once
}

type tpFiles struct{ Registry, State string }

func tpFilesIn(dir string) tpFiles {
	return tpFiles{filepath.Join(dir, "thirdparty.json"), filepath.Join(dir, "thirdparty.state.json")}
}

const (
	tpMaxFile    = 1 << 20
	tpMaxUnknown = 100
	tpUnusedDays = 90
)

var (
	tpClasses = map[string]bool{"none": true, "public": true, "mesh": true, "internal": true, "local": true}
	tpIDRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	tpDateRe  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
	tpToolRe  = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)
	// Credential shapes: vendor prefixes, private keys, JWTs.
	tpSecretRe = regexp.MustCompile(`(gh[pousr]_|github_pat_|[sr]k_(live|test)_|whsec_|xox[abpr]-|AKIA[0-9A-Z]{16}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.)`)
	tpOpaqueRe = regexp.MustCompile(`[A-Za-z0-9+=_]{32,}`)
)

// tpLooksSecret reports whether s seems to hold a credential rather than say
// where one lives: a vendor token shape, user:pass in a URL, or a long
// mixed-case run. UUIDs and URL paths pass (hyphens and slashes split them).
// Not Mask: it would refuse real scope names such as GitHub's "secrets: read".
func tpLooksSecret(s string) bool {
	if tpSecretRe.MatchString(s) || userinfoRe.MatchString(s) {
		return true
	}
	for _, run := range tpOpaqueRe.FindAllString(s, -1) {
		if strings.ContainsAny(run, "ABCDEFGHIJKLMNOPQRSTUVWXYZ") && strings.ContainsAny(run, "abcdefghijklmnopqrstuvwxyz") && strings.ContainsAny(run, "0123456789") {
			return true
		}
	}
	return false
}

func tpReadJSON(path string, v any) (bool, error) {
	f, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, tpMaxFile+1))
	if err != nil {
		return false, err
	}
	if len(b) > tpMaxFile {
		return false, fmt.Errorf("%s is over 1 MB", path)
	}
	if err := json.Unmarshal(b, v); err != nil {
		return false, fmt.Errorf("%s: %v", path, err)
	}
	return true, nil
}

func loadThirdParties(path string) (tpRegistry, bool, error) {
	var r tpRegistry
	ok, err := tpReadJSON(path, &r)
	return r, ok, err
}

func loadTPState(path string) tpState {
	var st tpState
	_, _ = tpReadJSON(path, &st) // a damaged record means a fresh baseline, never a crash
	return st
}

func saveTPState(path string, st tpState) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func tpSorted(v []string) []string {
	out := append([]string(nil), v...)
	sort.Strings(out)
	return out
}

func tpAccept(n ThirdParty) tpAccepted {
	sees, scopes := tpSorted(n.Sees), tpSorted(n.Scopes)
	h := sha256.Sum256([]byte(strings.Join([]string{n.Kind, strings.Join(sees, "\x1f"), strings.Join(scopes, "\x1f"), n.Credential, n.Revoke}, "\x1e")))
	return tpAccepted{Sees: sees, Scopes: scopes, Sum: hex.EncodeToString(h[:8])}
}

// tpFinding is one line of `argo thirdparty check`. Review findings (all but
// "unused") set the exit code and the phone text.
type tpFinding struct {
	Kind   string `json:"kind"` // invalid | local | new | changed | removed | unregistered | unused
	ID     string `json:"id"`
	Detail string `json:"detail"`
}

func (f tpFinding) review() bool { return f.Kind != "unused" }

func tpDiff(prefix string, was, now []string) []string {
	in := map[string]bool{}
	for _, v := range was {
		in[v] = true
	}
	var out []string
	for _, v := range now {
		if !in[v] {
			out = append(out, "+"+prefix+" "+v)
		}
		delete(in, v)
	}
	for _, v := range was {
		if in[v] {
			out = append(out, "-"+prefix+" "+v)
		}
	}
	return out
}

func tpLastUsed(n ThirdParty, st tpState) string {
	last := n.LastUsed
	if seen := st.LastUsed[n.ID]; seen > last {
		last = seen
	}
	return last
}

// checkThirdParties compares the registry with what was accepted. A missing
// baseline is the first run: callers record it (trust on first use).
func checkThirdParties(reg tpRegistry, st tpState, now time.Time) []tpFinding {
	var out []tpFinding
	ids := map[string]bool{}
	for _, n := range reg.Nodes {
		id := n.ID
		if id == "" {
			id = "(no id)"
		}
		var bad []string
		if !tpIDRe.MatchString(n.ID) {
			bad = append(bad, "id must be lowercase letters, digits, '.', '_' or '-'")
		}
		if ids[n.ID] {
			bad = append(bad, "duplicate id")
		}
		ids[n.ID] = true
		if len(n.Sees) == 0 {
			bad = append(bad, `say what Gauss data it can see ("none" if nothing)`)
		}
		for _, c := range n.Sees {
			if !tpClasses[c] {
				bad = append(bad, fmt.Sprintf("unknown class %q (none, public, mesh, internal, local)", c))
			}
		}
		if len(n.Scopes) == 0 {
			bad = append(bad, "list its scopes")
		}
		if strings.TrimSpace(n.Credential) == "" {
			bad = append(bad, "say where its credential lives")
		}
		if strings.TrimSpace(n.Revoke) == "" {
			bad = append(bad, "say where to revoke it")
		}
		if n.LastUsed != "" && !tpDateRe.MatchString(n.LastUsed) {
			bad = append(bad, "last_used must be YYYY-MM-DD")
		}
		b, _ := json.Marshal(n)
		if tpLooksSecret(string(b)) {
			bad = append(bad, "it looks like it holds a credential: write where the credential lives, never its value")
		}
		if len(bad) > 0 {
			out = append(out, tpFinding{"invalid", id, strings.Join(bad, "; ")})
			continue
		}
		for _, c := range n.Sees {
			if c == "local" {
				out = append(out, tpFinding{"local", n.ID, "can see local-class data, which must never leave this Mac: narrow it or revoke at " + n.Revoke})
			}
		}
		if st.Accepted != nil {
			acc, known := st.Accepted[n.ID]
			cur := tpAccept(n)
			switch {
			case !known:
				out = append(out, tpFinding{"new", n.ID, fmt.Sprintf("sees %s; scopes: %s", strings.Join(cur.Sees, ", "), strings.Join(cur.Scopes, ", "))})
			case acc.Sum != cur.Sum:
				d := append(tpDiff("sees", acc.Sees, cur.Sees), tpDiff("scope", acc.Scopes, cur.Scopes)...)
				if len(d) == 0 {
					d = []string{"credential place, revoke place or kind changed"}
				}
				out = append(out, tpFinding{"changed", n.ID, strings.Join(d, "; ")})
			}
		}
		if last := tpLastUsed(n, st); last != "" {
			if t, err := time.Parse("2006-01-02", last); err == nil {
				if days := int(now.Sub(t).Hours() / 24); days > tpUnusedDays {
					out = append(out, tpFinding{"unused", n.ID, fmt.Sprintf("last used %s (%d days ago): revoke at %s if it isn't needed", last, days, n.Revoke)})
				}
			}
		}
	}
	if st.Accepted != nil {
		var gone []string
		for id := range st.Accepted {
			if !ids[id] {
				gone = append(gone, id)
			}
		}
		sort.Strings(gone)
		for _, id := range gone {
			out = append(out, tpFinding{"removed", id, "no longer in the registry: check it was revoked, not just forgotten"})
		}
	}
	var unk []string
	for src := range st.Unknown {
		unk = append(unk, src)
	}
	sort.Strings(unk)
	for _, src := range unk {
		out = append(out, tpFinding{"unregistered", src, "used on " + st.Unknown[src] + " but no node matches it: add a node (with \"match\") or revoke it"})
	}
	return out
}

// tpAcceptAll records the registry's valid nodes as the accepted baseline.
func tpAcceptAll(reg tpRegistry, st *tpState) int {
	st.Accepted = map[string]tpAccepted{}
	for _, n := range reg.Nodes {
		if tpIDRe.MatchString(n.ID) {
			st.Accepted[n.ID] = tpAccept(n)
		}
	}
	st.Unknown = nil // seen again → flagged again
	return len(st.Accepted)
}

// tpReviewKey identifies a set of review findings, so one set is texted once.
func tpReviewKey(fs []tpFinding) string {
	var parts []string
	for _, f := range fs {
		if f.review() {
			parts = append(parts, f.Kind+":"+f.ID+":"+f.Detail)
		}
	}
	if len(parts) == 0 {
		return ""
	}
	sort.Strings(parts)
	h := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(h[:8])
}

// tpSource is the part of a tool name that names its service: "mcp__<server>"
// for MCP tools, else the whole name.
func tpSource(tool string) string {
	if rest, ok := strings.CutPrefix(tool, "mcp__"); ok {
		if i := strings.Index(rest, "__"); i > 0 {
			return "mcp__" + rest[:i]
		}
	}
	return tool
}

// tpSeen credits one use of a tool to its node (longest "match" prefix wins)
// or records it as unregistered. It reports whether the record changed: at
// most one write per node per day.
func tpSeen(reg tpRegistry, st *tpState, tool string, now time.Time) bool {
	day := now.Format("2006-01-02")
	best, bestLen := "", 0
	for _, n := range reg.Nodes {
		for _, m := range n.Match {
			if m != "" && strings.HasPrefix(tool, m) && len(m) > bestLen {
				best, bestLen = n.ID, len(m)
			}
		}
	}
	if best != "" {
		if st.LastUsed[best] == day {
			return false
		}
		if st.LastUsed == nil {
			st.LastUsed = map[string]string{}
		}
		st.LastUsed[best] = day
		return true
	}
	src := tpSource(tool)
	if st.Unknown[src] == day || (st.Unknown[src] == "" && len(st.Unknown) >= tpMaxUnknown) {
		return false
	}
	if st.Unknown == nil {
		st.Unknown = map[string]string{}
	}
	st.Unknown[src] = day
	return true
}

// tpHookTool reads the tool name from a Claude Code hook's JSON on stdin.
func tpHookTool(r io.Reader) string {
	var in struct {
		ToolName string `json:"tool_name"`
	}
	_ = json.NewDecoder(io.LimitReader(r, 1<<20)).Decode(&in)
	return in.ToolName
}

func tpListText(w io.Writer, reg tpRegistry, st tpState) {
	if len(reg.Nodes) == 0 {
		fmt.Fprintln(w, "third parties: the registry has no nodes")
		return
	}
	for _, n := range reg.Nodes {
		head := n.ID
		if n.Name != "" {
			head += "  " + n.Name
		}
		if n.Kind != "" {
			head += "  (" + n.Kind + ")"
		}
		last := tpLastUsed(n, st)
		if last == "" {
			last = "unknown"
		}
		fmt.Fprintf(w, "%s\n  sees: %s   last used: %s\n  scopes: %s\n  credential: %s\n  revoke: %s\n",
			head, strings.Join(n.Sees, ", "), last, strings.Join(n.Scopes, ", "), n.Credential, n.Revoke)
		if n.Notes != "" {
			fmt.Fprintf(w, "  notes: %s\n", n.Notes)
		}
	}
	fmt.Fprintf(w, "%d third parties. Argo holds none of their credentials.\n", len(reg.Nodes))
}

func tpCheckText(w io.Writer, fs []tpFinding, nodes int, first bool) int {
	review := 0
	for _, f := range fs {
		fmt.Fprintf(w, "%-13s %s: %s\n", strings.ToUpper(f.Kind), f.ID, f.Detail)
		if f.review() {
			review++
		}
	}
	switch {
	case first:
		fmt.Fprintf(w, "third parties: first check, recorded %d nodes as the accepted baseline; later changes are flagged.\n", nodes)
	case review == 0:
		fmt.Fprintf(w, "third parties: %d nodes, nothing new or changed.\n", nodes)
	default:
		fmt.Fprintf(w, "third parties: %d nodes, %d to review. Once reviewed: argo thirdparty accept\n", nodes, review)
	}
	return review
}

// thirdpartyTick texts once per new set of review findings. The text carries
// counts only: SMS is not end-to-end encrypted, and the list is internal.
func thirdpartyTick(files tpFiles, phone *Phone, now time.Time) {
	reg, ok, err := loadThirdParties(files.Registry)
	if !ok || err != nil {
		return // no registry, or one being edited: `check` reports the error
	}
	st := loadTPState(files.State)
	if st.Accepted == nil {
		tpAcceptAll(reg, &st)
		_ = saveTPState(files.State, st)
		return
	}
	fs := checkThirdParties(reg, st, now)
	key := tpReviewKey(fs)
	if key == st.Alerted {
		return
	}
	st.Alerted = key
	if key != "" && phone != nil {
		n := 0
		for _, f := range fs {
			if f.review() {
				n++
			}
		}
		phone.Send("Argo third parties", fmt.Sprintf("%d third-party change(s) to review. At the Mac: argo thirdparty check", n), now)
	}
	_ = saveTPState(files.State, st)
}

// thirdpartyCmd: `argo thirdparty [list|check|accept|seen [TOOL]] [-dir D] [-json]`.
// check exits 3 when something needs review.
func thirdpartyCmd(args []string, dir string, in io.Reader, out io.Writer, now time.Time) (int, error) {
	sub := "list"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		sub, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("thirdparty "+sub, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	d := fs.String("dir", dir, "folder holding thirdparty.json")
	asJSON := fs.Bool("json", false, "machine-readable output")
	if err := fs.Parse(args); err != nil {
		return 2, err
	}
	files := tpFilesIn(*d)
	if sub == "seen" { // Claude Code hook: never fails, never blocks the tool call
		tool := fs.Arg(0)
		if f, isFile := in.(*os.File); tool == "" && isFile {
			if fi, err := f.Stat(); err == nil && fi.Mode()&os.ModeCharDevice != 0 {
				return 2, errors.New("usage: argo thirdparty seen TOOL (or a Claude Code hook's JSON on stdin)")
			}
		}
		if tool == "" {
			tool = tpHookTool(in)
		}
		reg, ok, err := loadThirdParties(files.Registry)
		if !ok || err != nil || !tpToolRe.MatchString(tool) {
			return 0, nil // no registry yet: nothing to credit, and no record made
		}
		st := loadTPState(files.State)
		if tpSeen(reg, &st, tool, now) {
			_ = saveTPState(files.State, st)
		}
		return 0, nil
	}
	reg, ok, err := loadThirdParties(files.Registry)
	if err != nil {
		return 1, err
	}
	if !ok {
		return 1, fmt.Errorf("no registry at %s: add one node per outside service (see tools/argo/README.md, Third parties)", files.Registry)
	}
	st := loadTPState(files.State)
	switch sub {
	case "list":
		if *asJSON {
			b, _ := json.MarshalIndent(reg, "", "  ")
			fmt.Fprintln(out, string(b))
			return 0, nil
		}
		tpListText(out, reg, st)
		return 0, nil
	case "check":
		first := st.Accepted == nil
		found := checkThirdParties(reg, st, now)
		if first {
			tpAcceptAll(reg, &st)
			if err := saveTPState(files.State, st); err != nil {
				return 1, err
			}
		}
		review := 0
		if *asJSON {
			b, _ := json.MarshalIndent(found, "", "  ")
			fmt.Fprintln(out, string(b))
			for _, f := range found {
				if f.review() {
					review++
				}
			}
		} else {
			review = tpCheckText(out, found, len(reg.Nodes), first)
		}
		if review > 0 {
			return 3, nil
		}
		return 0, nil
	case "accept":
		for _, f := range checkThirdParties(reg, st, now) {
			if f.Kind == "invalid" {
				return 1, fmt.Errorf("fix %s first: %s", f.ID, f.Detail)
			}
		}
		n := tpAcceptAll(reg, &st)
		st.Alerted = ""
		if err := saveTPState(files.State, st); err != nil {
			return 1, err
		}
		fmt.Fprintf(out, "third parties: accepted %d nodes as reviewed.\n", n)
		return 0, nil
	}
	return 2, errors.New("usage: argo thirdparty [list|check|accept|seen [TOOL]] [-dir D] [-json]")
}
