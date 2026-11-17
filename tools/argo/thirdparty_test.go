package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Made-up services: the real registry is local and never in the repo.
func tpNode(id string, scopes ...string) ThirdParty {
	return ThirdParty{ID: id, Kind: "connector", Sees: []string{"internal"}, Scopes: scopes,
		Credential: "vendor side (OAuth); nothing on this Mac", Revoke: "https://example.test/settings/apps",
		Match: []string{"mcp__0b5e3c1a-1111-4222-8333-944455556666__"}}
}

func tpWrite(t *testing.T, dir string, nodes ...ThirdParty) {
	t.Helper()
	b, _ := json.Marshal(tpRegistry{Nodes: nodes})
	if err := os.WriteFile(filepath.Join(dir, "thirdparty.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func tpRun(t *testing.T, dir, sub string, rest ...string) (int, string) {
	t.Helper()
	var out bytes.Buffer
	code, err := thirdpartyCmd(append([]string{sub, "-dir", dir}, rest...), filepath.Join(dir, "default-unused"), strings.NewReader(""), &out, tpNow)
	if err != nil {
		return code, err.Error()
	}
	return code, out.String()
}

var tpNow = time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC)

func TestThirdPartyFirstCheckIsBaselineThenFlagsChanges(t *testing.T) {
	dir := t.TempDir()
	tpWrite(t, dir, tpNode("tracker", "issues:read"), tpNode("mail", "read"))
	if code, out := tpRun(t, dir, "check"); code != 0 || !strings.Contains(out, "first check, recorded 2 nodes") {
		t.Fatalf("first check: %d %q", code, out)
	}
	if code, out := tpRun(t, dir, "check"); code != 0 || !strings.Contains(out, "nothing new or changed") {
		t.Fatalf("unchanged: %d %q", code, out)
	}

	// A widened scope, a new node and a dropped node are each flagged.
	tpWrite(t, dir, tpNode("tracker", "issues:read", "issues:write"), tpNode("drive", "files:read"))
	code, out := tpRun(t, dir, "check")
	if code != 3 {
		t.Fatalf("want exit 3, got %d: %s", code, out)
	}
	for _, want := range []string{"CHANGED       tracker: +scope issues:write", "NEW           drive: sees internal; scopes: files:read", "REMOVED       mail:", "3 to review"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}

	// Moving the credential is a change too, even with the same scopes.
	n := tpNode("drive", "files:read")
	n.Credential = "macOS Keychain item on this Mac"
	tpWrite(t, dir, tpNode("tracker", "issues:read", "issues:write"), n)
	if _, out := tpRun(t, dir, "accept"); !strings.Contains(out, "accepted 2 nodes") {
		t.Fatalf("accept: %q", out)
	}
	n.Credential = "vendor side (OAuth); nothing on this Mac"
	tpWrite(t, dir, tpNode("tracker", "issues:read", "issues:write"), n)
	if code, out := tpRun(t, dir, "check"); code != 3 || !strings.Contains(out, "credential place, revoke place or kind changed") {
		t.Fatalf("credential move: %d %q", code, out)
	}
}

func TestThirdPartyRefusesCredentialsAndBadNodes(t *testing.T) {
	dir := t.TempDir()
	leak := tpNode("forge", "contents:read")
	leak.Credential = "ghp_" + strings.Repeat("a1B2", 9) // a token pasted where its place belongs
	bare := ThirdParty{ID: "Bare Node", Sees: []string{"secret-ish"}}
	tpWrite(t, dir, leak, bare, tpNode("forge", "x"))
	code, out := tpRun(t, dir, "check")
	if code != 3 {
		t.Fatalf("want exit 3, got %d", code)
	}
	for _, want := range []string{"looks like it holds a credential", "id must be lowercase", `unknown class "secret-ish"`, "list its scopes", "say where its credential lives", "say where to revoke it", "duplicate id"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, strings.Repeat("a1B2", 9)) {
		t.Fatal("check printed the credential back")
	}
	if code, msg := tpRun(t, dir, "accept"); code != 1 || !strings.Contains(msg, "fix forge first") {
		t.Fatalf("accept must refuse invalid nodes: %d %q", code, msg)
	}
}

func TestThirdPartyLooksSecret(t *testing.T) {
	for _, s := range []string{
		"ghp_" + strings.Repeat("x", 36), "github_pat_11ABC", "sk_live_51H", "rk_test_abc", "whsec_abc", "xoxb-123-456",
		"AKIAABCDEFGHIJKLMNOP", "-----BEGIN OPENSSH PRIVATE KEY-----", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig",
		"https://bot:hunter2@example.test/hook", "Qm9vdHN0cmFwVG9rZW5WYWx1ZTEyMzQ1Njc4OQ",
	} {
		if !tpLooksSecret(s) {
			t.Errorf("should look like a credential: %q", s)
		}
	}
	for _, s := range []string{
		"mcp__7c1d2e3f-aaaa-4bbb-8ccc-0123456789ab__", "https://github.com/organizations/Pallas117/settings/installations",
		"secrets: read", "Worker secret STRIPE_SECRET_KEY (Cloudflare)", "macOS Keychain item \"Claude Code-credentials\"",
		"api-tokens page: https://dash.example.test/profile/api-tokens",
	} {
		if tpLooksSecret(s) {
			t.Errorf("should pass as a place, not a credential: %q", s)
		}
	}
}

func TestThirdPartyLocalClassAndUnusedNodes(t *testing.T) {
	dir := t.TempDir()
	wide := tpNode("sync", "files:read")
	wide.Sees = []string{"internal", "local"}
	old := tpNode("design", "files:read")
	old.LastUsed = "2026-07-01"
	tpWrite(t, dir, wide, old)
	tpRun(t, dir, "check") // baseline
	code, out := tpRun(t, dir, "check")
	if code != 3 || !strings.Contains(out, "LOCAL         sync: can see local-class data") {
		t.Fatalf("local class: %d %q", code, out)
	}
	if !strings.Contains(out, "UNUSED        design: last used 2026-07-01 (125 days ago): revoke at https://example.test/settings/apps") {
		t.Fatalf("unused: %q", out)
	}

	// Unused alone is advice, not something to review.
	tpWrite(t, dir, old)
	tpRun(t, dir, "accept")
	if code, out := tpRun(t, dir, "check"); code != 0 || !strings.Contains(out, "UNUSED") {
		t.Fatalf("unused only: %d %q", code, out)
	}
}

func TestThirdPartySeenCreditsNodesAndFlagsStrangers(t *testing.T) {
	dir := t.TempDir()
	mail := tpNode("mail", "read")
	mail.Match = []string{"mcp__aaaa__", "mcp__aaaa__send"}
	other := tpNode("mailsend", "send")
	other.Match = []string{"mcp__aaaa__send_"}
	tpWrite(t, dir, mail, other)
	tpRun(t, dir, "check")

	for _, tool := range []string{"mcp__aaaa__search_threads", "mcp__aaaa__send_message", "mcp__bbbb__list_files", "mcp__bbbb__read_file"} {
		if code, _ := tpRun(t, dir, "seen", tool); code != 0 {
			t.Fatalf("seen %s: exit %d", tool, code)
		}
	}
	st := loadTPState(tpFilesIn(dir).State)
	if st.LastUsed["mail"] != "2026-11-03" || st.LastUsed["mailsend"] != "2026-11-03" {
		t.Fatalf("last used (longest match wins): %v", st.LastUsed)
	}
	if len(st.Unknown) != 1 || st.Unknown["mcp__bbbb"] != "2026-11-03" {
		t.Fatalf("stranger recorded per server: %v", st.Unknown)
	}
	code, out := tpRun(t, dir, "check")
	if code != 3 || !strings.Contains(out, "UNREGISTERED  mcp__bbbb: used on 2026-11-03 but no node matches it") {
		t.Fatalf("unregistered: %d %q", code, out)
	}
	if _, out := tpRun(t, dir, "list"); !strings.Contains(out, "mail  (connector)\n  sees: internal   last used: 2026-11-03") {
		t.Fatalf("list shows last use: %q", out)
	}

	// Second use the same day writes nothing.
	before, _ := os.Stat(tpFilesIn(dir).State)
	if tpSeen(tpRegistry{Nodes: []ThirdParty{mail}}, &st, "mcp__aaaa__get_thread", tpNow) {
		t.Fatal("same-day use must not change the record")
	}
	tpRun(t, dir, "seen", "mcp__aaaa__get_thread")
	after, _ := os.Stat(tpFilesIn(dir).State)
	if !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("state rewritten")
	}
}

