# Always-on VPS: Gauss hub + Argo relay peer (tailnet only)

Status: **kit only, not yet run anywhere.** Josh creates the account and the VM, then runs one command. Nothing
here creates an account, a token or a webhook, and no secret is in this folder (the Tailscale key is pasted at run
time). Plan source: Linear GAU-223 ("Gates + always-on hub"); design of the relay: [`docs/ARGO_DTN.md`](../../../docs/ARGO_DTN.md).

What you get: the Gauss backend on `127.0.0.1:3001` (put on the tailnet by `tailscale serve`, HTTPS), plus Argo as
device `vps`, a store-and-forward peer. The laptop (a Mac) sends it files; the hub keeps ciphertext while either end is away.
This is the one place a drop-out is survivable even when the Mac's own hub is asleep.

## 1. Is there a free VM? (Oracle Cloud Always Free, checked 18 Nov 2026)

| Item | What Oracle says | Source |
|---|---|---|
| Arm (Ampere A1) compute | first 1,500 OCPU-hours and 9,000 GB-hours a month free; "for Always Free tenancies, this is equivalent to 2 OCPUs and 12 GB of memory" (one VM, or two of 1 OCPU) | [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) |
| Storage | 200 GB total of boot + block volume, five backups | same page |
| Outbound data | 10 TB a month | same page |
| Idle reclamation | an instance is "idle" if, over 7 days, CPU 95th percentile < 20%, network < 20% **and** memory < 20% (A1); "idle Always Free compute instances may be reclaimed" | same page |
| Account | "most users need a mobile phone number and a credit card to create an account. Your credit card will not be charged unless you upgrade your account"; the 30-day / $300 trial ends and the account stays active with Always Free resources | [Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm) |
| Region | Always Free compute only in your **home region**: choose it carefully at sign-up | Free Tier page |

Honest reading, for Josh's rule "Always Free with no card charges, or not at all":

- **It fits the size** (the hub + Argo need well under 2 GB RAM). Never go above 2 OCPUs / 12 GB total A1 in the tenancy: over the limit, instances are disabled and deleted after 30 days (Free Tier page).
- **A card is needed for sign-up** (verification, not charged unless you upgrade). If you will not enter a card, stop here: this option is closed. Do not click "Upgrade to Pay As You Go".
- **Idle reclamation is a real risk for this workload.** A hub that mostly waits will sit below 20% on all three measures, which is the definition of idle. Oracle says reclaimed "may"; it gives no grace period (UNVERIFIED beyond that page). Plan for losing the VM: the hub holds only ciphertext and Argo senders keep every bundle until a signed receipt arrives, so a lost VM delays files, it does not lose them. Rebuild takes one run of `bootstrap.sh`.
- **A1 capacity ("out of capacity" when creating) is a known complaint** in community reports, not mentioned by Oracle's page: UNVERIFIED. If it happens, the same kit runs on any Ubuntu LTS host with a free tier you trust.
- I could not load oracle.com's marketing page (HTTP 403 to my fetch), so nothing here relies on it. Prices outside Always Free: UNVERIFIED, not needed.

## 2. Licences of everything the kit installs (open source first)

