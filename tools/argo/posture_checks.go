package main

import (
	"context"
	"regexp"
	"strings"
)

// The per-OS baseline checks. They live in one untagged file, behind
// postureEnv, so the Linux checks are tested on a Mac and the reverse.
// Sources for each command are in docs/DEVICE_SECURITY_BASELINE.md.

// ----- macOS -----

const (
	macFdesetup     = "/usr/bin/fdesetup"
	macFirewallTool = "/usr/libexec/ApplicationFirewall/socketfilterfw"
	macDefaults     = "/usr/bin/defaults"
	macCsrutil      = "/usr/bin/csrutil"
	macSpctl        = "/usr/sbin/spctl"
)

func macDisk(ctx context.Context, e postureEnv) PostureItem {
	const id = "disk"
	fix := "Turn on FileVault in System Settings > Privacy & Security > FileVault"
	out, _ := e.run(ctx, macFdesetup, "status")
	switch {
	case strings.Contains(out, "FileVault is Off"):
		return item(id, postureFail, "FileVault is off: the disk can be read if the Mac is lost", fix)
	case strings.Contains(out, "in progress"):
		return item(id, postureWarn, "FileVault is still encrypting or decrypting", "Keep the Mac on power until it finishes, then run `argo posture` again")
	case strings.Contains(out, "FileVault is On"):
		return item(id, postureOK, "FileVault is on", "")
	}
	return item(id, postureUnknown, "FileVault's state could not be read", "Check System Settings > Privacy & Security > FileVault")
}

func macFirewall(ctx context.Context, e postureEnv) PostureItem {
	const id = "firewall"
	out, _ := e.run(ctx, macFirewallTool, "--getglobalstate")
	switch {
	case strings.Contains(out, "State = 0") || strings.Contains(out, "Firewall is disabled"):
		return item(id, postureFail, "The macOS firewall is off", "Turn it on in System Settings > Network > Firewall")
	case strings.Contains(out, "Firewall is enabled") || strings.Contains(out, "State = 1") || strings.Contains(out, "State = 2"):
		return item(id, postureOK, "The macOS firewall is on", "")
	}
	return item(id, postureUnknown, "The firewall's state could not be read", "Check System Settings > Network > Firewall")
}

var reDefaultsKV = regexp.MustCompile(`(?m)^\s*"?([A-Za-z]+)"?\s*=\s*"?([A-Za-z0-9]+)"?;`)

// defaultsFlags reads the 0/1 keys from `defaults read <domain>` output.
func defaultsFlags(out string) map[string]bool {
	m := map[string]bool{}
	for _, kv := range reDefaultsKV.FindAllStringSubmatch(out, -1) {
		switch kv[2] {
		case "1", "true", "YES":
			m[kv[1]] = true
		case "0", "false", "NO":
			m[kv[1]] = false
		}
	}
	return m
}

func macUpdates(ctx context.Context, e postureEnv) PostureItem {
	const id = "updates"
	fix := "System Settings > General > Software Update > Automatic Updates: turn on \"Install Security Responses and system files\""
	out, _ := e.run(ctx, macDefaults, "read", "/Library/Preferences/com.apple.SoftwareUpdate")
	f := defaultsFlags(out)
	critical, haveCritical := f["CriticalUpdateInstall"]
	check, haveCheck := f["AutomaticCheckEnabled"]
	osInstall, haveOS := f["AutomaticallyInstallMacOSUpdates"]
	switch {
	case haveCheck && !check:
		return item(id, postureFail, "This Mac does not check for updates by itself", fix)
	case haveCritical && !critical:
		return item(id, postureFail, "Security responses and system files are not installed automatically", fix)
	case !haveCritical:
		return item(id, postureUnknown, "The automatic update settings could not be read", "Check "+fix)
	case haveOS && !osInstall:
		return item(id, postureWarn, "Security responses install by themselves, full macOS updates do not", "Turn on \"Install macOS updates\" in the same place, or install updates when offered")
	}
	return item(id, postureOK, "Security responses and system files install automatically", "")
}

