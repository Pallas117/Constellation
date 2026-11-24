# Argo switching: what the logs show for 2026-11-05

Evening of 2026-11-05 (local time, UTC+8), judith (8 GB Mac) on a public Wi-Fi in Malaysia during a
storm. Josh: "Argo is not working. The network switcher needs to be better and the Tailscale faster
wired in." This note measures before anything is changed. Every number is marked OBSERVED (read from a
log, command shown), DERIVED (computed from code constants and log timestamps) or MISSING (nobody
recorded it). Files read: `~/.local/state/argo/{incidents.jsonl,guard.jsonl,launchd.log,egress.jsonl,
state.json}`, `~/.local/share/mesh-heal/mesh-heal.log`, `~/Library/Logs/gauss/awake.log`
(`gauss-guard` said cloud-ok for each). Today's incident lines are copied to
`tools/argo/testdata/incidents-2026-11-05.jsonl`; `TestOutagesReplay20261105` re-derives the outage
table below from them, and `argo report --outages` prints the same for the live log.

## 1. Outages today (OBSERVED, incidents.jsonl, 64 lines, 10 outages)

| Start | Network | Classes | Lasted | First advice | Attempts | Credited fix |
|---|---|---|---|---|---|---|
| 11:31:24 | 4667da | PORT_BLOCK | 18m25s | at open | 1 | none (cleared by itself) |
| 12:49:45 | 4667da | OFFLINE→DNS→PORT_BLOCK→OFFLINE→PORT_BLOCK | 32m26s | at open | 4 | none |
| 13:23:58 | 4667da | OFFLINE | 15s | at open | 1 | none |
| 13:26:29 | 0ceeba (hotspot) | OFFLINE→DNS | 8m13s | at open | 3 | none |
| 15:01:41 | 4667da | OFFLINE→DNS | 5m10s | at open | 2 | none |
| 15:40:04 | 0ceeba | PORT_BLOCK | 3m43s | at open | 2 | switch-network (network changed) |
| 16:48:51 | 4667da | OFFLINE | 47s | at open | 1 | none |
| 17:03:44 | 0ceeba | DNS→OFFLINE→PORT_BLOCK | 11m55s | at open | 4 | switch-network |
| 19:13:50 | 4667da | OFFLINE→PORT_BLOCK | 8m3s | at open | 3 | none |
| 19:24:55 | 4667da | OFFLINE | 10s | at open | 1 | none |

Fingerprints are `sha256(gateway MAC | public-IP prefix)[:12]`; 4667da is the public Wi-Fi, 0ceeba
the iPhone hotspot (its learned OFFLINE fix is `wifi-rejoin`). Nothing automatic ran on the Wi-Fi:
its OFFLINE plan was `usual-blip, wait` and its PORT_BLOCK plan `switch-network` (advice only), so
"first fix" today means "first advice", which the loop shows at open. 2 of 10 outages ended with a
credited fix, both `switch-network` with the fingerprint changing as evidence (loop.go `resolve`).

## 2. The 19:08-19:26 episode, second by second (OBSERVED unless marked)

| Time | Source | What |
|---|---|---|
| 19:08:34 | mesh-heal.log | "uplink down; not touching Tailscale" (mesh-heal checks every 90 s) |
| 19:10:21 | mesh-heal.log | "UPLINK recovered after 90s"; 19:10:22 unhealthy: "could not connect to the 'Singapore' relay server" |
| 19:10:45, 19:11:45 | guard.jsonl | Argo ticks at the normal 60-61 s cadence |
| 19:12:46 | guard.jsonl | tick starts; the next tick is 124 s later, so this run took over 60 s |
| 19:13:50 | incidents.jsonl | OFFLINE opened: 64 s after the tick started; plan `usual-blip, wait` |
| 19:15:56 | incidents.jsonl | attempt (wait) |
| 19:17:57 | incidents.jsonl, egress.jsonl | PORT_BLOCK "uplink stalled" supersedes OFFLINE; one text sent |
| 19:21:52 | incidents.jsonl, egress.jsonl | resolved "cleared by itself"; "recovered after 8m0s" text |
| 19:22:39 | mesh-heal.log | "UPLINK recovered after 626s", healthy again |
| 19:24:01-19:25:17 | guard.jsonl | ticks 21-34 s apart: WatchPaths fired on the reassociation (ThrottleInterval 20 s) |
| 19:24:55 → 19:25:04 | incidents.jsonl | OFFLINE for 10 s, then a new fingerprint 297618 (same gateway, new public prefix) |

