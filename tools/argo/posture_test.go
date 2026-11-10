package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var postNow = time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

// Fixtures. The macOS outputs are the ones this Mac printed on 2026-11-10
// (macOS 27.0.1); the "off" variants and all Linux fixtures follow the cited
// documentation and are UNVERIFIED against a live system.
const (
	fxTailscale = `{"Version":"1.90.1","BackendState":"Running","Self":{"ID":"n1234SECRETID","HostName":"judith-secret-host","DNSName":"judith-secret-host.tail9999.ts.net.","TailscaleIPs":["100.99.88.77"],"UserID":424242,"KeyExpiry":"2027-03-01T00:00:00Z"},"Peer":{"k":{"HostName":"peer-secret-host"}}}`
	fxDefaults  = `{
    AutomaticDownload = 1;
    AutomaticallyInstallMacOSUpdates = 1;
    ConfigDataInstall = 1;
    CriticalUpdateInstall = 1;
    LastFullSuccessfulDate = "2026-11-09 03:11:42 +0000";
    PrimaryLanguages = ("en-GB");
    RecommendedUpdates = ();
    SerialSECRET = "C02SECRETSN";
}`
)

func macOK() map[string]string {
	return map[string]string{
		macFdesetup + " status":                                             "FileVault is On.\n",
		macFirewallTool + " --getglobalstate":                               "Firewall is enabled. (State = 1)\n",
		macDefaults + " read /Library/Preferences/com.apple.SoftwareUpdate": fxDefaults,
		macCsrutil + " status":                                              "System Integrity Protection status: enabled.\n",
		macSpctl + " --status":                                              "assessments enabled\n",
		"/ts/tailscale status --json":                                       fxTailscale,
	}
}

// fixtureEnv answers commands and file reads from maps; anything else fails, as on a machine without the tool.
func fixtureEnv(cmds map[string]string, files map[string]string, dirs map[string][]string) postureEnv {
	return postureEnv{
		run: func(_ context.Context, name string, args ...string) (string, error) {
			if out, ok := cmds[strings.Join(append([]string{name}, args...), " ")]; ok {
				return out, nil
			}
			return "", errors.New("no such tool")
		},
		readFile: func(p string) ([]byte, error) {
			if b, ok := files[p]; ok {
				return []byte(b), nil
			}
			return nil, os.ErrNotExist
		},
		readDir: func(p string) ([]string, error) {
			if d, ok := dirs[p]; ok {
				return d, nil
			}
			return nil, os.ErrNotExist
		},
		lanIP:     func(context.Context) string { return "192.168.7.20" },
		dial:      func(string) bool { return false },
		tailscale: "/ts/tailscale",
		now:       postNow,
	}
}

func statuses(p Posture) map[string]string {
	m := map[string]string{}
	for _, it := range p.Items {
		m[it.ID] = it.Status
	}
	return m
}

func byID(p Posture, id string) PostureItem {
	for _, it := range p.Items {
		if it.ID == id {
			return it
		}
	}
	return PostureItem{}
}

func TestPostureMacAllGood(t *testing.T) {
	e := fixtureEnv(macOK(), nil, nil)
	e.keyPinned, e.update = true, updateState{CheckedAt: postNow.Add(-time.Hour), Running: version, Latest: version}
	p := runPosture(context.Background(), "darwin", e)
	if len(p.Items) != len(postureIDs) {
		t.Fatalf("%d items, want %d", len(p.Items), len(postureIDs))
	}
	for i, it := range p.Items {
		if it.ID != postureIDs[i] || it.Name == "" || it.Detail == "" {
			t.Errorf("item %d: %+v", i, it)
		}
		if it.Status != postureOK || it.Fix != "" {
			t.Errorf("%s: %s (%s), fix %q", it.ID, it.Status, it.Detail, it.Fix)
		}
	}
	if p.Platform != "macos" || !p.At.Equal(postNow) {
		t.Errorf("header: %+v", p)
	}
}

