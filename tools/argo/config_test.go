package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigSurvivesATornOrHandBrokenFile(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if c := loadConfig(); c.GaussURL != "" {
		t.Fatalf("no file = %+v, want defaults", c)
	}
	if err := saveConfig(Config{GaussURL: "http://127.0.0.1:3001", PhoneTo: "+60100000000"}); err != nil {
		t.Fatal(err)
	}
	if err := saveConfig(Config{GaussURL: "http://127.0.0.1:3001", PhoneTo: "+60100000001"}); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(configDir(), "config.json")
	if fi, err := os.Stat(p); err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("config.json mode = %v, %v", fi, err)
	}
	if _, err := os.Stat(p + ".tmp"); !os.IsNotExist(err) {
		t.Fatal("temp file left behind")
	}
	if c := loadConfig(); c.PhoneTo != "+60100000001" {
		t.Fatalf("latest save not read: %+v", c)
	}
	for _, broken := range []string{`{"gauss_url": "http://127.0.0.1:3001", "phone_to": `, "", `{"phone_to": 7}`} {
		if err := os.WriteFile(p, []byte(broken), 0o600); err != nil {
			t.Fatal(err)
		}
		if c := loadConfig(); c.PhoneTo != "+60100000000" || c.GaussURL == "" {
			t.Fatalf("broken config %q = %+v, want the last good copy", broken, c)
		}
	}
}

func TestSaveConfigKeepsOnlyAValidCopyAsGood(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	if err := os.MkdirAll(configDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(configDir(), "config.json")
	if err := os.WriteFile(p+".good", []byte(`{"phone_to":"+60100000000"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(`{broken`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := saveConfig(Config{PhoneTo: "+60100000002"}); err != nil {
		t.Fatal(err)
	}
	if c, err := readConfig(p + ".good"); err != nil || c.PhoneTo != "+60100000000" {
		t.Fatalf("a broken file replaced the good copy: %+v, %v", c, err)
	}
}

func TestStateSurvivesCorruptFiles(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	if err := os.WriteFile(s.path("state.json"), []byte(`{"networks": {"x": `), 0o600); err != nil {
		t.Fatal(err)
	}
	if st := s.Load(); st.Networks == nil {
		t.Fatal("corrupt state.json must load as empty, usable state")
	}
	if err := s.Append(Incident{Event: "open", Class: "OFFLINE"}); err != nil {
		t.Fatal(err)
	}
	// A run killed mid-append leaves half a line; the next incident must still be readable.
	f, err := os.OpenFile(s.path("incidents.jsonl"), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"event":"attem`)
	f.Close()
	if err := s.Append(Incident{Event: "resolved", Class: "OK"}); err != nil {
		t.Fatal(err)
	}
	got := s.Incidents()
	if len(got) != 2 || got[0].Event != "open" || got[1].Event != "resolved" {
		t.Fatalf("incidents = %+v: want open and resolved, the torn line skipped", got)
	}
}
