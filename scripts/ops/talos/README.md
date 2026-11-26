# Talos kit: bring a nomadic Linux laptop into service

"Talos" is a second laptop (recorded as Kali Linux; UNVERIFIED) that should take work off the 8 GB Mac. Both
machines roam on a phone hotspot, so nothing here needs the Mac to reach Talos first: you run one command at the
Talos keyboard, it pulls the public repo from GitHub over https, and it can be run again after any drop-out.

This kit covers joining, facts, Argo and its service. It does not create the `gate` user or install Node: that is
the gate server's job (`../gatebox/`), done after this. The always-on hub is a different kit (`../vps/`, PR #307).

**Status: UNVERIFIED on real hardware.** Everything here was tested only on macOS against stubs and fixture files
(`talos-kit.test.sh`, and the Go tests in `tools/argo`). Nothing has run on Talos or on any Linux host.

## At the Talos keyboard

1. Power on and connect to your own phone hotspot (not a hostel or cafe network).
2. Get the repo: `git clone https://github.com/Pallas117/Constellation.git ~/src/Constellation`
3. See what would happen, changing nothing:
   `bash ~/src/Constellation/scripts/ops/talos/bootstrap.sh --tailnet-login <your Tailscale login> --dry-run`
4. Run it: the same command without `--dry-run`. Add `--commit <full sha>` to pin the commit you were told to use
   (it must be on `origin/main`); without it the newest `main` is used and printed for you to compare.
5. If it stops at step 2 it prints the exact command: install Tailscale with its official installer, or
   `sudo tailscale up` and sign in to the same account as the Mac. The script never joins, logs out or changes
   Tailscale itself, and it takes no auth key. Then run step 4 again.
6. Read the facts it prints (OS, cores, RAM, disk, battery, charger, charge limit). They are also saved in
   `~/.local/state/talos-kit/facts.txt`.
7. If it says Go is missing, install the Go version it names from https://go.dev/dl/ (check the sha256 listed
   there) and run step 4 again. It then builds Argo to `~/.local/bin/argo`: try `argo status` and `argo guard`.
8. When you want Argo to run by itself: the same command with `--install-service`. This is the only part that
   uses sudo; each sudo command is printed before it runs (install the unit, `daemon-reload`, `enable --now`).

If the connection drops at any point, run the same command again. Finished steps are skipped (same commit: no
rebuild; same unit: no sudo). git cannot resume half a download, so an interrupted fetch starts over.

The bootstrap refuses: running as root, a tailnet other than the one you named, a commit that is not on
`origin/main`, a checkout with local changes or a different origin, and any OS but Linux (except `--dry-run`).

## Then, from the Mac

```bash
tailscale status                 # Talos is listed, with its new address
tailscale ping talos             # answers directly or through a relay
tailscale ssh <user>@talos 'cat ~/.local/state/talos-kit/facts.txt; ~/.local/bin/argo status'
```