func TestPostureMacFindings(t *testing.T) {
	cases := []struct {
		name, key, out, id, want string
	}{
		{"filevault off", macFdesetup + " status", "FileVault is Off.\n", "disk", postureFail},
		{"filevault encrypting", macFdesetup + " status", "FileVault is On.\nEncryption in progress: Percent completed = 40\n", "disk", postureWarn},
		{"filevault decrypting", macFdesetup + " status", "FileVault is On.\nDecryption in progress: Percent completed = 40\n", "disk", postureWarn},
		{"filevault garbled", macFdesetup + " status", "Error: something\n", "disk", postureUnknown},
		{"firewall off", macFirewallTool + " --getglobalstate", "Firewall is disabled. (State = 0)\n", "firewall", postureFail},
		{"firewall block all", macFirewallTool + " --getglobalstate", "Firewall is enabled. (State = 2)\n", "firewall", postureOK},
		{"firewall garbled", macFirewallTool + " --getglobalstate", "???", "firewall", postureUnknown},
		{"security responses off", macDefaults + " read /Library/Preferences/com.apple.SoftwareUpdate", "{\n    CriticalUpdateInstall = 0;\n}", "updates", postureFail},
		{"update check off", macDefaults + " read /Library/Preferences/com.apple.SoftwareUpdate", "{\n    AutomaticCheckEnabled = 0;\n    CriticalUpdateInstall = 1;\n}", "updates", postureFail},
		{"os updates manual", macDefaults + " read /Library/Preferences/com.apple.SoftwareUpdate", "{\n    AutomaticallyInstallMacOSUpdates = 0;\n    CriticalUpdateInstall = 1;\n}", "updates", postureWarn},
		{"update keys absent", macDefaults + " read /Library/Preferences/com.apple.SoftwareUpdate", "{\n    LastFullSuccessfulDate = \"2026-11-09\";\n}", "updates", postureUnknown},
		{"sip off", macCsrutil + " status", "System Integrity Protection status: disabled.\n", "integrity", postureFail},
		{"sip custom", macCsrutil + " status", "System Integrity Protection status: unknown (Custom Configuration).\n", "integrity", postureWarn},
		{"gatekeeper off", macSpctl + " --status", "assessments disabled\n", "integrity", postureFail},
		{"gatekeeper garbled", macSpctl + " --status", "", "integrity", postureUnknown},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cmds := macOK()
			cmds[c.key] = c.out
			it := byID(runPosture(context.Background(), "darwin", fixtureEnv(cmds, nil, nil)), c.id)
			if it.Status != c.want {
				t.Fatalf("%s = %s (%s), want %s", c.id, it.Status, it.Detail, c.want)
			}
			if c.want != postureOK && it.Fix == "" {
				t.Error("no fix hint")
			}
			if strings.Contains(it.Fix, "\n") || strings.Contains(it.Detail, "\n") {
				t.Error("detail and fix must be one line")
			}
		})
	}
}

// A check whose tool is missing, times out or prints nothing is unknown, never ok.
func TestPostureUnreadableIsUnknownNeverOK(t *testing.T) {
	e := fixtureEnv(nil, nil, nil)
	e.lanIP = func(context.Context) string { return "" }
	for _, goos := range []string{"darwin", "linux", "plan9"} {
		p := runPosture(context.Background(), goos, e)
		if len(p.Items) != len(postureIDs) {
			t.Fatalf("%s: %d items", goos, len(p.Items))
		}
		for _, it := range p.Items {
			if it.Status != postureUnknown {
				t.Errorf("%s %s = %s with nothing readable", goos, it.ID, it.Status)
			}
		}
	}
}

