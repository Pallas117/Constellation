# Device security baseline

**Status: DRAFT, for Josh's approval (GAU-238, written 2026-11-10). Nothing here is a requirement until approved.**

This is what every device enrolled with Gauss is checked against. `argo posture` runs the checks on the device and
the result (one status per item, nothing else) shows on `/mesh`. It is a minimum for a small team's laptops and
hosts, not a claim about any standard.

## Rules of the check

- **Read-only.** Argo reads settings. It never changes one, never asks for admin rights and never runs a Tailscale
  command that changes anything. Fixing is a person's job; each finding comes with a one-line hint.
- **Unknown is never ok.** A check that cannot be read (tool missing, no permission, time-out after 5 s, unexpected
  output) is `unknown`.
- **No identifiers.** Output and the report carry statuses and fixed sentences only: no serial numbers, MAC or IP
  addresses, host or user names. Gauss stores `item → status` and the check time; the backend drops everything else
  (`parsePosture` in `backend/mesh/store.ts`).
- **Statuses:** `ok` meets the baseline · `warn` works but needs attention soon · `fail` does not meet the baseline ·
  `unknown` could not be read.

## The baseline

| Item (id) | Why | macOS check | Linux check | ok / warn / fail |
|---|---|---|---|---|
| Disk encryption (`disk`) | A lost or stolen device must not give up source, tokens or keys. | `/usr/bin/fdesetup status` [1] | The devices under `/` and `/home` (from `/proc/self/mountinfo` [8]) are followed through sysfs (`/sys/dev/block/<maj:min>/dm/uuid`, `slaves/`); a device-mapper UUID starting `CRYPT-` is a dm-crypt/LUKS volume [9]. No tool is run. | **ok** FileVault on / every layer under `/` and `/home` reaches a LUKS volume. **warn** encryption or decryption still in progress (macOS). **fail** FileVault off / a plain disk or partition under `/` or `/home`. **unknown** containers, btrfs, network roots. |
| Host firewall (`firewall`) | Shared Wi-Fi (hostels, cafés, events) puts strangers on the same network. | `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate` [2] | `ENABLED=yes` in `/etc/ufw/ufw.conf` [10], or `systemctl is-active firewalld` / `nftables` [11] | **ok** on. **fail** off (Linux: ufw says off and neither service is active). **unknown** Linux with no firewall service found: rules loaded by hand can only be listed as root, which Argo never asks for. |
| Automatic security updates (`updates`) | Most compromises use flaws that already have a fix. | `/usr/bin/defaults read /Library/Preferences/com.apple.SoftwareUpdate` [3]: `CriticalUpdateInstall`, `AutomaticCheckEnabled`, `AutomaticallyInstallMacOSUpdates` | `/etc/apt/apt.conf.d/20auto-upgrades` (`Update-Package-Lists` and `Unattended-Upgrade` both on) [12], or `/etc/dnf/automatic.conf` `apply_updates = yes` with `dnf-automatic.timer` enabled [13] | **ok** security updates install by themselves. **warn** macOS: security responses on, full macOS updates manual; dnf: download only. **fail** turned off. **unknown** keys or tool absent. |
| System integrity (`integrity`) | Stops malware changing the system or running unsigned code unnoticed. | `/usr/bin/csrutil status` (SIP) [4] and `/usr/sbin/spctl --status` (Gatekeeper) [5] | UEFI `SecureBoot` variable in efivarfs (5 bytes; the last is 1 when on) [14] | **ok** SIP and Gatekeeper on / Secure Boot on. **warn** SIP partly on (custom configuration) / Secure Boot off. **fail** SIP or Gatekeeper off. **unknown** no UEFI, virtual machine, container. |
| Tailnet key expiry (`tailkey`) | An expired key drops the device off the tailnet (and off Gauss) until someone signs in again; a signed-out device is not protected by tailnet rules. | `tailscale status --json` (read-only): `BackendState` and `Self.KeyExpiry` only [6] | same | **ok** 14 days or more left, or expiry is turned off for the device. **warn** under 14 days. **fail** expired or signed out. **unknown** Tailscale stopped or not answering. |
| Argo up to date (`argo`) | Argo holds the device token and relay keys; fixes must reach every device. | The last signature-verified `argo update check` (docs/ARGO_UPDATE.md), at most 3 days old | same | **ok** running the newest signed release. **warn** a newer signed release exists. **unknown** no release key pinned yet, or no recent verified check. Never `fail` in this draft. |
| Sharing services (`sharing`) | Remote Login, File Sharing, Screen Sharing and similar should be reachable over the tailnet only, not from whatever network the device is on. | Argo connects to its own address on the current network on ports 22, 445, 548, 3283, 5900, 7000 (the existing Wi-Fi check, `tools/argo/wifi.go`) [7] | same ports, same test | **ok** none answers. **warn** one or more answers (named in the output). **unknown** not on a network. |