func macIntegrity(ctx context.Context, e postureEnv) PostureItem {
	const id = "integrity"
	sipOut, _ := e.run(ctx, macCsrutil, "status")
	gkOut, _ := e.run(ctx, macSpctl, "--status")
	sip, gk := postureUnknown, postureUnknown
	switch {
	case strings.Contains(sipOut, "status: disabled"):
		sip = postureFail
	case strings.Contains(sipOut, "status: enabled") && !strings.Contains(sipOut, "Custom Configuration"):
		sip = postureOK
	case strings.Contains(sipOut, "System Integrity Protection status:"):
		sip = postureWarn // partly off ("unknown (Custom Configuration)")
	}
	switch {
	case strings.Contains(gkOut, "assessments disabled"):
		gk = postureFail
	case strings.Contains(gkOut, "assessments enabled"):
		gk = postureOK
	}
	switch {
	case sip == postureFail:
		return item(id, postureFail, "System Integrity Protection is off", "Restart into Recovery (hold the power button), open Terminal and run `csrutil enable`")
	case gk == postureFail:
		return item(id, postureFail, "Gatekeeper is off: unsigned apps open without a check", "System Settings > Privacy & Security > Allow applications from: App Store & Known Developers")
	case sip == postureUnknown || gk == postureUnknown:
		return item(id, postureUnknown, "System Integrity Protection or Gatekeeper could not be read", "Run `csrutil status` and `spctl --status` in Terminal")
	case sip == postureWarn:
		return item(id, postureWarn, "System Integrity Protection is only partly on", "Restart into Recovery and run `csrutil enable`")
	}
	return item(id, postureOK, "System Integrity Protection and Gatekeeper are on", "")
}

// ----- Linux -----

// linuxMountDev finds the device (major:minor) and filesystem type mounted at
// mnt in /proc/self/mountinfo.
func linuxMountDev(mountinfo, mnt string) (dev, fstype string, ok bool) {
	for _, line := range strings.Split(mountinfo, "\n") {
		left, right, found := strings.Cut(line, " - ")
		f := strings.Fields(left)
		if !found || len(f) < 5 || f[4] != mnt {
			continue
		}
		if r := strings.Fields(right); len(r) > 0 {
			fstype = r[0]
		}
		dev, ok = f[2], true // the last matching line is the mount on top
	}
	return dev, fstype, ok
}

var reBlockName = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// linuxEncrypted walks a block device and the devices under it (LVM on LUKS,
// RAID) through sysfs. dm-crypt devices made by cryptsetup have a
// device-mapper UUID starting "CRYPT-". Returns ok, fail or unknown.
func linuxEncrypted(e postureEnv, sysPath string, depth int) string {
	if depth > 8 {
		return postureUnknown
	}
	if b, err := e.readFile(sysPath + "/dm/uuid"); err == nil && strings.HasPrefix(string(b), "CRYPT-") {
		return postureOK
	}
	slaves, err := e.readDir(sysPath + "/slaves")
	if err != nil || len(slaves) == 0 {
		if _, serr := e.readFile(sysPath + "/dev"); serr != nil {
			return postureUnknown // not a block device Argo can see
		}
		return postureFail // a plain disk or partition with no encryption layer above it
	}
	out := postureOK
	for _, name := range slaves {
		if !reBlockName.MatchString(name) {
			return postureUnknown
		}
		out = worst(out, linuxEncrypted(e, "/sys/class/block/"+name, depth+1))
	}
	return out
}

func linuxDisk(e postureEnv) PostureItem {
	const id = "disk"
	fix := "Encrypt the system disk with LUKS (most installers offer it at install time); moving an installed system needs a backup and reinstall"
	b, err := e.readFile("/proc/self/mountinfo")
	if err != nil {
		return item(id, postureUnknown, "The mounted filesystems could not be read", "")
	}
	status := ""
	for _, mnt := range []string{"/", "/home"} {
		dev, fstype, ok := linuxMountDev(string(b), mnt)
		if !ok {
			continue
		}
		s := postureUnknown
		if maj, _, _ := strings.Cut(dev, ":"); maj != "0" && fstype != "overlay" && fstype != "tmpfs" {
			s = linuxEncrypted(e, "/sys/dev/block/"+dev, 0)
		}
		if status == "" {
			status = s
		} else {
			status = worst(status, s)
		}
	}
	switch status {
	case postureOK:
		return item(id, postureOK, "The system disk is LUKS-encrypted", "")
	case postureFail:
		return item(id, postureFail, "The system or home filesystem is not on an encrypted disk", fix)
	}
	return item(id, postureUnknown, "Disk encryption could not be read (container, network or unusual filesystem)", "On a container, check the host instead")
}