func TestPostureOutputCarriesNoIdentifiers(t *testing.T) {
	e := fixtureEnv(macOK(), nil, nil)
	e.dial = func(addr string) bool { return strings.HasSuffix(addr, ":22") }
	p := runPosture(context.Background(), "darwin", e)
	var text bytes.Buffer
	postureText(&text, p)
	js, _ := json.Marshal(p)
	compact, _ := postureCompact(p)
	cj, _ := json.Marshal(compact)
	all := text.String() + string(js) + string(cj)
	for _, never := range []string{"SECRET", "secret", "judith", "100.99.88.77", "192.168.7.20", "424242", "tail9999", "en-GB", home()} {
		if strings.Contains(all, never) {
			t.Errorf("output leaks %q:\n%s", never, all)
		}
	}
	if !strings.Contains(text.String(), "Remote Login (SSH)") || !strings.Contains(text.String(), "fix: "+sharingAdvice) {
		t.Errorf("sharing finding or fix missing:\n%s", text.String())
	}
	if !strings.Contains(text.String(), "5 ok, 1 warn, 0 fail, 1 unknown") {
		t.Errorf("summary line:\n%s", text.String())
	}
}

func TestPostureTailnetKeyExpiry(t *testing.T) {
	ts := func(state, expiry string) string {
		self := `{"HostName":"x"}`
		if expiry != "" {
			self = `{"HostName":"x","KeyExpiry":"` + expiry + `"}`
		}
		return `{"BackendState":"` + state + `","Self":` + self + `}`
	}
	cases := []struct{ name, out, want, detail string }{
		{"plenty left", ts("Running", "2027-03-01T00:00:00Z"), postureOK, "Key valid for 110 more days"},
		{"exactly 14 days", ts("Running", "2026-11-24T12:00:00Z"), postureOK, "Key valid for 14 more days"},
		{"13 days", ts("Running", "2026-11-24T11:00:00Z"), postureWarn, "expires in 13 days"},
		{"1 day", ts("Running", "2026-11-11T13:00:00Z"), postureWarn, "expires in 1 day"},
		{"expired", ts("Running", "2026-11-09T00:00:00Z"), postureFail, "has expired"},
		{"expiry disabled", ts("Running", ""), postureOK, "does not expire"},
		{"signed out", ts("NeedsLogin", ""), postureFail, "signed out"},
		{"stopped", ts("Stopped", "2027-03-01T00:00:00Z"), postureUnknown, "not connected"},
		{"not json", "tailscale: command failed", postureUnknown, "did not answer"},
		{"empty", "", postureUnknown, "did not answer"},
		{"no self", `{"BackendState":"Running"}`, postureUnknown, "no details"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			it := tailKeyItem(context.Background(), fixtureEnv(map[string]string{"/ts/tailscale status --json": c.out}, nil, nil))
			if it.Status != c.want || !strings.Contains(it.Detail, c.detail) {
				t.Errorf("%s: %q, want %s with %q", it.Status, it.Detail, c.want, c.detail)
			}
		})
	}
}

func TestPostureArgoCurrent(t *testing.T) {
	fresh := updateState{CheckedAt: postNow.Add(-2 * time.Hour), Running: version, Latest: "9.9.9"}
	avail := fresh
	avail.Available = true
	stale := fresh
	stale.CheckedAt = postNow.Add(-updateStateMaxAge - time.Hour)
	other := fresh
	other.Running = "0.0.1" // checked by a different build of Argo
	cases := []struct {
		name   string
		pinned bool
		st     updateState
		want   string
	}{
		{"no key pinned", false, fresh, postureUnknown},
		{"never checked", true, updateState{}, postureUnknown},
		{"stale check", true, stale, postureUnknown},
		{"check from another build", true, other, postureUnknown},
		{"update available", true, avail, postureWarn},
		{"current", true, fresh, postureOK},
	}
	for _, c := range cases {
		if it := argoItem(postureEnv{now: postNow, keyPinned: c.pinned, update: c.st}); it.Status != c.want {
			t.Errorf("%s: %s (%s), want %s", c.name, it.Status, it.Detail, c.want)
		}
	}
}

