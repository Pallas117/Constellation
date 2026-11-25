---
name: argo-network
description: Map, rules, tests and pitfalls for Gauss Argo (tools/argo, Go standard library only), the mesh routes it talks to (backend/mesh) and its store-and-forward relay (Bundle Protocol v7, HPKE/Ed25519, Gauss hub). Use before changing Argo's classes, remediation or learning, network/link scores, phone alerts, mesh report fields, the relay/DTN code, or the /mesh and /argo/ pages that show them.
---

# Gauss Argo and the mesh

Argo keeps a team's machines connected the way a spacecraft keeps itself alive: probe, classify, fix the least
invasive thing, verify, learn per network. It also carries files between devices through drop-outs (DTN).
Design and sources: `docs/ARGO_DTN.md`. User guide: `tools/argo/README.md`.

## Map
| Area | Path | Notes |
|---|---|---|
| Commands, tick | `tools/argo/main.go` | LaunchAgent `tick` every minute; full probe on the hotspot (172.20.10.1), on change, or every ~5 min. `loop` for Linux containers |
| Fault loop | `loop.go`, `classify.go`, `probe.go` | probe → classify (first match wins) → `Plan` ladder → verify → `resolve` learns. Fixtures in `testdata/*.json` |
| Per-network memory | `store.go` | `State`, `Net{Fixes, Recover}`, `Fingerprint` (sha256 of gateway MAC + IP prefix); incidents in `~/.local/state/argo/incidents.jsonl` |
| Scores | `netscore.go`, `wifi.go`, `linkstats.go` | privacy/speed/signal; availability = 1 − down/observed over 24 h and 7 d |
| Reports to Gauss | `gausspush.go` → `backend/mesh/store.ts` `parseReport` | every field allowlisted and range-checked on the backend; `MESH_CLASSES` must match `classify.go` (contract test) |
| DNS and reachability | `uplink.go`, `privdns.go`, `reach.go` | dead uplink vs DNS (IP anchors); encrypted DNS (DoH ranking, `argo private-dns`, profile); per-host blocks (`argo reach`) |
| Resource guard | `guard*.go` | memory/battery/disk admission (GAU-195) |
| Alerts | `notify.go`, `phone.go` | class change only; OFFLINE never texts; usual blips stay quiet (see Rules) |
| Relay (DTN) | `cbor.go`, `bundle.go`, `bpsec.go`, `relay.go`, `relay_cmd.go`, `hub.go` | BPv7 bundles, blocks 192 (Ed25519) and 193 (HPKE ML-KEM-768+X25519), end-to-end receipts, data mule |
| Standard BPSec (interop) | `bpsec9173.go`, `aeskw.go`, `testdata/rfc9173/` | RFC 9173 BIB-HMAC-SHA2 and BCB-AES-GCM in blocks 11/12, pre-placed keys, AES key wrap (RFC 3394) |
| Link keys | `linkkeys.go` | per-pair, per-direction keys offered under argo-sig + argo-seal, confirmed by receipt; then BIB-HMAC-SHA256 (primary) + BCB-AES-256-GCM (payload); `links.key` 0600; rotate 7 d / 65,536 bundles |
| Low signal, bearers | `lowsignal.go`, `bearer.go`, `radiostate.go`, `relay_radio.go`, `meshtastic.go` | detector with hysteresis; chunk ladder 1 MiB/64 KiB/4 KiB; fragments + XOR parity + duty budget; radio carries only BPSec-protected small bundles; Meshtastic behind `ARGO_MESHTASTIC_URL` (docs/ARGO_DTN.md "Low signal and IoT bearers") |
| Clock, wired link, signal map | `timeintegrity.go`, `wiredlink.go`, `linksample.go`, `frontend/src/lib/link-map.ts` | Date-header cross-check (never sets the clock); "iPhone USB" advice (never changes settings); `linkSample` allowlisted, hashes only |
| Hub | `backend/mesh/bundles.ts`, `router.ts` | device-token routes before session auth; ciphertext only; key directory (first key wins) |
| UI | `frontend/src/pages/MeshDashboard.tsx`, `frontend/src/lib/link-stability.ts`, `website/public/argo/` | `/mesh` columns; `/argo/` is noindex, "Included", no price |

## Rules
- **Never rebuild or install `~/.local/bin/argo` from an agent or an unattended session.** macOS keys the Automation → Messages grant and Full Disk Access to the ad-hoc signature, so a rebuild silences texts until Josh clicks Allow at the Mac (5 Nov 2026). Build to /tmp for tests; Josh installs. After any rebuild: `argo phone test`.
- Go standard library only, no runtime downloads. One binary for macOS and Linux (`host_darwin.go` / `host_linux.go`).
- Never disable TLS verification, never run an admin action automatically, never run a Tailscale command that changes
  settings (mesh-heal owns the tunnel). Mask secrets (`Mask`). State and keys are 0600 under `~/.local/state/argo` and
  `~/.config/argo`.