`tailscale ssh` works only while Tailscale SSH is on at Talos (`sudo tailscale up --ssh`). It takes the host key
from the tailnet, which has already authenticated the machine, instead of from `~/.ssh/known_hosts`. That is why it
avoids "Host key verification failed" when `known_hosts` still holds a key for Talos's old address. (The Mac's
client has the subcommand: `tailscale ssh` printed its usage on 18 Nov 2026, client 1.104.7. That it connects to
Talos is UNVERIFIED.) With plain `ssh` you would instead remove the stale line yourself (`ssh-keygen -R <old
address>`) and compare the new fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` read at the
Talos keyboard. Never switch host key checking off.

**The `--ssh` caveat (from `../gatebox/README.md`).** Tailscale SSH ignores `authorized_keys`. A `gate` user whose
key is limited to a forced command (`gauss-gate-run`) loses that limit, and can run anything the tailnet's SSH
rules allow. So `--ssh` is for first contact only. Before the gate user is created: install the Mac's admin public
key for your own user, check plain `ssh` works, then run `sudo tailscale set --ssh=false` yourself.

## The service

`systemd/gauss-argo.service` runs `argo loop` as the user who ran the bootstrap, never root. A crash is restarted
after 10 s, for as long as it takes (`Restart=on-failure`, no start limit). It has no capabilities and no new
privileges; the system and home are read-only apart from `~/.local/state/argo` and `~/.config/argo`; it has a
512 MB memory cap. `systemctl status gauss-argo`, `journalctl -u gauss-argo -n 50`. A hang (as opposed to a crash)
is not detected: Argo does not feed a systemd watchdog yet.

## Lid, suspend and the charge limit (your commands, not the bootstrap's)

- **Lid.** By default systemd suspends on lid close, also on mains. To keep working with the lid shut while
  plugged in, and still suspend on battery (which protects it):

  ```bash
  sudo install -d /etc/systemd/logind.conf.d
  printf '[Login]\nHandleLidSwitch=suspend\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' | sudo tee /etc/systemd/logind.conf.d/50-gauss-lid.conf
  ```

  Reboot to apply (restarting `systemd-logind` can end a desktop session). A desktop power manager (Xfce's, on
  Kali) may override this with its own lid setting: check there too. UNVERIFIED on Talos.
- **Suspend on battery is the safe default.** A suspended laptop runs no gates; the Mac's runner then does them
  itself (`../gatebox/README.md`, "anything else"). Do not mask `sleep.target` on a machine that travels in a bag.
- **Charge limit.** Only some laptops have one. The bootstrap prints "charge limit: offered" or "not offered";
  the file is `/sys/class/power_supply/BAT*/charge_control_end_threshold`. Only where it exists:
  `echo 80 | sudo tee /sys/class/power_supply/BAT0/charge_control_end_threshold`. Keep it above 50: Argo resumes
  paused jobs at 50% on a weak charger. Whether the value survives a reboot depends on the hardware (UNVERIFIED).
- **What software cannot fix.** A worn battery, or a charger that gives less than the machine draws. Argo says so
  ("plugged in but the battery is still draining": `tools/argo/README.md`, "Linux laptops on battery"), holds new
  heavy jobs at 35% and stops at 10%. It queues and waits; it does not make power.

## Ollama keep-alive (Josh runs this)

`ollama-override.conf` is a systemd drop-in that keeps the model loaded for 30 minutes, fixes the context at
8192 tokens and serves one request at a time, so a repeated prompt prefix is answered from cache (measured on
26 Nov 2026 with a 3,200-token prefix: 140.8 s to 3.5 s on Talos). Settings: <https://docs.ollama.com/faq>.
Agents do not install it: it needs sudo.

```bash
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo install -m 0644 -o root -g root scripts/ops/talos/ollama-override.conf /etc/systemd/system/ollama.service.d/override.conf
sudo systemctl daemon-reload
sudo systemctl restart ollama
systemctl show ollama -p Environment      # must list the three OLLAMA_ values
```

Undo: `sudo rm /etc/systemd/system/ollama.service.d/override.conf`, then daemon-reload and restart. The model
stays in RAM for 30 minutes after use: that is the cost.

## NVIDIA driver (Josh only)

Talos's GTX 1050 currently runs on the open NVK Vulkan driver. NVIDIA's proprietary branch 580 is the last
for Pascal cards ([deprecation schedule](https://forums.developer.nvidia.com/t/unix-graphics-feature-deprecation-schedule/60588/13)).
A driver change can leave the machine without a display, so:

1. Do it only after a confirmed good boot on the default kernel (`uname -r` matches the GRUB default).
2. Check Secure Boot first (`mokutil --sb-state`). If enabled, an unsigned module will not load.
3. Install branch 580 from the distribution's packages, not a downloaded `.run` file.
4. Reboot by hand, at the machine. No script or agent reboots Talos.
5. Re-run the benchmark afterwards and compare with the NVK numbers above.

## Never copy to Talos without Josh's decision

`.auth.db`, any `.env*`, `data/mesh/`, SSH and signing keys (including the gate key), vault contents and the vault
key, and anything `gauss-guard` marks SENSITIVE. Talos gets the public repo from GitHub and nothing else.

## Tests

```bash
bash scripts/ops/talos/talos-kit.test.sh
```

It is not yet part of `npm run test:ops`: PR #307 edits that same line, so wiring it in is left for whichever of
the two merges second (add `&& bash scripts/ops/talos/talos-kit.test.sh`).

## UNVERIFIED

- Talos's OS, user, RAM, cores, battery and whether it has a charge limit.
- `bootstrap.sh` on real Kali or any Linux: package names in its hints, `tailscale status --json` fields on the
  version Talos has, Go from the distribution being new enough.
- The unit's hardening against a real `argo loop` (a too-strict option shows as "read-only file system" or
  "permission denied" in the journal).
- Argo's Linux battery readings on real hardware, and laptops with two batteries.
- shellcheck was not installed where the tests ran.
