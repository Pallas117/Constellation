# Claws on Talos: threat model (DRAFT, 25 Nov 2026)

Status: draft for Josh's review. Everything here is UNVERIFIED on the real machine. Facts about OpenClaw-style
agents are from before June 2026 and are UNVERIFIED now (reported then: malicious community skills, publicly
exposed control panels). Source: `talos-desktop-agents-brief-2026-11-25.md`, layer 4.

A "claw" is a self-hosted autonomous agent that runs tools and community "skills" on its own. We assume it
will, sooner or later, run hostile code or be steered by hostile text. The design goal is that this costs
nothing outside its own box.

## Assets to protect
- Josh's accounts and tokens (GitHub, Google, Anthropic, Tailscale, email, messages), SSH and signing keys.
- Talos itself (a gate box on the tailnet) and everything the tailnet can reach.
- The Mac and the other machines (no path from a claw to them).
- Source and data that must stay local (anything `gauss-guard` marks SENSITIVE).

## Threats and controls (`claws-profile.sh`)
| Threat | Control |
|---|---|
| Malicious or buggy skill runs code | Skills only from an allowlist of sha256 hashes Josh has read (`/var/lib/gauss-claw/skills-allowlist.txt`, root-owned, empty at first); a claw never fetches skills itself (it has no network). |
| Claw reaches the LAN, tailnet or internet; exposed control panel | `--network=none`: no interface but loopback. The only way out is a unix socket to the loopback Ollama (`gauss-claw-gw.service`, socat, mounted read-only). Its panel, if any, listens inside the container only; reaching it is by `podman exec`, never a published port. |
| Escape to the host | Rootless podman under its own user `gauss-claw` (no sudo, no password, no shell); read-only root; all capabilities dropped; `no-new-privileges`; no `--privileged`, no host network, no device access. Root in the container is only `gauss-claw` outside. |
| Read or steal Josh's files and keys | No host mounts except one named scratch volume and the gateway socket. No `$HOME` mount. The user's home is 0700 and separate from Josh's. |
| Credentials | None are given: no API keys, no GitHub, Google, email or messaging links. Local models only. Any future connection needs Josh's review first. |
| Resource exhaustion | Memory 1 GB (no extra swap), 1 CPU, 128 pids, 64 MB `noexec` tmpfs; gateway 128 MB. |
| Poisoned image (supply chain) | Image must be pinned by digest and is pulled only with `--apply-claws` after Josh reads where it comes from. Pull and creation are separate from start. |
| Prompt injection from content the claw reads | It reads only what is placed in its scratch volume; no browsing, no mail. Its output is data, never merged or run without review. |
| Model gateway abuse | The gateway forwards only to 127.0.0.1:11434. Ollama stays on loopback (`models-profile.sh`). A claw can burn CPU on Talos, nothing else. |

## Residual risk (accepted or open)
- Kernel or podman container-escape bugs: rootless and capability-free reduce, not remove. Keep Talos patched
  (Kali is rolling: `apt full-upgrade` on a trusted network).
- Scratch volume content is untrusted: never execute it outside the container.
- A shim inside the image is needed to speak to the socket; an image that cannot work without a network will
  simply fail. Do not "fix" that by enabling a network.
- Resource limits and `--network=none` are tested only against stubs (`talos-kit.test.sh`): UNVERIFIED on podman
  and the real kernel.

## Checks before the first start (Josh)
1. `podman inspect claw-<name>`: NetworkMode `none`, ReadonlyRootfs true, Privileged false, two mounts only.
2. Inside, `ip addr` shows only `lo`; a connect to any external address fails.
3. From the tailnet and the LAN, nothing new listens: `ss -ltnp` before and after starting.
4. `skills-allowlist.txt` is empty, or each line is a skill you read.
5. No file of yours is reachable: `ls /home` inside is empty.

## Not allowed without a new review
Any network beyond the gateway, any credential, any host mount, a bigger Ollama exposure, auto-start at boot,
installing a skill that is not on the allowlist, or linking a claw to Josh's accounts.