func TestPostureSharing(t *testing.T) {
	e := fixtureEnv(nil, nil, nil)
	var dialled []string
	e.dial = func(addr string) bool {
		dialled = append(dialled, addr)
		return strings.HasSuffix(addr, ":445") || strings.HasSuffix(addr, ":5900")
	}
	it := sharingItem(context.Background(), e)
	if it.Status != postureWarn || it.Detail != "Reachable by others on this network: File Sharing (SMB), Screen Sharing" || it.Fix != sharingAdvice {
		t.Errorf("%+v", it)
	}
	if len(dialled) != len(sharingPorts) {
		t.Errorf("dialled %v", dialled)
	}
	for _, a := range dialled {
		if !strings.HasPrefix(a, "192.168.7.20:") {
			t.Errorf("dialled %s, not this host's own address", a)
		}
	}
	e.dial = func(string) bool { return false }
	if it := sharingItem(context.Background(), e); it.Status != postureOK {
		t.Errorf("closed: %+v", it)
	}
	for _, ip := range []string{"", "127.0.0.1"} {
		e.lanIP = func(context.Context) string { return ip }
		e.dial = func(string) bool { t.Error("dialled while offline"); return true }
		if it := sharingItem(context.Background(), e); it.Status != postureUnknown {
			t.Errorf("offline (%q): %+v", ip, it)
		}
	}
}

const fxMountLUKS = `22 1 253:1 / / rw,relatime shared:1 - ext4 /dev/mapper/vg-root rw
30 22 259:2 / /boot rw,relatime shared:2 - ext4 /dev/nvme0n1p2 rw
`

func TestPostureLinuxDisk(t *testing.T) {
	lvmOnLUKS := func() (map[string]string, map[string][]string) {
		return map[string]string{
				"/proc/self/mountinfo":           fxMountLUKS,
				"/sys/dev/block/253:1/dm/uuid":   "LVM-abcdefSECRET\n",
				"/sys/class/block/dm-0/dm/uuid":  "CRYPT-LUKS2-0123456789abcdefSECRET-luks\n",
				"/sys/class/block/nvme0n1p3/dev": "259:3\n",
				"/sys/dev/block/259:5/dev":       "259:5\n",
				"/sys/dev/block/8:2/dev":         "8:2\n",
				"/sys/dev/block/253:7/dm/uuid":   "CRYPT-LUKS2-fedcba-home\n",
				"/sys/class/block/nvme0n1p9/dev": "259:9\n",
				"/sys/class/block/md0/dev":       "9:0\n",
				"/sys/class/block/sda1/dev":      "8:1\n",
				"/sys/class/block/dm-5/dm/uuid":  "CRYPT-LUKS1-aaaa-x\n",
			}, map[string][]string{
				"/sys/dev/block/253:1/slaves":  {"dm-0"},
				"/sys/class/block/dm-0/slaves": {"nvme0n1p3"},
			}
	}
	t.Run("lvm on luks", func(t *testing.T) {
		f, d := lvmOnLUKS()
		if it := linuxDisk(fixtureEnv(nil, f, d)); it.Status != postureOK {
			t.Errorf("%+v", it)
		}
	})
	t.Run("plain partition", func(t *testing.T) {
		f, d := lvmOnLUKS()
		f["/proc/self/mountinfo"] = "22 1 259:5 / / rw - ext4 /dev/nvme0n1p5 rw\n"
		if it := linuxDisk(fixtureEnv(nil, f, d)); it.Status != postureFail || it.Fix == "" {
			t.Errorf("%+v", it)
		}
	})
	t.Run("lvm on a plain partition", func(t *testing.T) {
		f, d := lvmOnLUKS()
		d["/sys/dev/block/253:1/slaves"] = []string{"nvme0n1p9"}
		if it := linuxDisk(fixtureEnv(nil, f, d)); it.Status != postureFail {
			t.Errorf("%+v", it)
		}
	})
	t.Run("one mirror half unencrypted", func(t *testing.T) {
		f, d := lvmOnLUKS()
		d["/sys/dev/block/253:1/slaves"] = []string{"dm-5", "sda1"}
		if it := linuxDisk(fixtureEnv(nil, f, d)); it.Status != postureFail {
			t.Errorf("%+v", it)
		}
	})
	t.Run("encrypted root, plain home", func(t *testing.T) {
		f, d := lvmOnLUKS()
		f["/proc/self/mountinfo"] = fxMountLUKS + "31 22 8:2 / /home rw - ext4 /dev/sda2 rw\n"
		if it := linuxDisk(fixtureEnv(nil, f, d)); it.Status != postureFail {
			t.Errorf("%+v", it)
		}
	})
	t.Run("encrypted root and home", func(t *testing.T) {
		f, d := lvmOnLUKS()
		f["/proc/self/mountinfo"] = fxMountLUKS + "31 22 253:7 / /home rw - ext4 /dev/mapper/home rw\n"
		if it := linuxDisk(fixtureEnv(nil, f, d)); it.Status != postureOK {
			t.Errorf("%+v", it)
		}
	})
	for name, mi := range map[string]string{
		"container overlay": "500 400 0:55 / / rw,relatime - overlay overlay rw,lowerdir=/x\n",
		"btrfs":             "22 1 0:27 /root / rw - btrfs /dev/mapper/luks-x rw\n",
		"no root line":      "30 22 259:2 / /boot rw - ext4 /dev/nvme0n1p2 rw\n",
		"device not in sys": "22 1 254:9 / / rw - ext4 /dev/vda1 rw\n",
		"garbage":           "not a mountinfo file",
	} {
		t.Run(name, func(t *testing.T) {
			f, d := lvmOnLUKS()
			f["/proc/self/mountinfo"] = mi
			if it := linuxDisk(fixtureEnv(nil, f, d)); it.Status != postureUnknown {
				t.Errorf("%+v", it)
			}
		})
	}
	if it := linuxDisk(fixtureEnv(nil, nil, nil)); it.Status != postureUnknown {
		t.Errorf("no /proc: %+v", it)
	}
	// The detail never repeats a device name or UUID.
	f, d := lvmOnLUKS()
	if it := linuxDisk(fixtureEnv(nil, f, d)); strings.Contains(it.Detail+it.Fix, "SECRET") || strings.Contains(it.Detail, "nvme") {
		t.Errorf("leaks: %+v", it)
	}
}