func TestThirdPartySeenFromHookAndWithoutRegistry(t *testing.T) {
	dir := t.TempDir()
	hook := `{"session_id":"s","hook_event_name":"PostToolUse","tool_name":"mcp__cccc__create_design","tool_input":{}}`
	var out bytes.Buffer
	if code, err := thirdpartyCmd([]string{"seen", "-dir", dir}, "", strings.NewReader(hook), &out, tpNow); code != 0 || err != nil {
		t.Fatalf("no registry: %d %v", code, err)
	}
	if _, err := os.Stat(tpFilesIn(dir).State); !os.IsNotExist(err) {
		t.Fatal("seen without a registry must not create a record")
	}
	tpWrite(t, dir, tpNode("tracker", "issues:read"))
	for _, in := range []string{hook, "not json", `{"tool_name":"bad name; rm -rf"}`} {
		if code, err := thirdpartyCmd([]string{"seen", "-dir", dir}, "", strings.NewReader(in), &out, tpNow); code != 0 || err != nil {
			t.Fatalf("hook must never fail: %d %v", code, err)
		}
	}
	st := loadTPState(tpFilesIn(dir).State)
	if len(st.Unknown) != 1 || st.Unknown["mcp__cccc"] == "" {
		t.Fatalf("hook input: %v", st.Unknown)
	}

	// The record of strangers is capped.
	for i := 0; i < tpMaxUnknown+20; i++ {
		tpSeen(tpRegistry{}, &st, "mcp__s"+strings.Repeat("x", i%50)+string(rune('a'+i%26))+"__t", tpNow)
	}
	if len(st.Unknown) > tpMaxUnknown {
		t.Fatalf("unknown grew to %d", len(st.Unknown))
	}
}

