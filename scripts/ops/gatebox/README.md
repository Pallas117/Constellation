# Gatebox: the cloud gate server (GAU-223)

This is the outside compute that the GAU-207 sizing recommends: an Oracle Always Free VM (VM.Standard.A1.Flex, 1 OCPU, 6 GB, Ubuntu 24.04 aarch64, home region Singapore) on the tailnet. It runs the Linux-portable gates (`npm ci`, `npm test`, `quality:full`, `build`) on one exact commit of the public repo. It has no GitHub runner, no tokens and no inbound service other than SSH. Once it joins the tailnet, SSH is closed to the internet.

- `cloud-init.yaml`: paste it unchanged when you create the instance. It installs Node 26 (`.nvmrc`, checked against nodejs.org's SHASUMS256), Tailscale, zram and earlyoom, plus `gauss-gate-run`. The `gate` user's key (`~/.ssh/gauss-gate` on judith) can only run that command.
- **DigitalOcean instead:** the same cloud-init works as a droplet's user data (Ubuntu 24.04 x64; it picks the x64 Node build). Size it at least 4 GiB / 2 vCPU. Use a DigitalOcean Cloud Firewall in place of Oracle's security list to close port 22 once the droplet is on the tailnet. Unlike Oracle Always Free it costs money, and a powered-off droplet still bills, unless startup credits cover it.
- **Join with `sudo tailscale up`, not `--ssh`.** Tailscale SSH ignores `authorized_keys`, which drops the forced command and lets the `gate` user run anything the ACL allows. The step-by-step guide in GAU-223 still says `--ssh`; correct it there before anyone follows it.

## Wiring on the Mac

```bash
echo gatebox > "$HOME/Library/Application Support/Gauss/gatebox"   # its tailnet name; delete the file to turn it off
scripts/ops/gauss-services.sh gates result status                   # "gatebox: gatebox screens each request first"
```

The gate runner (`gates run`) then sends each queued commit to the gatebox before it asks `claude-heavy` for this Mac's memory:

| Gatebox result | What the runner does |
|---|---|
| `gates rc=0` | runs the full gates here, as before. The ops tests and the VCRM need macOS, so the deploy record still comes from this Mac. |
| `gates rc=N` (1–63) | records the request as `FAILED on gatebox …` with the log under `gates/logs/`. Nothing runs here and no deploy record is written. |
| anything else: unreachable (255), busy (75), commit not on GitHub (65), fetch failed (69), killed | runs the gates here, as before |

## Merge-only trust (GAU-239, off by default)

On battery the full gates never start, so nothing merges, although the only checks that need this Mac are small. To let a gatebox pass count for **merging** (never for deploying), add a second line to the gatebox file:

```bash
printf 'gatebox\nmerge\n' > "$HOME/Library/Application Support/Gauss/gatebox"   # host, then "merge"
scripts/ops/gauss-services.sh gates result status   # "... a pass lets the train merge after the ops tests here (no deploy record)"
```

For a merge-train request (`gates enqueue <sha> --pr N`) the runner then:

1. merges `origin/main` into the PR head first, so the gatebox screens the head that would land;
2. sends that commit to the gatebox. Its pass line must name the commit (`gates rc=0 in S s on <sha>`);
3. on a pass, runs only `npm run test:ops` here (bash ops tests and the Argo Go short suite) as a small job: no install, and it may start on battery and at memory warn;
4. writes `PASSED merge only, no deploy record: ...` and lets the train merge under its usual rules (CLEAN, contains main, not a draft, nothing under auth, crypto, secrets, CyberTiger or keys).

What does not change:

- **Deploys.** No gate record is written, so `deploy <sha>` still needs the full gates on this Mac (`gates enqueue <sha>` without `--pr`, on AC power). The VCRM is checked only there.
- A request without `--pr`, an unreachable or busy gatebox, a pass line without the commit, or a head that moved after screening: the full gates run here, or the new head is screened again.

What you are trusting: with this on, main can receive a commit whose test suite, type check, lint and build ran only on the gatebox (Linux arm64, Node 26), not on this Mac. Someone who controls the gatebox, or its pinned host key and the tailnet path to it, could pass a commit that fails those checks. It cannot reach live: that still needs the full gates here. Delete the second line to turn it off.

On first contact the host key is pinned in `gatebox.known_hosts` (the tailnet has already authenticated the machine). If the key changes, the connection is refused and the gates run here.

Oracle reclaims an Always Free VM whose CPU, network and memory all stay under 20% for 7 days. Gate traffic alone may not prevent that. Watch for reclamation notices; any keepalive is still to be decided (GAU-223, "Josh does afterwards").
