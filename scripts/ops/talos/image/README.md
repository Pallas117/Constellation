# Talos image: a custom Kali USB with the ops profile (UNTESTED)

**Status: UNTESTED.** Nothing on this page has been built or booted. There are no build scripts here on
purpose: none has been run. Treat this as a plan to follow by hand, and record what actually happened when
someone does.

The goal: a USB stick that installs Kali on a replacement laptop already shaped like Talos, so a lost or dead
machine is back in service in an hour. Everything the image adds is public (this repo and Kali's own packages):
no keys, tokens, Tailscale auth keys or `.env` files are ever baked in.

## Option A: Kali's own live-build-config

Kali builds its ISOs with live-build and publishes the configuration at
<https://gitlab.com/kalilinux/build-scripts/live-build-config>. Its README is the reference for the steps below;
check it first, as Kali changes them between releases.

1. On a Kali (or Debian with Kali's archive keyring) build machine with about 20 GB free disk:
   `sudo apt install -y git live-build simple-cdd cdebootstrap curl`, then
   `git clone https://gitlab.com/kalilinux/build-scripts/live-build-config.git`.
2. **Packages.** Add a package list, e.g. `kali-config/variant-xfce/package-lists/gauss-ops.list.chroot`:

   ```text
   git
   python3
   openssh-server
   ufw
   apparmor
   apparmor-utils
   zram-tools
   power-profiles-daemon
   ```

   One power manager only: `power-profiles-daemon` or `tlp`, never both (the profile leaves both alone if it
   finds both). Leave Node and Go out: the profile prints the checked nodejs.org and go.dev installs, and the
   versions must match `.nvmrc` and `tools/argo/go.mod` at the commit you run.
3. **First-boot hook.** The profile must run as the normal user, never root, and `--apply-profile` asks for the
   sudo password. So the image does not apply it at boot; it opens it at first login, where you can watch it and
   type the password. A chroot hook (`kali-config/common/hooks/live/gauss-ops.chroot`, run while the image is
   built) can add a desktop autostart entry for every new user:

   ```bash
   #!/bin/sh
   # Runs inside the image chroot at build time. Adds a first-login launcher; changes nothing else.
   set -e
   mkdir -p /etc/skel/.config/autostart
   cat >/etc/skel/.config/autostart/gauss-ops-first-login.desktop <<'EOF'
   [Desktop Entry]
   Type=Application
   Name=Gauss ops profile (first login)
   Exec=x-terminal-emulator -e sh -c 'git clone https://github.com/Pallas117/Constellation.git "$HOME/src/Constellation" && bash "$HOME/src/Constellation/scripts/ops/talos/bootstrap.sh" --profile ops --apply-profile; rm -f "$HOME/.config/autostart/gauss-ops-first-login.desktop"; exec "$SHELL"'
   EOF
   ```

   The first login needs a network for the clone (your own phone hotspot). Without one, the launcher fails and
   stays for the next login. Run `bootstrap.sh --tailnet-login <login>` afterwards as in `../README.md`: the
   image never joins Tailscale by itself.
4. Build: `./build.sh --verbose --variant xfce` (or `--installer` for an installer ISO; check the live-build-config
   README for the current flags). Write the ISO to a USB stick and verify its sha256 before you boot it.
5. After the first login, compare `~/.local/state/talos-kit/profile.txt` with the one from the old Talos.

What to verify the first time (all UNVERIFIED): the hook path and name pattern live-build-config expects; that
`/etc/skel` reaches the installed user (live vs installer images differ); that Xfce runs the autostart entry;
that `x-terminal-emulator` exists in the variant.

## Option B: Debian stable, with Kali's tools in a container

A stable base is easier to keep running unattended than a rolling one: Debian stable has a security archive, so
the profile's security-updates step does install `unattended-upgrades` there (on Kali it explains why it does not).

1. Install Debian stable from its official netinst image; pick Xfce and the SSH server.
2. As your user: clone the repo and run `bash ~/src/Constellation/scripts/ops/talos/bootstrap.sh --profile ops`
   (report), then again with `--apply-profile`.
3. Kali's tools when you need them, in a container, from Kali's official image on Docker Hub (`kalilinux/kali-rolling`):
   `sudo apt install -y podman`, then `podman run --rm -it docker.io/kalilinux/kali-rolling` and inside it
   `apt update && apt install -y kali-linux-headless` (or only the tools you need). Rootless podman keeps the
   tools away from the host's files; give a container the host network only when a tool needs it.

What changes compared with Kali on the metal (UNVERIFIED): tools that need raw Wi-Fi or USB access need
`--privileged` or device passthrough, which removes most of the container's isolation; NVIDIA on nouveau behaves
as on Debian (no change expected); the image is a few GB on disk.

## Never in the image

`.auth.db`, any `.env*`, `data/mesh/`, SSH or signing keys, Tailscale auth keys, vault contents: the same list as
`../README.md`. The image gets the public repo from GitHub at first login and nothing else.
