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
