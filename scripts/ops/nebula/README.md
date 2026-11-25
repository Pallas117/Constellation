# Nebula mesh: our own overlay, with our own certificate authority (Phase 1)

Status: **kit only, not yet run anywhere** (25 Nov 2026). Everything here was tested on macOS against stubs
(`nebula-kit.test.sh`, `../vps/vps-kit.test.sh`) and Go fixtures (`tools/argo/nebula_test.go`). No Nebula
binary, Keychain item, key or certificate has been made by this work.

Why: the team's Tailscale tailnet sits on a custom domain, which Tailscale treats as business use (a 14-day
business trial, then a paid plan). Nebula ([slackhq/nebula](https://github.com/slackhq/nebula), MIT, v1.12.0,
Homebrew formula `nebula` 1.12.0) needs no third-party login at all: each device holds a certificate signed by
**our** CA, and the CA key stays on the CA Mac. Design notes: "Mesh network after the Tailscale bill wall"
(25 Nov) and "Argo self-recovery" (24 Nov), in the Claude outputs folder.

| File | What it is |
|---|---|
| `ca.sh` | Makes the CA once (`nebula-cert ca`, Ed25519); the key goes straight into the Keychain |
| `sign.sh` | Signs one device's public key (30 days by default) |
| `fetch.sh` | Downloads the pinned Linux release and checks its SHA-256 |
| `node-setup.sh` | **Prints** the commands for the Mac (`darwin`) or Talos (`linux`); runs nothing |
| `config/lighthouse.yml` | The VPS: lighthouse + relay on UDP 4242 |
| `config/node-talos.yml`, `config/node-mac.yml` | The laptops |
| `service/nebula.service`, `service/uk.lightbound.nebula.plist` | systemd (VPS, Talos) and LaunchDaemon (Mac) |
| `THREAT-MODEL.md` | DRAFT for Phase 2 (`argo net enroll`/renew over Argo bundles) |
| `../vps/bootstrap.sh --mesh nebula\|both` | Stands the lighthouse up on the VPS |
| `argo net status` | Is Nebula up, overlay address, certificate days left; `argo doctor` warns under 7 days |

## Design choices

**Overlay addresses: 10.117.0.0/24.** Tailscale uses 100.64.0.0/10 (CGNAT space), and both meshes run side by
side during the move, so the overlay can't sit there. The /24 also avoids the common defaults: 10.0.x (cloud
VPCs), 10.8 (OpenVPN), 10.32-10.47 (Weave), 10.42/10.43 (k3s), 10.96 (Kubernetes services), 10.128.0.0/9 (GCP
auto networks), 10.244 (flannel), 172.16.0.0/12 (Docker, and the iPhone hotspot's 172.20.10.0/28) and
192.168.0.0/16 (home routers). A /24 route is more specific than any /8 or /16 a hostel LAN hands out, so the
overlay wins unless a LAN uses exactly 10.117.0.0/24 (then pick another /24 before making the CA: it is baked
into the CA certificate).

| Addresses | For | Group |
|---|---|---|
| 10.117.0.1 (.1-.9) | lighthouses (the VPS) | `hub` |
| 10.117.0.10-.49 | servers, gate runners (Talos .10) | `gate` |
| 10.117.0.50-.99 | laptops (the CA Mac .50) | `dev` |
| 10.117.0.100-.149 | phones | `phone` |

**Groups** (the firewall rules match on them): `hub`, `gate`, `dev`, `phone`. The CA itself is limited to these
four groups and to 10.117.0.0/24, so even a misused CA key can't mint a certificate for another range or group.
Adding a group later means a new CA (a deliberate trade). In Nebula's firewall a `groups:` list means *all* of
them, so "gate or dev" is written as two rules (the test checks this).

| Machine | Accepts inbound over Nebula |
|---|---|
| VPS (lighthouse) | ICMP; TCP 22 from `dev` |
| Talos | ICMP; TCP 22 from `gate` or `dev` |
| CA Mac | ICMP only |
| Phone (Mobile Nebula) | set in the app: nothing |

Outbound is open everywhere. Nebula's firewall is deny-by-default; there are no deny rules.

**Certificate lifetime: 30 days** (`sign.sh` default 720h, at most 90 days). Short lives make a stolen
certificate age out by itself; Argo warns 7 days before the end (`argo net status`, `argo doctor`). Until
Phase 2 automates renewal, renewing is one `sign.sh` run per device per month. The CA lives two years.

**Certificate format v2** (nebula-cert 1.12's default). Every node needs Nebula 1.10 or newer (UNVERIFIED: the
release where v2 arrived; check `nebula -version` on each machine). Mobile Nebula's source builds against nebula
v1.12.0 (its go.mod, 25 Nov), so the phone should read v2; the App Store build is UNVERIFIED. If it can't,
`sign.sh ... --cert-version 1` issues a v1 certificate for it.

## Security model

- **The CA key is in the CA Mac's login Keychain only.** `ca.sh` pipes it from `nebula-cert ca -out-key -` into
  `security -i` (the command arrives on stdin, so the key is never on a command line), and `sign.sh` pipes it back
  out into `nebula-cert sign -ca-key -`. It never touches a file. The item trusts no application, so every use
  shows a dialog at the Mac: click **Allow**, never **Always Allow**. Back it up only to an offline, encrypted
  place you control (e.g. an encrypted USB stick in a drawer); without a backup, losing the Mac means a new CA
  and re-signing every device, which is survivable.
- **Device keys never leave their device.** Each machine runs `nebula-cert keygen` itself; only the `.pub` travels.
  `sign.sh` refuses a file that holds a private key and says that key must be replaced.
- **The lighthouse never sees plaintext.** It answers "where is X" and relays packets that are encrypted end to
  end between the two devices (Noise, per Nebula's design). It holds no CA key. It can see who talks to whom and
  how much (metadata), like Tailscale's DERP relays.
- **Revocation:** add the certificate's fingerprint (`nebula-cert print -path <crt>`; also in `issued.tsv`) to
  `pki.blocklist` on every node, then `sudo systemctl reload nebula` / restart the LaunchDaemon. With 30-day
  certificates, a stolen device stops working within a month even if a node misses the list. Phase 2 lets Argo
  bundles carry the blocklist (THREAT-MODEL.md).
- **Root runs only root-owned binaries.** On the Mac the LaunchDaemon runs a copy in
  `/usr/local/libexec/lightbound/`, not Homebrew's `/opt/homebrew/bin` (writable by your user, so anything
  running as you could swap it). After `brew upgrade nebula`, copy it again (the `install` line from
  `node-setup.sh darwin`). On Linux, Nebula runs as user `nebula` with only `CAP_NET_ADMIN`.
- **Downloads are pinned.** `fetch.sh` checks the release tarball against SHA-256 sums copied from the release's
  `SHASUM256.txt`; it guards against a changed file after 25 Nov, not against a bad release on that day.
- Nothing here runs sudo, changes Tailscale, or touches a key on its own. Argo only reads (`argo net status`).

## Migration runbook (Tailscale keeps running until the end)

Order: VPS lighthouse, then Talos, then the Mac, then the phone. At every step Tailscale stays up, so a mistake
costs nothing: you still reach every machine the old way.

0. **On the CA Mac, once:** `brew install nebula`, then `bash scripts/ops/nebula/ca.sh`. Note the fingerprint.
1. **VPS** (needs a public host; Josh picks Oracle Always Free or Hetzner):
   - Provider firewall: allow inbound **UDP 4242** only (plus TCP 22 for the first login; remove it later).
   - `sudo bash scripts/ops/vps/bootstrap.sh --mesh both` (keeps the Tailscale path too). It installs the pinned
     Nebula, makes the key pair there and prints the public key, then stops short of starting Nebula.
   - On the Mac: `bash scripts/ops/nebula/sign.sh hub 10.117.0.1 hub --pub hub.pub`, copy `hub.crt` and `ca.crt`
     back to `/etc/nebula/host.crt` and `/etc/nebula/ca.crt`, run the bootstrap again: Nebula starts, ufw opens UDP 4242.
2. **Talos:** `bash scripts/ops/nebula/node-setup.sh linux --lighthouse <lighthouse-public-ip>` and follow it
   (sign as `talos 10.117.0.10 gate`).
3. **The Mac:** `bash scripts/ops/nebula/node-setup.sh darwin --lighthouse <lighthouse-public-ip>` (sign as
   `mac 10.117.0.50 dev`).
4. **Verify the nebula paths** before going further, from the Mac: `ping 10.117.0.1`, `ping 10.117.0.10`,
   `ssh <user>@10.117.0.10` (Talos), `ssh <user>@10.117.0.1` (VPS), and `argo net status` on each machine. Test
   once on a hostel or cafe network, where hole punching often fails and the relay should carry it.
5. **Phone:** install Mobile Nebula (App Store; UNVERIFIED version), create a site, copy its public key to the Mac,
   `sign.sh phone1 10.117.0.100 phone --pub phone1.pub`, paste the certificate and `ca.crt` into the app, add the
   lighthouse `10.117.0.1` → `<lighthouse-public-ip>:4242`.
6. **Retire Tailscale** only after a week of both paths working, and before the trial ends. With `--mesh nebula`
   the VPS keeps the hub on 127.0.0.1; reach it with `ssh -L 3001:127.0.0.1:3001 <user>@10.117.0.1`.

**Rollback** at any step: stop Nebula on that machine (`sudo systemctl disable --now nebula`, or
`sudo launchctl bootout system/uk.lightbound.nebula`). Tailscale was never touched. On the VPS, `ufw delete allow
4242/udp` and remove the provider's UDP rule.

**Renewing** (monthly until Phase 2): run the same `sign.sh` line again on the Mac (same device, same address,
same public key), copy the new `.crt` to `/etc/nebula/host.crt`, and reload Nebula. `argo net status` shows the new date.

**Rotating the CA** (before its two years end, or if the key may be exposed): make a new CA under a new Keychain
service, put **both** CA certificates in every node's `ca.crt` for the changeover, re-sign every device with
the new CA, then drop the old CA certificate. `ca.sh` refuses to overwrite the current one on purpose.

## UNVERIFIED (nothing here has met a real machine)

- Every command against real Nebula 1.12 (flags and the `-` stdio paths were read from the v1.12.0 source, not run).
- `security -i` with a quoted `-w` argument and `-T ""` on macOS 27 (read from Apple's open-source
  `security` tool: it splits stdin lines with quote handling; not run, because the task forbade touching the Keychain).
- The configs under `nebula -test`; the systemd unit's hardening with the tun device; the LaunchDaemon on macOS 27.
- Hole punching and relay behaviour on the phone hotspot and hostel networks; the MTU (1300, Nebula's default).
- Mobile Nebula's App Store version and its v2 certificate support.
- Which Nebula release first read v2 certificates (believed 1.10).