func TestThirdPartyTickTextsCountsOnceWithoutNames(t *testing.T) {
	dir := t.TempDir()
	files := tpFilesIn(dir)
	var sent []string
	p := testPhone(t, func(_, text string) error { sent = append(sent, text); return nil })

	thirdpartyTick(files, p, tpNow) // no registry: nothing happens
	tpWrite(t, dir, tpNode("tracker", "issues:read"))
	thirdpartyTick(files, p, tpNow) // first sight: baseline, no text
	if len(sent) != 0 || loadTPState(files.State).Accepted == nil {
		t.Fatalf("first tick: sent %v", sent)
	}
	tpWrite(t, dir, tpNode("tracker", "issues:read", "issues:write"), tpNode("secretdrive", "files:read"))
	thirdpartyTick(files, p, tpNow)
	thirdpartyTick(files, p, tpNow.Add(time.Minute)) // same change: no second text
	if len(sent) != 1 || !strings.Contains(sent[0], "2 third-party change(s) to review") {
		t.Fatalf("want one text with the count, got %v", sent)
	}
	if strings.Contains(sent[0], "tracker") || strings.Contains(sent[0], "secretdrive") || strings.Contains(sent[0], "issues") {
		t.Fatalf("the text must not name services or scopes: %q", sent[0])
	}

	// Reviewed and accepted: quiet; the next change texts again.
	tpRun(t, dir, "accept")
	thirdpartyTick(files, p, tpNow.Add(2*time.Minute))
	tpWrite(t, dir, tpNode("tracker", "issues:read"))
	thirdpartyTick(files, p, tpNow.Add(3*time.Minute))
	if len(sent) != 2 {
		t.Fatalf("want a text for the next change, got %v", sent)
	}
}

func TestThirdPartyListAndErrors(t *testing.T) {
	dir := t.TempDir()
	if code, msg := tpRun(t, dir, "list"); code != 1 || !strings.Contains(msg, "no registry at") {
		t.Fatalf("missing registry: %d %q", code, msg)
	}
	if err := os.WriteFile(filepath.Join(dir, "thirdparty.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code, _ := tpRun(t, dir, "check"); code != 1 {
		t.Fatal("broken JSON must be an error")
	}
	n := tpNode("tracker", "issues:read", "comments:write")
	n.Name, n.Notes = "Issue tracker", "scopes from the tool list (UNVERIFIED)"
	tpWrite(t, dir, n)
	_, out := tpRun(t, dir, "list")
	for _, want := range []string{"tracker  Issue tracker  (connector)", "scopes: issues:read, comments:write", "credential: vendor side (OAuth); nothing on this Mac", "revoke: https://example.test/settings/apps", "last used: unknown", "Argo holds none of their credentials"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	_, js := tpRun(t, dir, "list", "-json")
	var back tpRegistry
	if json.Unmarshal([]byte(js), &back) != nil || len(back.Nodes) != 1 {
		t.Fatalf("list -json: %q", js)
	}
	if code, _ := tpRun(t, dir, "frobnicate"); code != 2 {
		t.Fatal("unknown subcommand must be a usage error")
	}
	if fi, err := os.Stat(tpFilesIn(dir).State); err == nil && fi.Mode().Perm() != 0o600 {
		t.Fatalf("state mode %v", fi.Mode().Perm())
	}
}