// linuxSystemctl asks systemd one read-only question ("is-active", "is-enabled").
func linuxSystemctl(ctx context.Context, e postureEnv, verb, unit string) string {
	for _, p := range []string{"/usr/bin/systemctl", "/bin/systemctl"} {
		if out, _ := e.run(ctx, p, verb, unit); strings.TrimSpace(out) != "" {
			return strings.TrimSpace(strings.SplitN(out, "\n", 2)[0])
		}
	}
	return ""
}

func linuxFirewall(ctx context.Context, e postureEnv) PostureItem {
	const id = "firewall"
	fix := "Turn on the host firewall: `sudo ufw enable` (Debian/Ubuntu) or `sudo systemctl enable --now firewalld` (Fedora/RHEL)"
	ufwOff := false
	if b, err := e.readFile("/etc/ufw/ufw.conf"); err == nil {
		switch {
		case regexp.MustCompile(`(?mi)^\s*ENABLED\s*=\s*yes\b`).Match(b):
			return item(id, postureOK, "The host firewall (ufw) is on", "")
		case regexp.MustCompile(`(?mi)^\s*ENABLED\s*=\s*no\b`).Match(b):
			ufwOff = true
		}
	}
	answered := false
	for _, unit := range []string{"firewalld", "nftables"} {
		switch linuxSystemctl(ctx, e, "is-active", unit) {
		case "active":
			return item(id, postureOK, "The host firewall ("+unit+") is on", "")
		case "inactive", "failed", "unknown":
			answered = true
		}
	}
	if ufwOff && answered {
		return item(id, postureFail, "No host firewall is on", fix)
	}
	// Rules loaded by hand (nft, iptables) can only be listed as root, which Argo never asks for.
	return item(id, postureUnknown, "No firewall service was found; rules loaded another way cannot be read without admin rights", "Check with `sudo nft list ruleset`, or: "+fix)
}

func linuxUpdates(ctx context.Context, e postureEnv) PostureItem {
	const id = "updates"
	if b, err := e.readFile("/etc/apt/apt.conf.d/20auto-upgrades"); err == nil {
		fix := "Run `sudo dpkg-reconfigure -plow unattended-upgrades` and answer Yes"
		on := func(key string) bool {
			return regexp.MustCompile(`(?m)^\s*APT::Periodic::` + key + `\s+"[1-9][0-9]*"\s*;`).Match(b)
		}
		if on("Update-Package-Lists") && on("Unattended-Upgrade") {
			return item(id, postureOK, "Unattended upgrades are on", "")
		}
		return item(id, postureFail, "Unattended upgrades are turned off", fix)
	}
	if b, err := e.readFile("/etc/dnf/automatic.conf"); err == nil {
		fix := "Set `apply_updates = yes` in /etc/dnf/automatic.conf and run `sudo systemctl enable --now dnf-automatic.timer`"
		apply := regexp.MustCompile(`(?mi)^\s*apply_updates\s*=\s*(yes|true|1)\b`).Match(b)
		switch timer := linuxSystemctl(ctx, e, "is-enabled", "dnf-automatic.timer"); {
		case apply && timer == "enabled":
			return item(id, postureOK, "Automatic updates (dnf-automatic) are on", "")
		case timer == "":
			return item(id, postureUnknown, "dnf-automatic is set up but its timer could not be read", fix)
		case !apply && timer == "enabled":
			return item(id, postureWarn, "Updates are downloaded automatically but not installed", fix)
		}
		return item(id, postureFail, "Automatic updates are turned off", fix)
	}
	return item(id, postureUnknown, "No automatic update tool was found (unattended-upgrades or dnf-automatic)", "Install and turn on your distribution's automatic security updates")
}

// The UEFI SecureBoot variable (EFI global variable GUID, UEFI specification
// section 3.3): 4 attribute bytes, then 1 = on, 0 = off.
const linuxSecureBootVar = "/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c"

func linuxIntegrity(e postureEnv) PostureItem {
	const id = "integrity"
	b, err := e.readFile(linuxSecureBootVar)
	switch {
	case err != nil || len(b) != 5:
		return item(id, postureUnknown, "Secure Boot state could not be read (no UEFI, a container, or a virtual machine)", "On real hardware, check the firmware setup screen")
	case b[4] == 1:
		return item(id, postureOK, "Secure Boot is on", "")
	}
	return item(id, postureWarn, "Secure Boot is off", "Turn on Secure Boot in the firmware setup screen (check your distribution supports it first)")
}