- **Learn only from evidence** (Josh, 2026-10-23: "adapting better, not making the same mistakes"):
  - An incident belongs to the network the Mac was on, even with the link down.
  - Credit a fix only if it ran and verified, the network changed ("switch network"), an exit node is in use, or it was
    a local setting that can't clear by itself.
  - Otherwise record the recovery time. Usual blips stay quiet until they outlast that network's p90.
- New report field: add it to `parseReport` with ranges, to the TS types, and to a test. Never store anything Argo
  sends unchecked.
- Device-token routes: list them in the `backend/rbac.ts` header comment. CyberTiger counts 401/403, so agents must
  stop on 401.
- Relay crypto:
  - Use only the standard library: `crypto/hpke`, `crypto/ed25519`, `crypto/hkdf`, `crypto/aes`, `crypto/cipher`,
    `crypto/hmac`, `hash/crc32`. Bind the primary block in HPKE `info`; sign, then encrypt.
  - Link keys only ever travel inside an argo-seal-1 bundle, and are used only after the peer's receipt. Never log
    or print a `linkKey.Key`; outbox items and `relay.json` carry only its id. Anything a third party must check
    keeps Ed25519.
  - Regenerate the golden bundles after any format change: `ARGO_WRITE_FIXTURES=1 go test -run TestBundleFixtures .`
- Public copy (website test): no "post-quantum"/PQC, "VPN", "untraceable", grade or compliance claims; no Argo price.
- Never self-merge changes to crypto, device-token routes or public copy (outside the standing approval).
- Run `~/gauss/bin/gauss-guard` before reading Argo's state files.

## DNS: diagnose, then fix the right layer (GAU-247, GAU-248)
A failed lookup has four different causes; tell them apart with evidence before advising anything:
| Evidence (probe fields) | Meaning | Class and advice |
|---|---|---|
| system lookup fails, `dns_direct_ok` true | Tailscale's MagicDNS resolver is stuck; the network is fine | DNS: `check-magicdns` |
| both lookups fail, `ip_up` false (1.1.1.1/9.9.9.9/8.8.8.8:443 by IP all silent) | the uplink is dead, not DNS | PORT_BLOCK "uplink stalled": hotspot; no flush, no exit node |
| both fail, `ip_up` true, `doh_ok` true | the network's resolver or its port-53 filter is broken | DNS: `private-dns` first (encrypted DNS goes around it) |
| both fail, `ip_up` true, `doh_ok` false | DNS really is blocked here, encrypted too | DNS: flush, then switch network |

- Replay check: mesh-heal's `uplink down` lines (`~/.local/share/mesh-heal/mesh-heal.log`; its URLs include `https://1.1.1.1`) are independent IP-level evidence. On 18 Nov 2026 a 9.6 h "DNS" incident had 306/307 checks down: it was the uplink.
- One host unreachable while others work (NASA GSFC iSWA/CDAWeb from the dorm's TM line, 18 Nov) is not a link class: `argo reach` names it (`blocked`, `tls_failed`, `tls_untrusted`, `dns`, `uplink_down`) and remembers it per network. Advice is another network or device; nothing on the Mac fixes it.
- Privacy: judith's ordinary lookups went in plain text to 1.1.1.1/8.8.8.8 (Tailscale's resolver was supplemental for ts.net only; the tailnet configures no resolvers). `argo private-dns` reads `scutil --dns`, `tailscale dns status` and `profiles list`, ranks Quad9/Cloudflare/Google by DoH round trip by address (Quad9 wins within 15 ms), remembers the pick per network, and `profile` writes an unsigned `com.apple.dnsSettings.managed` profile the person approves (Mac and iPhone; Linux gets systemd-resolved DoT text). Argo never installs it, never sets ProhibitDisablement, never changes Tailscale DNS (that is the tailnet admin: global nameserver + Override local DNS, which Tailscale upgrades to DoH).
- No central DNS server for the mesh: on a roaming, sleeping laptop it would take every device's DNS down and need port 53 on the tailnet. Each device picks its own nearest anycast resolver ("fewest hops" = lowest round trip; hop counts are not measured).
- The profile keeps tailnet and local names (`ts.net`, the tailnet suffix, `gauss.internal`, `local`, `lan`, `home.arpa`) on the normal resolver via `NeverConnect`, or MagicDNS can break. Captive portals with the profile on are UNVERIFIED: the CAPTIVE plan says to remove it, log in and add it back.