func TestPostureLinuxFirewallUpdatesSecureBoot(t *testing.T) {
	sys := func(kv ...string) map[string]string {
		m := map[string]string{}
		for i := 0; i < len(kv); i += 2 {
			m["/usr/bin/systemctl "+kv[i]] = kv[i+1]
		}
		return m
	}
	fw := []struct {
		name  string
		cmds  map[string]string
		files map[string]string
		want  string
	}{
		{"ufw on", nil, map[string]string{"/etc/ufw/ufw.conf": "# comment\nENABLED=yes\nLOGLEVEL=low\n"}, postureOK},
		{"ufw off, nothing else", sys("is-active firewalld", "inactive\n", "is-active nftables", "inactive\n"), map[string]string{"/etc/ufw/ufw.conf": "ENABLED=no\n"}, postureFail},
		{"ufw off, firewalld on", sys("is-active firewalld", "active\n"), map[string]string{"/etc/ufw/ufw.conf": "ENABLED=no\n"}, postureOK},
		{"nftables service on", sys("is-active firewalld", "inactive\n", "is-active nftables", "active\n"), nil, postureOK},
		{"ufw off, systemd silent", nil, map[string]string{"/etc/ufw/ufw.conf": "ENABLED=no\n"}, postureUnknown},
		{"no ufw, services inactive", sys("is-active firewalld", "inactive\n", "is-active nftables", "inactive\n"), nil, postureUnknown},
		{"commented out", nil, map[string]string{"/etc/ufw/ufw.conf": "#ENABLED=yes\n"}, postureUnknown},
	}
	for _, c := range fw {
		if it := linuxFirewall(context.Background(), fixtureEnv(c.cmds, c.files, nil)); it.Status != c.want {
			t.Errorf("firewall %s: %s (%s), want %s", c.name, it.Status, it.Detail, c.want)
		}
	}
	const apt = "/etc/apt/apt.conf.d/20auto-upgrades"
	const dnf = "/etc/dnf/automatic.conf"
	up := []struct {
		name  string
		cmds  map[string]string
		files map[string]string
		want  string
	}{
		{"apt on", nil, map[string]string{apt: "APT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Unattended-Upgrade \"1\";\n"}, postureOK},
		{"apt off", nil, map[string]string{apt: "APT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Unattended-Upgrade \"0\";\n"}, postureFail},
		{"apt commented", nil, map[string]string{apt: "APT::Periodic::Update-Package-Lists \"1\";\n// APT::Periodic::Unattended-Upgrade \"1\";\n"}, postureFail},
		{"dnf on", sys("is-enabled dnf-automatic.timer", "enabled\n"), map[string]string{dnf: "[commands]\napply_updates = yes\n"}, postureOK},
		{"dnf download only", sys("is-enabled dnf-automatic.timer", "enabled\n"), map[string]string{dnf: "[commands]\napply_updates = no\n"}, postureWarn},
		{"dnf timer off", sys("is-enabled dnf-automatic.timer", "disabled\n"), map[string]string{dnf: "[commands]\napply_updates = yes\n"}, postureFail},
		{"dnf timer unreadable", nil, map[string]string{dnf: "[commands]\napply_updates = yes\n"}, postureUnknown},
		{"neither tool", nil, nil, postureUnknown},
	}
	for _, c := range up {
		if it := linuxUpdates(context.Background(), fixtureEnv(c.cmds, c.files, nil)); it.Status != c.want {
			t.Errorf("updates %s: %s (%s), want %s", c.name, it.Status, it.Detail, c.want)
		}
	}
	sb := []struct {
		name, val, want string
	}{
		{"on", "\x06\x00\x00\x00\x01", postureOK},
		{"off", "\x06\x00\x00\x00\x00", postureWarn},
		{"short read", "\x06\x00", postureUnknown},
	}
	for _, c := range sb {
		if it := linuxIntegrity(fixtureEnv(nil, map[string]string{linuxSecureBootVar: c.val}, nil)); it.Status != c.want {
			t.Errorf("secure boot %s: %s, want %s", c.name, it.Status, c.want)
		}
	}
	if it := linuxIntegrity(fixtureEnv(nil, nil, nil)); it.Status != postureUnknown {
		t.Errorf("no efivars: %+v", it)
	}
}