| Piece | Licence / terms | Checked |
|---|---|---|
| Ubuntu, ufw, unattended-upgrades, OpenSSH | free software (GPL/BSD families) | UNVERIFIED per package |
| Node.js | MIT | UNVERIFIED (from memory) |
| Go toolchain | BSD-3-Clause | UNVERIFIED (from memory) |
| Tailscale client | BSD-3-Clause; the coordination service is a hosted product with a free Personal plan: [pricing](https://tailscale.com/pricing) (UNVERIFIED today). Headscale is the open-source control server if that ever matters | UNVERIFIED |
| Gauss, Argo | this repo | n/a |

## 3. Josh's steps

**A. Create the VM (you, in Oracle's console).** Ubuntu 24.04 LTS (or newest LTS), shape `VM.Standard.A1.Flex`, 2 OCPU / 12 GB (or less), your SSH public key. Optional: paste [`cloud-init.yaml`](cloud-init.yaml) as user-data (it installs git and clones this public repo; no secrets).

**B. Make a Tailscale auth key (you, in the Tailscale admin console).** Settings > Keys > Generate auth key: **one-use, not reusable, expires in 1 day**, optionally tagged. Do not paste it into chat, a ticket or a file.
Also check Tailscale admin > DNS > **HTTPS Certificates** is enabled (needed for `tailscale serve --https`).

**C. Run one command, once, on the VM** (SSH to its public IP this one time):

```bash
git clone https://github.com/Pallas117/Constellation.git /opt/gauss/src 2>/dev/null || true   # skipped if cloud-init did it
sudo bash /opt/gauss/src/scripts/ops/vps/bootstrap.sh --dry-run     # read what it will do; changes nothing
sudo bash /opt/gauss/src/scripts/ops/vps/bootstrap.sh               # pastes the key at a hidden prompt
```

It joins the tailnet as `gauss-hub`, installs Node and Go (checked against nodejs.org's `SHASUMS256.txt` and go.dev's sha256), builds Argo from source into `/usr/local/bin/argo`, starts the hub on 127.0.0.1, runs `tailscale serve`, enrols Argo as device `vps`, and **last** turns the firewall on (deny incoming except `tailscale0`). It prints the VPS's own key fingerprint; write it down. It is safe to re-run (for example after enabling HTTPS certificates).

**D. Close the public door at Oracle too.** From now on SSH over the tailnet (`ssh <user>@gauss-hub`). Once that works, delete the public port 22 ingress rule from the VCN security list (defence in depth: `ufw` is not the only wall). Check from a machine **outside** your tailnet: `nc -vz -w 3 <public-ip> 22 443 3001` must time out on all three. (Oracle's Ubuntu images ship their own iptables rules; how they combine with `ufw` is UNVERIFIED, which is why this outside check matters.)

**E. Confirm fingerprints, then trust (step 5 below).** The Argo relay service stays **stopped** until you do: Argo pins any key it sees first, so trust must come from a check you made.

## 4. The laptop enrols (at the Mac, with Josh)

Do **not** rebuild or reinstall `~/.local/bin/argo` for this (it resets the Messages permission). Build a test copy in /tmp and use a throwaway HOME so the laptop's real Argo keeps reporting to the live hub:

```bash
cd tools/argo && go build -o /tmp/argo-vps .            # test binary, not installed
export HOME_T=/tmp/argo-vps-test; mkdir -p "$HOME_T"
```

On the **VPS**, make a one-time device token (shown once, on your terminal only; never paste it elsewhere):

```bash
sudo -u gauss env MESH_STORE_PATH=/var/lib/gauss/mesh/devices.json sh -c 'cd /opt/gauss/src && npm run -s mesh:enroll -- laptop-test'
```

On **the laptop**, enrol with that token (it asks for it):

```bash
HOME=$HOME_T ARGO_NO_DESKTOP=1 /tmp/argo-vps enroll https://gauss-hub.<your-tailnet>.ts.net laptop-test
# prints: this device's key fingerprint: XXXX XXXX XXXX XXXX XXXX
```

(Production alternative, only with Josh's go-ahead: enrol the real `argo` the same way. That re-points the laptop's reports from the live hub to the VPS hub, and keeps her existing key. Read its fingerprint fresh with `argo keys` on the laptop.)

## 5. Confirm fingerprints (both directions)

1. **VPS trusts laptop.** Read the laptop's fingerprint on the laptop (`HOME=$HOME_T /tmp/argo-vps keys`), then on the VPS:
   ```bash
   sudo bash /opt/gauss/src/scripts/ops/vps/confirm-peer.sh laptop-test "XXXX XXXX XXXX XXXX XXXX"
   ```
   It compares what the hub holds for that device to the code you typed, refuses on any difference, asks you to type `yes`, runs `argo keys trust`, re-checks the pin, and only then starts `argo-relay`.
2. **The laptop trusts the VPS.** On laptop: `HOME=$HOME_T /tmp/argo-vps sync` (pins the VPS key on first sight), then `HOME=$HOME_T /tmp/argo-vps keys list`: the `vps` line must equal the fingerprint the bootstrap printed. If it differs, stop and do not send anything.

## 6. Test store-and-forward end to end (VPS unreachable, then back)

Same idea as `scripts/argo-relay-e2e.ts` steps 2 to 4 (queue while the hub is down, drain when it returns, byte-for-byte check), but with the real VPS and the real tailnet.

```bash
# laptop
printf 'aos,los\n09:41,09:52\n' > /tmp/pass-plan.csv
sha256sum /tmp/pass-plan.csv 2>/dev/null || shasum -a 256 /tmp/pass-plan.csv

# VPS: take it away
sudo systemctl stop argo-relay gauss-hub

# laptop: the send must queue, not fail
HOME=$HOME_T /tmp/argo-vps send vps /tmp/pass-plan.csv     # "queued", hub unreachable
HOME=$HOME_T /tmp/argo-vps outbox                          # 0/1 confirmed

# VPS: bring it back
sudo systemctl start gauss-hub argo-relay

# laptop: the first upload failed, so the retry is backed off about 30 s (as in the e2e script)
sleep 35; HOME=$HOME_T /tmp/argo-vps sync                  # "sent 1"
# VPS: Argo ticks every 60 s and collects it
sleep 70; sudo -u gauss sh -c 'sha256sum /var/lib/gauss/Downloads/Argo/laptop-test/pass-plan.csv'
# laptop: the signed receipt
HOME=$HOME_T /tmp/argo-vps sync; HOME=$HOME_T /tmp/argo-vps outbox     # 1/1 confirmed
```

Pass = the two checksums are equal and `outbox` shows `1/1 confirmed`. Also try a drop-out the other way: stop `argo-relay` only, send, and check the hub keeps the bundle (ciphertext) and the VPS collects it after restart.
Expected from the code (UNVERIFIED on a live VPS until you run it): if the tailnet answers with an HTTP error instead of refusing the connection, Argo still queues and retries.

## 7. Where things live

| What | Where |
|---|---|
| Hub code, `.auth.db` | `/opt/gauss/src` (owned by `gauss`; the hub unit may write only here and in `/var/lib/gauss`) |
| Hub data (device store, ciphertext bundles) | `/var/lib/gauss/mesh` |
| Argo state, keys (0600), inbox | `/var/lib/gauss/.config/argo`, `.local/state/argo`, `Downloads/Argo/<device>` |
| Secrets for the hub | `/etc/gauss/hub.env` (root, 0600, generated on the VM, never printed) |
| Units | `/etc/systemd/system/gauss-hub.service`, `argo-relay.service` (sandboxed: no new privileges, read-only system, memory caps) |
| Logs | `journalctl -u gauss-hub -u argo-relay` |

Update later: `sudo bash bootstrap.sh --ref <tag-or-sha>` re-pulls, rebuilds Argo, restarts the hub. A new Argo binary on the VPS has no macOS permission problem (no Messages there).

## 8. Known limits and open risks

- The sign-in side of the hub has no users on the VPS: only device-token routes (`/api/mesh/...`) and `/health` are in use. Creating staff accounts there is a separate decision.
- Only the backend runs; the website is not built there (no need for the relay).
- The Linux path of `bootstrap.sh` could not be run on this Mac: it was checked with `--dry-run`, text checks and `bash -n` (shellcheck was not installed here, so lint is UNVERIFIED until it runs on CI-less review or your machine: `shellcheck scripts/ops/vps/*.sh`). First real run is the real test: expect to iterate.
- `tailscale up --auth-key=file:PATH` is documented by Tailscale ([`tailscale up`](https://tailscale.com/docs/reference/tailscale-cli/up)); the minimum Tailscale version that supports it was not checked.
- Node and Go checksums come from the same HTTPS site as the files: they catch corruption and a bad mirror, not a compromised publisher. Signature checks (nodejs.org release keys) are not done: UNVERIFIED.
- The service user owns the checkout (the auth database lives next to the code), so a hub compromise could change code until the next `bootstrap.sh --ref`. Moving `.auth.db` out of the tree needs a backend change.
- Unattended upgrades use Ubuntu's default security origin and do not reboot automatically; kernel updates need a manual reboot now and then.
- Tests: `bash scripts/ops/vps/vps-kit.test.sh` (dry runs and text checks only; part of the ops tests).
