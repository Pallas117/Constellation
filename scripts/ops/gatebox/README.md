# Gatebox: the cloud gate server (GAU-223)

This is the outside compute that the GAU-207 sizing recommends: an Oracle Always Free VM (VM.Standard.A1.Flex, 1 OCPU, 6 GB, Ubuntu 24.04 aarch64, home region Singapore) on the tailnet. It runs the Linux-portable gates (`npm ci`, `npm test`, `quality:full`, `build`) on one exact commit of the public repo. It has no GitHub runner, no tokens and no inbound service other than SSH. Once it joins the tailnet, SSH is closed to the internet.

- `cloud-init.yaml`: paste it unchanged when you create the instance. It installs Node 26 (`.nvmrc`, checked against nodejs.org's SHASUMS256), Tailscale, zram and earlyoom, plus `gauss-gate-run`. The `gate` user's key (`~/.ssh/gauss-gate` on judith) can only run that command.
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

On first contact the host key is pinned in `gatebox.known_hosts` (the tailnet has already authenticated the machine). If the key changes, the connection is refused and the gates run here.

Oracle reclaims an Always Free VM whose CPU, network and memory all stay under 20% for 7 days. Gate traffic alone may not prevent that. Watch for reclamation notices; any keepalive is still to be decided (GAU-223, "Josh does afterwards").