func TestPostureWorst(t *testing.T) {
	for _, c := range []struct {
		in   []string
		want string
	}{
		{[]string{postureOK, postureOK}, postureOK},
		{[]string{postureOK, postureWarn}, postureWarn},
		{[]string{postureWarn, postureUnknown}, postureUnknown},
		{[]string{postureUnknown, postureFail, postureOK}, postureFail},
	} {
		if got := worst(c.in...); got != c.want {
			t.Errorf("worst(%v) = %s", c.in, got)
		}
	}
}

func TestPostureCacheIsPrivateAndReportIsCompact(t *testing.T) {
	s := Store{Dir: filepath.Join(t.TempDir(), "state")}
	p := runPosture(context.Background(), "darwin", fixtureEnv(macOK(), nil, nil))
	if err := s.savePosture(postureCache{Posture: p}); err != nil {
		t.Fatal(err)
	}
	fi, err := os.Stat(s.path("posture.json"))
	if err != nil || fi.Mode().Perm() != 0o600 {
		t.Fatalf("posture.json: %v %v", fi, err)
	}
	if di, _ := os.Stat(s.Dir); di.Mode().Perm() != 0o700 {
		t.Errorf("state dir mode %v", di.Mode().Perm())
	}

	report := map[string]any{}
	sent := addPosture(report, s, postNow.Add(time.Minute))
	b, _ := json.Marshal(report["posture"])
	want := `{"at":"2026-11-10T12:00:00Z","items":{"argo":"unknown","disk":"ok","firewall":"ok","integrity":"ok","sharing":"ok","tailkey":"ok","updates":"ok"}}`
	if string(b) != want {
		t.Fatalf("compact block:\n got %s\nwant %s", b, want)
	}

	// Not acknowledged (Gauss down): it is offered again.
	report = map[string]any{}
	addPosture(report, s, postNow.Add(2*time.Minute))
	if report["posture"] == nil {
		t.Fatal("an unsent block was not offered again")
	}
	sent()
	// Acknowledged: nothing for the next hour, then again.
	for _, m := range []int{3, 30, 59} {
		report = map[string]any{}
		addPosture(report, s, postNow.Add(time.Duration(m)*time.Minute))
		if report["posture"] != nil {
			t.Errorf("sent again after %d min", m)
		}
	}
	report = map[string]any{}
	addPosture(report, s, postNow.Add(62*time.Minute))
	if report["posture"] == nil {
		t.Error("not sent again after an hour")
	}
	// A changed result goes out straight away.
	c := s.loadPosture()
	c.Items[1].Status = postureFail
	_ = s.savePosture(c)
	report = map[string]any{}
	addPosture(report, s, postNow.Add(5*time.Minute))
	if report["posture"] == nil {
		t.Error("a change waited for the hour")
	}
	// A result too old to stand for the device is not sent at all.
	report = map[string]any{}
	addPosture(report, s, postNow.Add(postureMaxAge+time.Minute))
	if report["posture"] != nil {
		t.Error("a stale result was sent")
	}
	report = map[string]any{}
	addPosture(report, Store{Dir: t.TempDir()}, postNow)
	if report["posture"] != nil {
		t.Error("sent with nothing checked")
	}
}