- **Link loss → first classification:** between 65 s and 125 s. The last normal tick began 19:11:45;
  the loss happened after it and before 19:12:46 (bounds OBSERVED); the classifying run took 64 s from
  start to the `open` record (OBSERVED). Why 64 s (DERIVED from main.go/probe.go timeouts): guard phase
  ≤ 20 s, relay phase ≤ 30 s (the hub is on the tailnet, unreachable), then the probe (`tailscale status`
  ≤ 8 s, host commands), 10 s settle, second probe.
- **First advice:** at open (0 s after classification). **First automatic fix:** none on this network.
- **Recovery:** 8m03s after open; 9-13 min after the loss. The network cleared it; mesh-heal's own
  uplink probe agreed 47 s later. Nothing Argo did can be credited and the log says so.
- **Texts:** 2 for this outage (open and recovered). The network's PORT_BLOCK p90 (4073 s, from
  `state.json` `recover`) is above the 30 min `quietMax`, so the "usual blip" silence did not apply.

## 3. Tick cadence and overlap (OBSERVED, guard.jsonl: one sample per tick, 1031 today)

```
gap median 61 s, p90 75 s, max 1236 s
≤65 s: 818   65-130 s: 197   130-300 s: 5   >300 s: 10
```
- 197 gaps of 100-130 s are runs that outlived the 60 s StartInterval: launchd does not start a second
  copy, it fires again after the exit, so every blocking tick today cost two minutes of blindness. During
  19:12-19:23 every gap was 114-129 s.
- The 10 gaps over 5 min are sleep (lid closed on battery, awake.log 09:48 "awake off") and the two
  watchdog restarts at 11:19 and 11:49 ("no Argo check for 16/18 min", awake.log; fixed in PR #245 by
  reading `kern.waketime`).
- **"another argo run is in progress":** `launchd.log` holds 41 such lines in total, but the file was last
  written 2026-10-31 11:50 (`stat`), so **none today** (OBSERVED; corrects the "41+ times today" in the
  brief). launchd serialises ticks; the overlaps came from manual `argo fix`/phone runs colliding with a
  tick before the dead-holder check landed. The lock has no record of who was skipped: MISSING.
- `launchctl print`: runs = 5973, last exit code 0, run interval 60 s.

## 4. How long a probe takes (OBSERVED on the healthy link now, DERIVED on a stalled one)

| Measurement | Value | How |
|---|---|---|
| `argo doctor` (full probe, link healthy, 19:33) | 1.96 s | `/usr/bin/time -p argo doctor` |
| `tailscale status --json` | 0.06 s | same |
| `tailscale netcheck` | 2.07 s, nearest DERP Singapore, UDP ok | same |
| `tailscale ping <peer>` | MISSING: no tailnet peer was online (iphone-13 offline 2 days) | `tailscale status --json` |
| Probe on a stalled uplink, serial timeouts (DERIVED) | up to 50 s: tailscale 8 + DNS 8 + direct DNS 4 + captive 10 + API 10 + trace 10 | probe.go constants before this change |
| Loop phase on a stalled uplink (DERIVED) | 60 s cap: probe 50 + settle 10 + second probe cut by the phase deadline | main.go `phase(60*time.Second, loop.Tick)` |
| Whole tick on a stalled uplink | 100-130 s OBSERVED (gaps above) | guard.jsonl |

## 5. What was missing (MISSING)

- The exact moment the link dropped (Argo only samples once a minute; mesh-heal every 90 s).
- Per-phase and per-probe durations in a tick (nothing timed them; this change adds `argo status` timings
  for the switch and the tailnet check).
- Whether Tailscale reached the hub after each switch, and how long that took.
- Any record of skipped (overlapping) runs after 31 Oct.

## 6. Targets for the change set (to be verified by tests with a fake clock, then by the next real log)

- A tick that finds the uplink stalled finishes its probe in ≤ 12 s (one shared deadline, checks in
  parallel) instead of ≤ 50 s; the loop phase stays under the 60 s tick.
