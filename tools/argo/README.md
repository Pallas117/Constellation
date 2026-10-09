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

- **Report to Gauss.** An admin creates a token on `/mesh`. Then run
  `argo enroll http://<gauss-tailnet-host>:3001 <device-name>` and paste the token when asked.
  Argo refuses any URL that isn't a tailnet address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48` or `*.ts.net`).
- **Slack alerts (reach your phone).** Create a Slack incoming webhook for a private channel or your own DM,
  then run `argo slack` and paste the URL when asked (it's stored `0600` and never typed on the command line).
  Check it with `argo slack test`; turn it off with `argo slack off`. Only `https://hooks.slack.com/services/…`
  is accepted, and messages carry just the masked title and reason. Alerts raised while offline are queued
  (up to 20) and sent on the next tick that has internet.
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
| `argo report` | Incident counts by class, fix success rate, last 10 events |
| `argo slack [test\|off]` | Set up, test or turn off Slack alerts |
| `argo off` / `argo on` | Pauses or resumes the LaunchAgent ticks |
| `argo preflight` | Fast local check for dead proxies and stuck Claude daemons (exit 1 if found) |
| `argo run -- cmd` | Runs `cmd` with dead proxy variables removed |

## How it works

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
  first 3 IPv4 octets or IPv6 hextets. The fix that resolved a class on a network is tried first next time.
  The raw IP and MAC are never stored or reported.

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