func TestReportCarriesPostureAboutHourly(t *testing.T) {
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		bodies = append(bodies, string(b))
	}))
	defer srv.Close()
	t.Setenv("HOME", t.TempDir())
	_ = os.MkdirAll(configDir(), 0o700)
	_ = os.WriteFile(filepath.Join(configDir(), "token"), []byte("argo_test\n"), 0o600)
	e := fixtureEnv(macOK(), nil, nil)
	e.now = time.Now()
	e.dial = func(addr string) bool { return strings.HasSuffix(addr, ":22") }
	if err := DefaultStore().savePosture(postureCache{Posture: runPosture(context.Background(), "darwin", e)}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if code, err := sendReport(Config{GaussURL: srv.URL, Device: "judith"}, State{Class: "OK"}); err != nil || code != 200 {
			t.Fatalf("send: %d %v", code, err)
		}
	}
	if len(bodies) != 2 {
		t.Fatalf("%d reports", len(bodies))
	}
	for _, want := range []string{`"posture":{"at":"`, `"sharing":"warn"`, `"disk":"ok"`, `"argo":"unknown"`} {
		if !strings.Contains(bodies[0], want) {
			t.Errorf("first report lacks %s: %s", want, bodies[0])
		}
	}
	for _, never := range []string{"Remote Login", "FileVault", `"fix"`, `"detail"`, "SECRET", "192.168.7.20"} {
		if strings.Contains(bodies[0], never) {
			t.Errorf("report carries %q: %s", never, bodies[0])
		}
	}
	if strings.Contains(bodies[1], `"posture"`) {
		t.Errorf("posture sent twice within the hour: %s", bodies[1])
	}
}

func TestPostureCmdRejectsUnknownFlags(t *testing.T) {
	if err := postureCmd(context.Background(), []string{"--fix"}, Store{Dir: t.TempDir()}, io.Discard); err == nil {
		t.Error("an unknown flag was accepted (posture is read-only and takes only --json)")
	}
}