`unknown` today on every device: `argo`, because no release key is pinned yet (see docs/ARGO_UPDATE.md).

### Devices that cannot run Argo

iPhones and iPads cannot run Argo, so none of the items above is checked on them. They are covered only by what the
tailnet shows: whether the device is on the tailnet and when it was last seen (`argo devices`), plus whatever policy
is set in the Tailscale admin console. Passcode, OS version and encryption state on iOS are **not checked by
anything in this repository**. Android is the same.

## Sources and what was verified

Verified on one Mac (macOS 27.0.1, Apple silicon, 2026-11-10) means: the command ran without admin rights and printed
the "on" wording the check matches. The "off" wordings and every Linux check were **not** run for this change.

| # | Source | Verified here |
|---|---|---|
| 1 | `fdesetup(8)` man page: "The status command will indicate if FileVault is On or Off" | "FileVault is On." seen. "FileVault is Off." and the in-progress lines: UNVERIFIED |
| 2 | `socketfilterfw -h`: "--getglobalstate display if the firewall is enabled or not" | "Firewall is enabled. (State = 1)" seen. Disabled wording and State = 2: UNVERIFIED |
| 3 | `defaults(1)`; key names from Apple's Software Update device-management payload (com.apple.SoftwareUpdate) | Keys `CriticalUpdateInstall`, `AutomaticallyInstallMacOSUpdates`, `ConfigDataInstall`, `AutomaticDownload` = 1 seen. `AutomaticCheckEnabled` is absent on this Mac (treated as on unless it is 0). That the keys still govern behaviour on macOS 27: UNVERIFIED |
| 4 | `csrutil(8)` man page | "System Integrity Protection status: enabled." seen. Disabled / custom wording: UNVERIFIED |
| 5 | `spctl(8)` man page, `--status` | "assessments enabled" seen. "assessments disabled": UNVERIFIED |
| 6 | Tailscale CLI, `tailscale status --json` (`Self.KeyExpiry`, `BackendState`) | Both fields present on this Mac. A missing `KeyExpiry` meaning "expiry disabled": UNVERIFIED |
| 7 | `tools/argo/wifi.go` (`sharingPorts`, `exposedServices`), in use since 2026-10-19 | Ran here |
| 8 | `proc_pid_mountinfo(5)` (Linux man-pages) | UNVERIFIED (no Linux host used) |
| 9 | cryptsetup/libcryptsetup set device-mapper UUIDs of the form `CRYPT-<type>-<uuid>-<name>` | UNVERIFIED |
| 10 | `ufw-framework(8)`: `/etc/ufw/ufw.conf`, `ENABLED` | UNVERIFIED, including that the file is readable without root on every distribution |
| 11 | `systemctl(1)`: `is-active`, `is-enabled` | UNVERIFIED |
| 12 | Debian wiki "UnattendedUpgrades": `APT::Periodic::Update-Package-Lists "1"; APT::Periodic::Unattended-Upgrade "1";` | UNVERIFIED |
| 13 | dnf-automatic documentation: `[commands] apply_updates`, `dnf-automatic.timer` (dnf5 uses a different file: not covered) | UNVERIFIED |
| 14 | UEFI Specification, Globally Defined Variables (`SecureBoot`, GUID 8be4df61-93ca-11d2-aa0d-00e098032b8c); Linux kernel `Documentation/filesystems/efivarfs.rst` (4 attribute bytes precede the value) | UNVERIFIED |

Tests for every row use fixtures (`tools/argo/posture_test.go`); the macOS "on" fixtures are this Mac's real output.

## Known limits

- The firewall check says the firewall is on, not that its rules are good. macOS lets signed system services through
  its firewall, which is why sharing services are a separate item.
- Linux disk encryption looks at `/` and `/home` only. Self-encrypting drives and encrypted cloud volumes show as
  `fail`.
- The sharing test is made from the device itself, on the network it is on at that moment.
- A device owner with admin rights can make Argo report anything. This baseline finds mistakes and drift; it is not
  tamper-proof attestation.
- Posture reaches Gauss about hourly and is dropped when older than 3 hours, so `/mesh` shows no security line for a
  device that has been off.

## Decisions for Josh

1. Approve, change or drop each item and its thresholds (14 days for the tailnet key).
2. Should a tailnet key with expiry turned off be `ok` (as drafted: it cannot lapse) or `warn` (it never forces a
   new sign-in)?
3. Should open sharing services be `warn` (as drafted, matching today's Wi-Fi advice) or `fail`?
4. Should Secure Boot off on Linux be `warn` (as drafted) or `fail`?
5. What happens on `fail`: only shown on `/mesh` (as built), a phone text, or the device loses mesh work until fixed?
   Nothing is enforced today.
6. iOS and Android: accept "tailnet state only", or require a device-management profile later?
