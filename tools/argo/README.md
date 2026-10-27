# Argo

Argo keeps Claude Code (terminal, desktop app, background agents) connected on phone hotspots and public Wi-Fi.
It runs as **your** LaunchAgent (never root). It works out what is wrong, applies the least invasive fix,
checks the fix worked, and remembers what worked on each network. It can also report a short status to the
Gauss **Mesh & Network** page (`/mesh`) so the team can see who is blocked.

## Install

```bash
cd tools/argo
go build -trimpath -o ~/.local/bin/argo .
argo doctor          # read-only diagnosis; check class: OK and loc=MY/SG
argo install         # writes ~/Library/LaunchAgents/uk.lightbound.argo.plist and prints the next command
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/uk.lightbound.argo.plist
```

Optional extras:

- **Report to Gauss automatically (one command).** With the Gauss backend running from this repo, run
  `tools/argo/connect-gauss.sh [device-name] [gauss-url]` (defaults: this Mac's name, `http://127.0.0.1:3001`).
  It enrolls the device via `npm run mesh:enroll`, pipes the one-time token straight into `argo enroll`
  (never shown or stored in history), runs a check, and confirms Gauss received it. After that, every Argo check
  updates the Mesh page. Gauss on this Mac (loopback) or on the tailnet is accepted; nothing else is.
- **Report to a remote Gauss.** An admin creates a token on `/mesh`. Then run
  `argo enroll http://<gauss-tailnet-host>:3001 <device-name>` and paste the token when asked.
  Argo refuses any URL that isn't a tailnet address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48` or `*.ts.net`).
- **Alerts on your iPhone.** Run `argo phone +60XXXXXXXXX` (or your Apple ID email), then `argo phone test`.
  Argo sends an iMessage from this Mac's Messages app to your own handle, so no app or token is needed.
  macOS asks once to let Argo control Messages. Messages carry only the masked title and reason. Alerts
  raised while offline are queued (up to 20) and sent on the next tick with internet. `argo phone off`
  turns them off. An iMessage to your own number arrives without a banner; for alerts you'll notice, set
  `"phone_service": "sms"` in `~/.config/argo/config.json` (SMS first via Text Message Forwarding, then
  iMessage). The background agent needs its own Automation → Messages permission: after every rebuild of the
  ad-hoc-signed binary, macOS asks again on the first background send, and sends time out after 30 s until
  someone clicks Allow.
- **Alerts from other tools.** `argo notify [-key K -every 30m] TITLE MESSAGE` sends through the same
  channel, mask and offline queue, at most once per interval per key. The gauss-awake battery guard
  uses it (battery low, at the sleep floor, charger can't keep up, no cutoff configured), as do
  mesh-heal and Claude Code `Notification` hooks.
- **Claude Code status line.** In `~/.claude/settings.json`:
  `"statusLine": {"type": "command", "command": "argo status"}`.
  It reads the cached state only, so it never probes the network and is instant.
- **Check before each `claude` launch.** In `~/.zshrc`:
  ```zsh
  claude() { command argo preflight; command argo run -- "$(whence -p claude)" "$@"; }
  ```
  `argo run` drops only proxy variables that refuse connections. Working proxies and CA settings
  (`NODE_EXTRA_CA_CERTS`) are left alone.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/uk.lightbound.argo
argo uninstall       # removes the plist, ~/.local/state/argo and ~/.config/argo
rm ~/.local/bin/argo
```

Then remove the `statusLine` and `claude()` lines above if you added them, and revoke the device on `/mesh`.

## Commands

| Command | What it does |
|---|---|
| `argo status` | One line, e.g. `● OK MY ts:on` or `▲ REGION HK ts:on` |
| `argo doctor` | Full probe snapshot (secrets masked), the class, and what to do. Changes nothing. |
| `argo fix` | Runs the loop once in the foreground |
| `argo report` | Incident counts by class, how many needed a fix and were fixed, how many resolved on their own, last 10 events |
| `argo phone <handle>\|test\|off` | Set up, test or turn off iMessage alerts to your iPhone |
| `argo notify [-key K -every D] TITLE MSG` | Send an alert to your iPhone (masked, queued offline, rate-limited per key) |
| `argo watch` | Run the peer watchdog once (also every tick): restarts the gauss-awake guard or mesh-heal when their heartbeat is stale, max 3 restarts/hour each, then alerts. Override the list with `"watch"` in config.json |
| `argo devices` | Which watched tailnet devices are offline. Every tick, a phone of yours that has been off the tailnet for 30 min or more gets a text (SMS over its own cellular link) with the fix: open Tailscale, turn on Connect On Demand. At most every 6 h per device. Override the list with `"devices": ["hostname", ...]` in config.json |
| `argo guard` | Resource guard (below): memory, battery, disk and CPU now and over the last 24 h, who uses memory, what to do. `--json` for scripts |
| `argo guard admit [-mem GB] [-wait 10m]` | Exit 0 if a job needing GB may start now, 75 (with the reason) if not |
| `argo guard run [-mem GB] [-max GB] [-wait 10m] -- cmd` | Runs `cmd` only when admitted, and stops its whole process group if the host reaches **block** or the job holds more than `-max` GB. Exit 75 when refused or stopped, otherwise `cmd`'s own code |
| `argo send [-ttl 72h] DEVICE FILE` | Queue a file for another enrolled device (below): signed, encrypted to that device, kept until it confirms. Works offline |
| `argo outbox` / `argo inbox` | What you sent and how far it got (queued, at hub, picked up, confirmed); what you received and where it was saved |
| `argo sync` | Forward and fetch now (every tick does this too) |
| `argo keys [list\|publish\|trust DEVICE]` | This device's key fingerprint; devices you trust and theirs; accept a device's new key after checking it |
| `argo mule export\|import DIR` | Carry bundles on a drive to or from a device with no network |
| `argo link` | Link stability: availability, drops and recovery times over 24 h and 7 days |
| `argo off` / `argo on` | Pauses or resumes the LaunchAgent ticks |
| `argo preflight` | Fast local check for dead proxies and stuck Claude daemons (exit 1 if found) |
| `argo run -- cmd` | Runs `cmd` with dead proxy variables removed |

## How it works

Wi-Fi security is checked on every probe: WIFI_RISK (a warning, like WPAD_RISK) when the network is open, WEP or WPA1, or when this Mac answers sharing services (Remote Login, File Sharing, Screen Sharing, Remote Management, AirPlay Receiver) on its LAN address. Argo only advises; it never changes System Settings.

Alerts stay quiet on purpose: an unresolved problem texts once when it escalates, then at most every 2 h, and OFFLINE never texts (a Mac with no network cannot send, and queued texts would arrive stale).


```
LaunchAgent: network change (WatchPaths /Library/Preferences/SystemConfiguration), every 5 min, login
   │
   ▼
probe ──► classify ──► remediate ──► verify ──► remember
 │          │             │            │           │
 │          │             │            │           └─ ~/.local/state/argo/state.json (per-network fixes)
 │          │             │            │              ~/.local/state/argo/incidents.jsonl
 │          │             │            └─ re-probe after automatic fixes; fixes you run are checked next tick
 │          │             └─ ladder, least invasive first; only "open captive portal" runs by itself
 │          └─ first match wins: OFFLINE, CAPTIVE, DNS, DEAD_PROXY, STALE_DAEMON,
 │             TLS_INTERCEPT, PORT_BLOCK, REGION, WPAD_RISK, OK
 └─ default route and gateway MAC, scutil --proxy, proxy variables, `ps -E` for claude processes,
    tailscale status, DNS, api.anthropic.com (direct, TLS verified), Cloudflare trace (loc),
    captive.apple.com
```

- **Probes sit behind the `Prober` interface.** Tests replay recorded snapshots from `testdata/`, including
  the real HK eSIM 403 and the two ECONNREFUSED cases.
- **`STALE_DAEMON`** comes from the 2026-10-08/09 incident. The `claude daemon` had re-executed itself on an
  upgrade and kept `HTTPS_PROXY=127.0.0.1:4000` from an old shell, so every background agent got
  ECONNREFUSED even though new shells were clean. Argo finds any `claude` process carrying a loopback proxy
  that refuses connections and tells you to run `claude daemon stop --any`. It doesn't run that itself,
  because it ends background sessions.
- **Backoff and circuit breaker match mesh-heal.** At most 4 attempts, `60s·2^(n-1)` capped at 15 min,
  then the breaker stays open for 30 min with one "Argo needs you" notification.
- **Notifications fire only when the class changes**, so you won't get a ping every 5 minutes for the
  same problem.
- **Memory.** Each network is fingerprinted as `sha256(gateway MAC | public IP prefix)[:12]`, using the
  first 3 IPv4 octets or IPv6 hextets. The raw IP and MAC are never stored or reported. An incident that starts
  while the link is down belongs to the network the Mac was on, not to an empty fingerprint.
- **Learning, honestly.** A fix is remembered for a network only with evidence that it worked: it ran and the
  re-probe passed, the network changed (for "switch network"), an exit node is now in use, or it was a local
  setting (proxy, daemon) that never clears by itself. "Wait" and DNS advice nobody can confirm are never
  credited. Otherwise the incident cleared by itself, and Argo keeps how long that took (last 20 per network
  and class).
- **Usual blips stay quiet.** After 3 such recoveries, a new incident of that class on that network is announced
  only if it lasts longer than the network usually needs (its 90th percentile, at most 30 min). The advice says
  so, and the breaker waits as long. A recovery is announced only if its incident was, or lasted 15 min or
  more. On the 2026-10-23 hostel hotspot this would have cut about 20 alerts for blips of 0.3-5 min to the one
  75-minute outage, once each class had been seen three times.

### Tailscale: Argo defers to mesh-heal

Argo never runs `tailscale` commands that change anything. mesh-heal owns the tunnel. It heals with a bare
`tailscale up`, which refuses to run once non-default settings such as an exit node are set, so the two must
not fight over settings. For `REGION` and `PORT_BLOCK`, Argo *recommends*
`tailscale set --exit-node=<node>`, and only for nodes you have allow-listed as MY or SG in
`~/.config/argo/config.json`:

```json
{ "exit_nodes": { "exit-sg-1": "SG", "exit-my-1": "MY" } }
```

Any other country, Hong Kong included, is never offered. **Before deploying an exit node,** change
mesh-heal's heal step to `tailscale up --exit-node=…` (or use `tailscale set`), otherwise its heal attempts
will fail and its breaker will open.

### Security rules (enforced in code, covered by tests)

- **TLS verification is never disabled.** Probes use the system trust store, and no action touches
  `NODE_TLS_REJECT_UNAUTHORIZED` or CA settings.
- **No admin action runs automatically.** `sudo`/`networksetup` fixes are printed for you to run.
- **No secrets are written or sent.** Values whose names contain key/token/secret/password and URL
  `user:pass@` are masked. Recorded process commands stop before the environment that `ps -E` appends.
- **No code is fetched at runtime.** Argo has no dependencies beyond the Go standard library.
- **State files are `0600` under `~/.local/state/argo`.** The Gauss token lives in `~/.config/argo/token`
  (`0600`), is read from stdin and never put on the command line.

## Network scores (privacy, speed, signal)

Network texts (class changes, recoveries, the weekly summary) and `argo doctor` end with one line, e.g.
`Privacy 70/100 (Remote Login (SSH) reachable on this network -10, …) · Speed excellent (29 ms) · Signal fair (SNR 22 dB)`.
The same scores go to Gauss and show in the Network column on `/mesh`. Each one uses only what this check measured.
Anything Argo couldn't measure says `not measured` (signal says `n/a` off Wi-Fi), never a guessed number.

- **Privacy** starts at 100 and loses named points:
  - TLS interception −50
  - open Wi-Fi −40, or weak encryption (WEP/WPA1) −30; only −10 while a Tailscale exit node tunnels the traffic
  - each sharing service reachable on this network −10, up to −30 (turn it off in System Settings > General > Sharing)
  - auto-proxy (WPAD/PAC) −15
  - captive portal −10
- **Speed** is the TCP connect time to api.anthropic.com on the check Argo already makes: one round trip, no extra data.
  Bands: ≤60 ms excellent, ≤150 good, ≤300 fair, above that poor. It is latency, not a throughput test.
- **Signal** is Wi-Fi signal-to-noise from `system_profiler SPAirPortDataType` (no sudo).
  Bands: ≥40 dB excellent, ≥25 good, ≥15 fair, below that poor. Only the current network is read.
  The reading is cached for 5 minutes per network, because the command takes about 5 seconds.

## Resource guard (memory, battery, disk, CPU)

Every tick (once a minute) Argo takes one cheap reading of the host and keeps the last 24 h in
`~/.local/state/argo/guard.jsonl` (about 400 KB, never sent anywhere). Each resource is rated, and the worst
rating is the host's level:

| Level | Means | Examples |
|---|---|---|
| ok | takes work | |
| watch | light work only (jobs up to 1 GB, one mesh slot) | memory at warn, on battery, disk under 20 GB, load ≥ 1 per core, charger rated below the machine's draw |
| risk | no new work; running work continues | memory at warn for 30 of the last 60 min, swap +1 GB in an hour at warn, swap ≥ 4 GB, battery ≤ 20% (or ≤ 25% with memory at warn, or under an hour to the floor), plugged in but still losing charge, disk under 8 GB, CPU throttled by the OS |
| block | no work; guarded jobs are stopped | memory pressure critical, battery at the 10% floor on battery power, disk under 3 GB (swap lives on the boot volume) |

The floors are the ones `gauss-services.sh` already uses (battery 10% / 20%, swap 4 GB, disk 8 GB); the trend rules are GAU-165's.
Memory pressure is the kernel's own level on macOS; on Linux it is PSI (`/proc/pressure/memory`, our thresholds:
some ≥ 10% of a minute = warn, full ≥ 10% or some ≥ 40% = critical) or, without PSI, available memory.

**Autoscaler.** Free RAM after a 1.5 GB reserve, divided by `guard_slot_gb` (config.json, default 2 GB), capped at
cores − 1, is how many agent slots the host offers. It scales down at once, and up one slot at a time, only after
10 minutes without risk and at most every 5 minutes, so a new or recovered host takes no work until it has been calm
for 10 minutes. The decision (level, admission open/full/limited/closed, slots, free GB, finding codes) and the
battery level go to Gauss with each report; Gauss lowers its "Can host" verdict to match and shows why on `/mesh`.

**Phone texts** (rate-limited per key) cover what the gauss-services guard doesn't: memory at warn for 30 of the last
60 min, swap climbing at warn (naming the three biggest memory users by group), and low battery with memory at warn.
Replaying the evening before the 2026-10-21 hard reset (`testdata/gau165-replay.tsv`), the first text would have come at 21:35,
90 minutes before swap crossed 5 GB.

**Guarded jobs.** Use `argo guard run` for anything heavy, e.g. `argo guard run -mem 2 -max 4 -wait 30m -- npm ci`.
The job runs in its own process group (Ctrl-C is passed on). Two bad readings in a row, 5 s apart, stop it with
SIGTERM, then SIGKILL after 15 s. `~/.local/state/argo/guard.log` records each run by command name only (never its
arguments).

## Store and forward (delay-tolerant delivery)

Files move between enrolled devices the way spacecraft send data home: held, forwarded when a path opens,
confirmed when they land. A hotspot drop, a sleeping laptop or a machine that is only reachable in short windows
delays a file; it doesn't lose it. Design, sources and threat model: [`docs/ARGO_DTN.md`](../../docs/ARGO_DTN.md).

```bash
argo send ground-1 pass-plan.csv     # queued even offline; prints the first sync
argo outbox                          # pass-plan.csv → ground-1: 1/1 confirmed (1 delivered)
argo inbox                           # on ground-1: 2026-10-23 09:41  judith  ~/Downloads/Argo/judith/pass-plan.csv
```

- **Format.** Each file is split into 1 MiB chunks; each chunk is one Bundle Protocol v7 bundle
  ([RFC 9171](https://www.rfc-editor.org/rfc/rfc9171)): CBOR, CRC-32C on every block, a lifetime (7 days by
  default, 30 at most), never fragmented. The sender asks for a "delivered" status report.
- **Security.** The sender signs the primary block and payload with Ed25519 and encrypts the payload and the
  signature to the destination's key with HPKE ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180)): ML-KEM-768 +
  X25519 hybrid KEM, HKDF-SHA256, AES-256-GCM. The HPKE context binds the primary block, so a ciphertext can't be
  moved to another bundle. Both blocks follow BPSec's layout ([RFC 9172](https://www.rfc-editor.org/rfc/rfc9172))
  but use RFC 9171's private block types 192 and 193, because RFC 9172 has no private range for security
  context IDs and HPKE is not a standard BPSec context yet. Go standard library only (`crypto/hpke`,
  `crypto/ed25519`); no new cryptography.
- **Keys.** `argo enroll` creates `~/.config/argo/node.key` (0600; never leaves the device) and publishes the
  public half to Gauss. Other devices pin a key the first time they see it; a different key later is reported and
  not used until someone runs `argo keys trust DEVICE`. Compare fingerprints (`argo keys`, the Key line on
  `/mesh`) with the other person before relying on a new device.
- **Paths.** The Gauss hub (`/api/mesh/bundles`, device token, tailnet only) holds ciphertext until the
  destination collects it, and keeps a tombstone so the sender can tell "picked up" from "lost". `argo mule`
  writes the queue plus this device's public key to a folder for someone to carry; the far side imports it.
- **Reliability is end to end.** BPv7 has no custody transfer, so the sender keeps every bundle until the signed
  receipt arrives. It re-checks bundles the hub should hold every 10 min and uploads again any the hub lost. A
  receiver answers a duplicate with a fresh receipt, so a lost receipt never strands a sender. Every state change is
  written to disk (fsync, then rename) before the hub is told it can forget a bundle.
- **Proven in a simulation.** `sim_test.go` runs the real relay code for 5 days. Its links are calibrated on this
  Mac's own hotspot history (24 drops a day, typical outage 3 min, p95 about an hour). It includes a laptop asleep
  each night, an onboard computer reachable only in 8-12 minute passes, and a hub that loses its data every 36 h.
  Seed 20261023, 60 files:

  | Variant | Delivered | Receipts | p95 latency |
  |---|---|---|---|
  | Direct only (both ends online at once; optimistic) | 60/60 | n/a | 10 h 50 min |
  | Relay that trusts the hub | 59/60 | 57/60 | 7 h 24 min |
  | Relay, end to end (Argo) | 60/60 | 60/60 | 7 h 24 min |

  Seeds 7 and 424242 also give 60/60 and 60/60 with no duplicates.
- **Not yet.**
  - Direct device-to-device transfer (TCPCLv4, [RFC 9174](https://www.rfc-editor.org/rfc/rfc9174)).
  - The RFC 9173 security contexts that ION and HDTN speak; interoperability with them is untested.
  - Resuming a chunk part-way.
  - Phones.

## Link stability

`argo link` and every report to Gauss carry availability over the last 24 h and 7 days, from Argo's own incident
log: A = MTBF / (MTBF + MTTR), computed as 1 − down/observed. They also carry the number of drops, the median and
95th-percentile outage, and the time between drops. Time asleep counts as observed and up unless an incident was
open. The 7-day figure is the stability score on `/mesh`. Example from this Mac on 2026-10-23:
`Link stability 83/100 · 24 h: 84.3% up over 24.0 h, 24 drops, typical outage 3 min (p95 63 min)`.

## Linux and containers

Argo also builds for Linux hosts (ground stations, GalacticOS, other edge Linux) as a 9.5 MB container: no shell, non-root, read-only.

```
podman build -t argo:dev -f Containerfile .        # runs go vet and the Linux tests first
podman run -d --name argo --network host --read-only --cap-drop ALL \
  --security-opt no-new-privileges -v argo-state:/home/nonroot/.local/state/argo \
  -v ./config.json:/home/nonroot/.config/argo/config.json:ro argo:dev
podman run --rm --network host argo:dev doctor     # one-off diagnosis
```

`argo loop` (the image's default) checks every `ARGO_INTERVAL` (default 60s; the full probe still runs at most every ~5 min on a stable network). On Linux, route and gateway come from `/proc`, proxies from the environment, alerts are log lines on stdout (no Messages app, so phone texts are off), and Claude Code stale-daemon checks are skipped. `--network host` is what lets it see the host's real network.

## Tests

```bash
go test ./...                                   # unit: every class, loop, masking, parsers
go test -tags integration -v ./...              # runs the real probes on this machine (read-only)
```

## Migrating from netguard, netstatus and fixnet

| Old | New |
|---|---|
| `~/gauss-agent/bin/netstatus` (status line) | `argo status` |
| `~/gauss-agent/bin/fixnet` | `argo doctor` (read-only) or `argo fix` |
| `install-claude-netguard.sh` / `claude-netcheck` | `argo preflight` plus the LaunchAgent. netguard was never installed as a LaunchAgent on judith, so there is nothing to unload. |
| `.zshrc` `claude()` wrapper that strips every proxy | `argo run -- claude`, which strips only dead ones |
| `~/Library/Logs/claude-netguard.log` | `~/.local/state/argo/incidents.jsonl` and `argo report` |

Keep `netstatus` and `fixnet` until Argo has run cleanly for a week, then delete them. Suggested
`~/gauss-agent/index.tsv` rows:

```
AR	argo	~/.local/bin/argo	Network-integrity agent (replaces netstatus/fixnet/netguard)
AS	argo-state	~/.local/state/argo	Argo state.json + incidents.jsonl
AC	argo-config	~/.config/argo	Argo config (exit-node allowlist, Gauss URL, device token)
AL	argo-agent	~/Library/LaunchAgents/uk.lightbound.argo.plist	Argo LaunchAgent
```

## Phones: report to the mesh (iOS Shortcut, Android)

Phones can't run Argo, but they can post the same report so the Mesh page shows them with platform and
battery. Phones are always "status only": Gauss never places mesh work on them.

**Once per phone:** on Gauss → **Mesh**, an admin enrolls a device (e.g. `iphone-13`) and copies the
one-time token. Tailscale must be on (the report URL is tailnet-only).

**Report body** (`POST http://<gauss-tailnet-host>/api/mesh/report`, header `Authorization: Bearer <token>`,
`Content-Type: application/json`):

```json
{"class": "OK", "platform": "ios", "loc": "MY", "battery": {"level": 83, "charging": false, "lowPower": false},
 "reason": "phone shortcut", "checkedAt": "2026-10-21T09:00:00+08:00"}
```

`class` is `OK`, or `REGION` when `loc` isn't MY/SG. `level` may be a percent (83) or a fraction (0.83).
Unknown fields are dropped; reports more often than every 10 s get HTTP 429.

**iOS Shortcut** (*Mesh report*):
1. **Get Contents of URL** `https://www.cloudflare.com/cdn-cgi/trace` → **Match Text** `loc=([A-Z]{2})` →
   **Get Group at Index** 1 (as in *Exit check* below).
2. **If** *Group* is `MY` or `SG` → **Text** `OK`, otherwise **Text** `REGION`; set variable *Class*.
3. **Get Battery Level**; **Get Device Details** → *Is Charging* and *Low Power Mode* (where available).
4. **Format Date** *Current Date* as ISO 8601.
5. **Get Contents of URL** `http://<gauss-tailnet-host>/api/mesh/report`, Method **POST**, Headers
   `Authorization` = `Bearer <token>`, Request Body **JSON**: `class` = *Class*, `platform` = `ios`,
   `loc` = *Group*, `battery` (Dictionary: `level` = *Battery Level*, `charging` = *Is Charging*,
   `lowPower` = *Low Power Mode*), `reason` = `phone shortcut`, `checkedAt` = *Formatted Date*.
6. Automation → **Time of Day** (e.g. every 2 h: one automation per time), and **When joining any Wi-Fi**
   and **When Personal Hotspot turns on** → **Run** *Mesh report* → *Run Immediately*.

**Android:** the open-source **HTTP Shortcuts** app (or Tasker's *HTTP Request*) can send the same body;
use variables for battery level and charging, and schedule it every 2 h and on network change.

**Security:** the token can only post this phone's status (it reads nothing). The Shortcut keeps it in
your Shortcuts library (iCloud-synced if Shortcuts sync is on). If the phone is lost, revoke the device
on **Mesh**: its token stops working immediately.

## iPhone Shortcut: "Am I in MY/SG?"

Use this on the phone whose hotspot the Mac uses. It catches a Hong Kong eSIM before Claude does.

1. Shortcuts → **New Shortcut**, named *Exit check*.
2. **Get Contents of URL**: `https://www.cloudflare.com/cdn-cgi/trace`
3. **Match Text** with pattern `loc=([A-Z]{2})`, then **Get Group at Index** 1.
4. **If** *Group* **is not** `MY`, then **If** it **is not** `SG`, then **Show Notification**:
   "Exit is {Group}. Claude will fail. Switch to the Malaysian SIM or turn on the MY/SG exit node in
   Tailscale."
5. Otherwise, **Show Notification**: "Exit {Group} OK".
6. Automation → **When** *Personal Hotspot* turns on, or **When joining any Wi-Fi** → **Run** *Exit check*
   → *Run Immediately*.

If your Tailscale iOS version provides Shortcuts actions for exit nodes, you can add one to step 4 to switch
to the allow-listed node automatically.
