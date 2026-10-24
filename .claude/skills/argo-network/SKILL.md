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
| Resource guard | `guard*.go` | memory/battery/disk admission (GAU-195) |
| Alerts | `notify.go`, `phone.go` | class change only; OFFLINE never texts; usual blips stay quiet (see Rules) |
| Relay (DTN) | `cbor.go`, `bundle.go`, `bpsec.go`, `relay.go`, `relay_cmd.go`, `hub.go` | BPv7 bundles, blocks 192 (Ed25519) and 193 (HPKE ML-KEM-768+X25519), end-to-end receipts, data mule |
| Standard BPSec (interop) | `bpsec9173.go`, `aeskw.go`, `testdata/rfc9173/` | RFC 9173 BIB-HMAC-SHA2 and BCB-AES-GCM in blocks 11/12, pre-placed keys, AES key wrap (RFC 3394). Library only: no key store or command yet |
| Hub | `backend/mesh/bundles.ts`, `router.ts` | device-token routes before session auth; ciphertext only; key directory (first key wins) |
| UI | `frontend/src/pages/MeshDashboard.tsx`, `frontend/src/lib/link-stability.ts`, `website/public/argo/` | `/mesh` columns; `/argo/` is noindex, "Included", no price |

## Rules
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
  - Use only `crypto/hpke`, `crypto/ed25519` and `hash/crc32`. Bind the primary block in HPKE `info`; sign, then
    encrypt.
  - Regenerate the golden bundles after any format change: `ARGO_WRITE_FIXTURES=1 go test -run TestBundleFixtures .`
- Public copy (website test): no "post-quantum"/PQC, "VPN", "untraceable", grade or compliance claims; no Argo price.
- Never self-merge changes to crypto, device-token routes or public copy (outside the standing approval).
- Run `~/gauss/bin/gauss-guard` before reading Argo's state files.

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
- RFC 9173 errata matter:
  - Errata 9192 (reported 2026-09-28, UNVERIFIED) reads A.3's IPPT as using the bare primary block. The published example and dtn7-rs wrap it in a byte string. Argo wraps by default; `BarePrimary` selects the bare form. HDTN's choice is unknown.
  - Errata 7002: A.4 reuses one AES-GCM IV for two targets. `addBCB` therefore takes one target per BCB. Never set `BCBConfig.IV` outside golden tests.
- A Go subagent in a separate worktree may not have the newest `.claude/` files until main is merged into its branch. Brief it with the paths.
