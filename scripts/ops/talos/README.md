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
is not detected: Argo does not feed a systemd watchdog yet. The ops profile (below) adds a drop-in that makes
it `Restart=always` (also after a clean exit; `systemctl stop` still stops it).

## The ops profile (`--profile ops`)

Shapes Talos for gate and dev work on battery and a hotspot. Code: `ops-profile.sh`, run through the bootstrap.

```bash
bash ~/src/Constellation/scripts/ops/talos/bootstrap.sh --profile ops --dry-run        # print everything, change nothing
bash ~/src/Constellation/scripts/ops/talos/bootstrap.sh --profile ops                  # report: reads the machine, no sudo
bash ~/src/Constellation/scripts/ops/talos/bootstrap.sh --profile ops --apply-profile  # make the changes (sudo, each printed)
```

Without `--tailnet-login` only the profile runs (no network needed); with it, the five steps run first. Add
`--no-bluetooth` to stop bluetooth too. Every step checks first, so a re-run changes nothing that is in place.
The report is saved to `~/.local/state/talos-kit/profile.txt`. Exit 7 means a step failed; the others still ran.

| Step | What it does |
|---|---|
| 1 services | `disable --now` postgresql, cups (socket, path, browsed), avahi-daemon (socket too), bluetooth only with `--no-bluetooth`. KDE Connect off for your user (a `~/.config/autostart` entry with `Hidden=true`, no sudo). `ss -ltnp` before and after. Undo: `sudo systemctl enable --now <unit>`. |
| 2 power | power-saver on battery through TLP (`/etc/tlp.d/50-gauss-ops.conf`) or power-profiles-daemon (a udev rule), whichever is installed. It installs neither, and touches neither when both are installed. Charge limit 80% only where `charge_control_end_threshold` exists, set now and at every boot (`/etc/tmpfiles.d`). Lid: suspend on battery, ignore on external power (applies after a reboot). |
| 3 self-restart | `RuntimeWatchdogSec=30s` (`/etc/systemd/system.conf.d/`): a hung machine reboots. `Restart=always` drop-ins for tailscaled and gauss-argo (when installed). |
| 4 hardening | `/etc/ssh/sshd_config.d/05-gauss-ops.conf`: no passwords, no keyboard-interactive, no root login. Named 05- because sshd keeps the first value it reads, so it wins over harden.sh's `10-gauss.conf`. `sshd -t` runs before (an already broken config is left alone) and after; if it fails, the old file comes back and nothing is reloaded. Skipped while SSH runs with no key in `~/.ssh/authorized_keys` and Tailscale SSH off (it would lock you out). ufw and AppArmor are only reported (the firewall rules are harden.sh `--node`'s, in the private ops kit). journald capped at 200M. zram swap (zram-tools, zstd, 50% of RAM) unless zram is already on. |
| 5 tools | Node 26 and Go reported; when missing or wrong, the checked nodejs.org and go.dev installs are printed, never run. |

**Security updates on Kali: not installed, on purpose.** Kali is rolling and has no separate security archive, so
`unattended-upgrades` (security origins only) would install nothing, and unattended full upgrades of a rolling
distribution can break the machine; harden.sh skips it for the same reason. The profile says so and prints
`sudo apt update && sudo apt full-upgrade` for you to run on a network you trust. On Debian it installs and turns
on `unattended-upgrades`. For a custom USB image, see `image/README.md` (UNTESTED).

## Lid, suspend and the charge limit (by hand, if you do not use the ops profile)

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

## Never copy to Talos without Josh's decision

`.auth.db`, any `.env*`, `data/mesh/`, SSH and signing keys (including the gate key), vault contents and the vault
key, and anything `gauss-guard` marks SENSITIVE. Talos gets the public repo from GitHub and nothing else.

## Tests

```bash
bash scripts/ops/talos/talos-kit.test.sh
```

It is part of the `test:ops` package script.

## UNVERIFIED

- Talos's OS, user, RAM, cores, battery and whether it has a charge limit.
- `bootstrap.sh` on real Kali or any Linux: package names in its hints, `tailscale status --json` fields on the
  version Talos has, Go from the distribution being new enough.
- The unit's hardening against a real `argo loop` (a too-strict option shows as "read-only file system" or
  "permission denied" in the journal).
- Argo's Linux battery readings on real hardware, and laptops with two batteries.
- The ops profile on real hardware: unit names on Kali (`ssh.service`, `zramswap.service`), whether Xfce's power
  manager overrides the lid setting, the power-profiles-daemon udev rule (and USB-C chargers, which report type
  `USB`, not `Mains`), whether the charge limit holds, whether Talos has a hardware watchdog and how it behaves
  across suspend, and `sshd -T` output on the installed OpenSSH.
- shellcheck was not installed where the tests ran.