- A network change while a probe is running is classified within the new probe's budget, not after the
  old probe's timeouts.
- An overlapping tick exits quietly in well under a second and is counted.

## 7. Cloudflare WARP: not by default (decision, 2026-11-05)

What each layer does, from the code:

| Layer | Protects | Against | Evidence |
|---|---|---|---|
| Tailscale (WireGuard) | all traffic between team devices and to the Gauss hub | anyone on the Wi-Fi, the Wi-Fi operator | `gausspush.go` only talks to a tailnet address (`tailnetOnly`), relay bundles go hub-to-device over it |
| TLS (verified, never disabled) | traffic to Claude, GitHub, Cloudflare trace | reading or altering content; the destination hostnames stay visible (SNI) | `probe.go` `directClient`, README security rules |
| Argo relay (BPv7, HPKE + Ed25519) | files between devices, end to end | the hub itself, a carried folder | `docs/ARGO_DTN.md` |
| WARP (full tunnel) | the *rest*: which hosts the Mac talks to, DNS, apps without TLS | the Wi-Fi operator and neighbours | `shield.go` |

So on an untrusted Wi-Fi, WARP adds exactly one thing: it hides destinations and non-TLS traffic of
*other* apps from the local network. It does not make Claude, GitHub or the tailnet safer, and it
costs: an extra tunnel in the path (two today: WARP under Tailscale), a dependency on Cloudflare
being reachable (the 19:10-19:22 outage was the uplink itself, which no tunnel fixes), and the
automatic `warp-cli --accept-tos connect` accepts Cloudflare's terms and reroutes the Mac's egress
without the person at the keyboard (security review PR #243, finding 6, "policy and ToS problem").

Evidence from today: 0 of the 10 outages were caused or fixed by a tunnel; the credited fixes were
network switches. `state.json` shows `shield_on` unset on the current public Wi-Fi (WPA2, so the
shield never fired; the risk class came from this Mac's own sharing services, which WARP does not
change).

**Recommendation: keep the code, turn the automation off by default.** Done in this change:
`"wifi_shield": "warp"` in `~/.config/argo/config.json` restores the old behaviour; without it Argo
says once per untrusted network that WARP would help and how to turn it on. Nothing is uninstalled.
When WARP is worth turning on by hand: an open or WEP/WPA1 network where you will use apps that are
not the tailnet, Claude or a browser (anything on plain HTTP, mail clients with old settings), or
when the network operator must not see which hosts you talk to. Josh decides; Argo will not accept
terms for him. UNVERIFIED: whether WARP under Tailscale changed any of today's outcomes; nobody
measured it and the log has no WARP events today.

## 8. Network tools on this Mac: inventory and recommendations (Josh decides)

Sources: `ls ~/Library/LaunchAgents`, `launchctl list`, each plist's ProgramArguments and interval,
the first lines of each script, and today's logs. "Loaded" is what `launchctl list` showed at 19:35.

| Tool (label) | Runs | What it does (from its header) | Overlap with Argo | Recommendation | Evidence |
|---|---|---|---|---|---|
| **Argo** (`uk.lightbound.argo`) | every 60 s, on SystemConfiguration changes, at login | probe → classify → least-invasive fix → verify → learn per network; peer watchdog for gauss-awake and mesh-heal; resource guard; store-and-forward relay; passive network and app-data watch; phone texts | — | keep; this change set | plist; 1031 ticks today (guard.jsonl) |
| **mesh-heal** (`uk.lightbound.mesh-heal`) | every 90 s | Tailscale heal ladder: `tailscale up` → down+up → restart the engine, circuit breaker, "does nothing while the underlying internet is down"; its own uplink probe (3 URLs), captive probe, and **Wi-Fi power-cycles** (`wifi_cycles`, max per hour) | uplink and captive probes duplicate Argo's (both hit captive.apple.com, 60 s and 90 s apart); Wi-Fi cycling duplicates Argo's `wifi-rejoin`, so two actors can reset the radio; "uplink down" texts duplicate Argo's OFFLINE/PORT_BLOCK texts | **keep the Tailscale ladder, retire the rest**: move its uplink/captive detection and Wi-Fi cycling behind Argo's state (Argo already has the per-network memory, the breaker and the quiet-blip rule); mesh-heal would then only heal Tailscale when Argo's class is OK | `mesh-heal.sh` header and lines 77-131; today 21 "uplink down", 15 "UPLINK recovered", 2 HEAL rungs, 3 "Singapore relay" health lines (mesh-heal.log) |
| **gauss-awake** (`uk.lightbound.gauss-awake`) | every 60 s | keeps the Mac awake lid-closed on AC with a battery floor; watchdog restarts Argo (no check for 15 min) and mesh-heal (10 min) | mutual watchdog with Argo's `watchPeers` (by design: neither is a single point of failure) | keep; the false restarts after sleep are fixed in PR #245 (`kern.waketime`) | `gauss-services.sh:540-544`; awake.log 11:19, 11:30, 11:49, 12:31 restarts |
| **remote-watch** (`uk.lightbound.remote-watch`) | every 120 s | SSH off, battery, disk nearly full, memory pressure, tmux Claude stuck on a dialog, mesh-heal not running → kickstart; pushes fixes to the phone | disk, memory and battery alerts duplicate Argo's resource guard (GAU-195) and tpm-watch; the mesh-heal kick duplicates Argo's `watchPeers` | **retire the disk/memory/battery and mesh-heal-kick parts** (Argo's guard has the per-tick samples and heal episodes); keep SSH-off and tmux-stuck detection until Argo has them | header; egress.jsonl 18:24-19:02: four "disk low"/"disk OK" pairs from remote-watch at a 20 min cadence while Argo (18:30) and tpm-watch (18:25, 19:06) also texted about memory: three senders for one condition |
| **gauss-tpm-watch** (`uk.lightbound.gauss-tpm-watch`) | every 10 min | live backend health and TPM, disk floor and cleanup, memory sample and relief, worktree prune, Cosmic Garden rebuild, RTSW log, 09:00/21:00 status texts | memory and disk alerts overlap Argo's guard and remote-watch | keep (it owns the live backend and the cleanup); make one tool the sender for memory/disk texts | header; egress.jsonl today |
| **alive-beacon** (`uk.lightbound.alive-beacon`) | hourly | dead-man switch: HID idle → heartbeat date to a private repo; texts after 2 days silent; gated deploy after 3 | none (it only needs GitHub) | keep | header (GAU-182) |
| **Tailscale.app** (`application.io.tailscale.ipn.macsys`, running) | always | the tailnet (WireGuard); CLI at `/usr/local/bin/tailscale` | Argo reads `status`, and since this change runs `ping`/`netcheck` after a switch; mesh-heal owns `up` | keep | `launchctl list` pid 84248; netcheck 2.07 s, nearest DERP Singapore |
| **Cloudflare WARP.app** (+ `/usr/local/bin/warp-cli`, 26 Oct) | daemon (system domain; nothing in the user agents) | full-tunnel egress; was switched on by Argo's shield on open Wi-Fi | only the shield used it | keep installed, **automation off by default** (section 7); if it is never turned on by hand in a month, uninstall | `ls /Applications`; no WARP event in any log today |
| **Nadia** (`com.nadia.daemon`, plist present, **not loaded**) | KeepAlive when loaded | "security daemon: unauthorized file changes, network intrusions, rogue AI processes, duplicate/junk files" (Python with psutil, 336 lines) | its "network intrusions" part would duplicate Argo's passive network watch (ARP, inbound) and app-data watch | **retire** (remove the plist) unless Josh uses its file-change part; it is not running now, so nothing changes tonight; its exact behaviour is UNVERIFIED beyond the header | `launchctl list` shows no `com.nadia`; no log file under `~/nadia` |
| `ai.openclaw.gateway` (plist present, not loaded) | KeepAlive when loaded | a node gateway on port 18789 | none with Argo; a listening port if it is ever loaded | out of scope; UNVERIFIED what it serves | `launchctl list` |
| gauss-backend, gauss-frontend, gauss-memory, gauss-learning, pr-debt | — | the live demo, memory service, nightly training, PR debt report | not network tools | — | plists |

Retire list, in order of payoff: (1) remote-watch's disk/memory/battery alerts and its mesh-heal
kick, (2) mesh-heal's uplink probe, captive probe and Wi-Fi cycling, (3) Nadia's plist. Nothing is
removed by this change; each is Josh's call, and (2) needs mesh-heal to read Argo's class first.