## Security self-check (before handing back; report each item as pass / n/a / fixed)
Built from Argo's security review (#243, 5 Nov) and the 17 Nov backend sweep of the hub routes. It is the same format as the backend and website checks.
1. **TLS and redirects:** no `InsecureSkipVerify`. HTTP clients that carry a device token don't follow redirects, so the token can't leak to another host (#243). Tokens go in headers, never URLs or query strings.
2. **No automatic admin:** remediation runs only actions marked Auto. Nothing uses sudo, changes system settings or Tailscale settings (mesh-heal owns the tunnel), or touches the installed `~/.local/bin/argo`.
3. **System tools:** external commands use pinned absolute paths, never `PATH` lookup (#243). Arguments are passed as an argv list, never through a shell, and never built from network or report input.
4. **Secrets:** keys, tokens and `linkKey.Key` never appear in logs, texts, reports, outbox items or `relay.json` (ids only, `Mask` everything else). State and keys files are 0600.
5. **Files from the network:** inbox and outbox names are rebuilt from an allowlist, UTF-8/rune-safe (#243), never containing `..` or `/`. Writes stay inside Argo's own directories, and sizes and counts are capped.
6. **Relay crypto:** standard library only. The primary block is bound in HPKE `info`; sign, then encrypt. One target per BCB, and no hand-set IV outside golden tests (RFC 9173 errata 7002). Link keys are used only after the peer's receipt. Golden bundles are regenerated after any format change.
7. **Hub routes** (`backend/mesh`): device-token routes check the token hash, rate-limit with CyberTiger's extracted client IP, cap body and bundle sizes, and keep ciphertext and public keys only. New report fields go through `parseReport` with ranges, and a revoked device can't report.
8. **Bounded resources:** every queue, map and history Argo keeps (outbox, inbox, incidents, per-network stats) has a cap and an expiry. Probes have timeouts and back-off. Nothing grows without bound on a long hotspot outage.
9. **Alerts and evidence:** no duplicate texts for the same incident; texts carry no secrets or full paths. A fix is credited only with evidence (see Learn only from evidence above).
10. **Tests:** each item that applies has a Go test (or a `backend/mesh` test for the hub), `go vet` passes on darwin and linux, and the PR lists the self-check results. A change to crypto, device-token routes or public copy says "Josh merges".

## Tests
| What | Command |
|---|---|
| Unit + simulation | `cd tools/argo && go test ./...` (`-short` skips the 15 s 5-day DTN simulation; `ARGO_SIM_SEED=n` for other seeds) |
| Static | `gofmt -l .`, `go vet ./...`, `GOOS=linux go vet ./...` |
| Fuzz | `go test -run '^$' -fuzz FuzzParseBundle -fuzztime 45s -parallel 2 .` (and `FuzzRFC9173`) |
| RFC 9173 golden tests | `go test -short -run 9173 .`: Appendix A.1-A.4 byte for byte, RFC 3394 §4 vectors |
| Hub/mesh | `node --import tsx --import ./backend/test-setup.ts --test backend/mesh/*.test.ts` |
| End to end | `npm run test:argo-e2e`: the real binary as two devices against the real routes (1-3 min) |
| Ops | `npm run test:ops` |

Heavy jobs go through `claude-heavy`. A Go package or one node test file may use `--max-level 2`.

## Pitfalls seen
- Rebuilding `~/.local/bin/argo` brings back the macOS Messages permission prompt. Only do it with Josh at the Mac.
- A test server in the same Node process as `spawnSync` clients deadlocks; spawn asynchronously.
- zsh does not word-split `$VAR`. Use `bash -c` for scripted pre-merge checks.
- Fixtures carry real timestamps: give stores an injectable clock.
- macOS `File.Sync` is F_FULLFSYNC (slow). The simulation turns it off with `fsyncWrites = false`.
- `ARGO_NO_DESKTOP=1` stops relay alerts popping banners in scripts and tests.
- An older Gauss answers the relay routes with a non-JSON 404. Argo treats that as "retry later", not a refusal.
- The 24 h log on the hostel hotspot: 24 drops, median 3 min, p95 about 1 h. Calibrate simulations from `argo link`, not guesses.
- The toolchain is pinned in `go.mod` (`toolchain go1.26.10`; `crypto/hpke` needs 1.26). Build with `go build -o /dev/null .` or `-o ~/somewhere`: a plain `go build` leaves an `argo` binary in `tools/argo` (ignored, but don't ship it).
- Go's `http.Transport` with a custom `DialContext`/`TLSClientConfig` speaks HTTP/1.1 unless `ForceAttemptHTTP2` is set; Quad9's DoH answers HTTP/1.1 with 505 (18 Nov 2026).
- Never put the tailnet name (`tailXXXX.ts.net`) in fixtures: the repo is public. Replace it with `tail0000.ts.net`.
- RFC 9173 errata matter:
  - Errata 9192 (reported 2026-09-28, UNVERIFIED) reads A.3's IPPT as using the bare primary block. The published example and dtn7-rs wrap it in a byte string. Argo wraps by default; `BarePrimary` selects the bare form. HDTN's choice is unknown.
  - Errata 7002: A.4 reuses one AES-GCM IV for two targets. `addBCB` therefore takes one target per BCB. Never set `BCBConfig.IV` outside golden tests.
- A Go subagent in a separate worktree may not have the newest `.claude/` files until main is merged into its branch. Brief it with the paths.
