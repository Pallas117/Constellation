package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The relay commands as a person types them, two devices on one machine (each its own HOME), no
// hub: keys, a carried folder both ways, send, outbox, inbox, and the usage errors.

type cmdDevice struct {
	t    *testing.T
	home string
	cfg  Config
}

func newCmdDevice(t *testing.T, name string) *cmdDevice {
	return &cmdDevice{t: t, home: t.TempDir(), cfg: Config{Device: name}}
}

// run switches HOME to this device and runs one command the way main does.
func (d *cmdDevice) run(cmd string, args ...string) (string, error) {
	d.t.Setenv("HOME", d.home)
	d.t.Setenv("ARGO_NO_DESKTOP", "1")
	var out bytes.Buffer
	err := relayMain(cmd, args, d.cfg, DefaultStore(), nil, &out)
	return out.String(), err
}

func (d *cmdDevice) must(cmd string, args ...string) string {
	d.t.Helper()
	out, err := d.run(cmd, args...)
	if err != nil {
		d.t.Fatalf("%s %v: %v\n%s", cmd, args, err, out)
	}
	return out
}

func TestRelayCommandsCarryAFileWithoutAHub(t *testing.T) {
	alice, bob := newCmdDevice(t, "alice"), newCmdDevice(t, "bob")
	if out := alice.must("keys"); !strings.Contains(out, "Created this device's keys") || !strings.Contains(out, "alice  ") {
		t.Fatalf("first keys = %q", out)
	}
	if out := alice.must("keys"); strings.Contains(out, "Created") {
		t.Fatalf("keys made twice: %q", out)
	}
	if out := alice.must("keys", "list"); !strings.Contains(out, "no other devices trusted yet") {
		t.Fatalf("keys list = %q", out)
	}

	// Bob's key reaches Alice in a carried folder; she trusts it on first sight.
	toAlice := filepath.Join(t.TempDir(), "to-alice")
	if out := bob.must("mule", "export", toAlice); !strings.Contains(out, "wrote 0 bundles") {
		t.Fatalf("bob export = %q", out)
	}
	if out := alice.must("mule", "import", toAlice); !strings.Contains(out, "trusted new key") || !strings.Contains(out, "bob ") {
		t.Fatalf("alice import = %q", out)
	}
	if out := alice.must("keys", "list"); !strings.HasPrefix(out, "bob ") {
		t.Fatalf("keys list after import = %q", out)
	}

	// Alice sends; with no hub the bundle waits for a carrier.
	file := filepath.Join(t.TempDir(), "report.txt")
	if err := os.WriteFile(file, []byte("telemetry 42\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if out := alice.must("send", "bob", file, "-ttl", "2h"); !strings.Contains(out, "queued report.txt for bob (1 bundle,") || strings.Contains(out, "sync:") {
		t.Fatalf("send = %q", out)
	}
	if out := alice.must("outbox"); !strings.Contains(out, "report.txt → bob: 0/1 confirmed") || !strings.Contains(out, "gives up in") {
		t.Fatalf("outbox = %q", out)
	}
	toBob := filepath.Join(t.TempDir(), "to-bob")
	if out := alice.must("mule", "export", toBob); !strings.Contains(out, "wrote 1 bundle ") {
		t.Fatalf("alice export = %q", out)
	}

	if out := bob.must("inbox"); !strings.Contains(out, "nothing received yet") {
		t.Fatalf("bob inbox before = %q", out)
	}
	if out := bob.must("mule", "import", toBob); !strings.Contains(out, "received 1, confirmed 0, refused 0") {
		t.Fatalf("bob import = %q", out)
	}
	out := bob.must("inbox")
	if !strings.Contains(out, "alice") || !strings.Contains(out, "report.txt") || !strings.Contains(out, "13 B") {
		t.Fatalf("bob inbox = %q", out)
	}
	got, err := os.ReadFile(filepath.Join(bob.home, "Downloads", "Argo", "alice", "report.txt"))
	if err != nil {
		matches, _ := filepath.Glob(filepath.Join(bob.home, "Downloads", "Argo", "*", "*"))
		if len(matches) != 1 {
			t.Fatalf("received file not found: %v %v", err, matches)
		}
		got, err = os.ReadFile(matches[0])
	}
	if err != nil || string(got) != "telemetry 42\n" {
		t.Fatalf("received %q, %v", got, err)
	}

	// Bob's receipt goes back the same way and confirms delivery at Alice.
	back := filepath.Join(t.TempDir(), "back")
	bob.must("mule", "export", back)
	if out := alice.must("mule", "import", back); !strings.Contains(out, "confirmed 1") {
		t.Fatalf("alice receipt import = %q", out)
	}
	if out := alice.must("outbox"); !strings.Contains(out, "1/1 confirmed") {
		t.Fatalf("outbox after receipt = %q", out)
	}
}

func TestRelayCommandErrorsSayWhatToDo(t *testing.T) {
	nameless := newCmdDevice(t, "")
	if _, err := nameless.run("outbox"); err == nil || !strings.Contains(err.Error(), "argo enroll") {
		t.Fatalf("no device name: %v", err)
	}
	d := newCmdDevice(t, "alice")
	for _, c := range []struct {
		cmd  string
		args []string
		want string
	}{
		{"send", []string{"bob"}, "usage: argo send"},
		{"send", []string{"alice", "/etc/hosts"}, "that is this device"},
		{"send", []string{"Bob!", "/etc/hosts"}, "lowercase"},
		{"send", []string{"bob", filepath.Join(d.home, "missing")}, "no such file"},
		{"sync", nil, "no Gauss hub configured"},
		{"keys", []string{"publish"}, "no Gauss hub configured"},
		{"keys", []string{"trust"}, "usage: argo keys trust"},
		{"keys", []string{"bogus"}, "usage: argo keys"},
		{"mule", []string{"export"}, "usage: argo mule"},
		{"mule", []string{"carry", "x"}, "usage: argo mule"},
		{"mule", []string{"import", filepath.Join(d.home, "nowhere")}, "no such file"},
	} {
		if _, err := d.run(c.cmd, c.args...); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s %v: err = %v, want %q", c.cmd, c.args, err, c.want)
		}
	}
}

func TestReorderFlagsAndSizes(t *testing.T) {
	got := strings.Join(reorderFlags([]string{"bob", "f.txt", "-ttl", "2h"}), " ")
	if got != "-ttl 2h bob f.txt" {
		t.Fatalf("reorder = %q", got)
	}
	if got := strings.Join(reorderFlags([]string{"-ttl=3h", "bob", "f"}), " "); got != "-ttl=3h bob f" {
		t.Fatalf("reorder = %q", got)
	}
	for n, want := range map[uint64]string{0: "0 B", 1023: "1023 B", 1536: "1.5 KB", 3 << 20: "3.0 MB"} {
		if got := sizeText(n); got != want {
			t.Errorf("sizeText(%d) = %q, want %q", n, got, want)
		}
	}
	if plural(1) != "" || plural(2) != "s" {
		t.Fatal("plural")
	}
}
