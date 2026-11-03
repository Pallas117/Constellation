# Argo test plan

Goal (Josh, 3 Nov 2026): Argo as hard to break, as interoperable and as self-running as we can make it,
with the checks automatic rather than remembered.

## What runs, and when (automatic)

| When | What | Where |
|---|---|---|
| Every gate (any PR, `npm run test:ops`) | `tools/argo/check.sh`: gofmt, `go vet` (macOS + Linux), builds for darwin/arm64, linux/amd64 and linux/arm64, all tests with the race detector, coverage not under `coverage-floor`, fuzz seeds | gate queue |
| Every install | `tools/argo/install.sh`: check.sh, build with the commit stamped in, the new binary must run before it replaces the old one, rollback if the installed one doesn't, keeps its 3 newest backups | by hand or from deploy |
| Every deploy of main | `gauss-services.sh deploy` reinstalls Argo when `tools/argo` changed or the installed Argo can't say its commit (`argo version`), so the installed Argo follows main | live deploy |
| Container build | `go vet` + Linux tests inside the build | `Containerfile` |
| On demand | `ARGO_FUZZ=30s tools/argo/check.sh` (fuzz every target), `ARGO_E2E=1 …` (two real Argos against the real Gauss mesh routers), `go test -tags integration ./...` (real probes on this machine) | by hand |

## Layers

**Unit (most of it, ~200 tests, < 2 min with -race).** Pure functions with recorded inputs: the classifier
(every network class from `testdata/*.json`), the guard's assessment and admission (table tests with
sampled hosts), parsers for `pmset`, `ioreg`, `airport`/CoreWLAN, `tailscale`, CBOR/BPv7 bundles, the
rejoin ladder and notify rate limits. Time, the network and commands are injected (`Now`, `Prober`,
fake runners), so tests are deterministic and need no network.

**Component, with real sockets on 127.0.0.1.** The HTTP probe against local servers (refused, timeout,
DNS, self-signed TLS, redirects, body cap); the Gauss hub client against a stand-in hub (each route,
token, every reply kind, proxy variables ignored, tailnet-only URLs); the guard runner pausing and
resuming a real child process (eclipse, brownout, calls).

**Contract (interop with Gauss).** `contract_test.go` checks every route Argo calls exists in
`backend/mesh/router.ts` under `/api/mesh`; `backend/mesh/mesh.test.ts` checks every guard code Argo
sends is one Gauss accepts. Either side renaming something fails the gate on the other.

**End to end.** `scripts/argo-relay-e2e.ts`: two Argo devices (own HOME) against the real mesh routers:
enroll, send, hub down, send again, hub back, receive both, receipts, tampered bundle refused, carried
drive. Not in the gate yet (needs network probes during `enroll`; see gaps).

**Fuzz.** `FuzzParseBundle` (bundles and the BPSec block) and `FuzzCBORSkip` (decoder: no panic, hang
or runaway recursion on hostile bytes). Seeds run on every gate; long runs on demand.

## Resilience cases covered

| Failure | Expected behaviour | Test |
|---|---|---|
| config.json torn or hand-broken | last good copy, warning; never silent defaults | `config_test.go` |
| crash mid-save | atomic write (temp + rename), 0600 | `config_test.go` |
| state.json corrupt; a run killed mid-append | empty usable state; the torn line is skipped and the next incident still lands | `config_test.go` |
| dead proxy variable in the environment | hub and probes ignore it | `hub_test.go`, `probe_test.go` |
| hub down, old Gauss without the routes, 5xx | retried later; only JSON refusals are final | `hub_test.go`, `relay_test.go` |
| oversized or hostile replies | capped reads, refused ids never sent | `hub_test.go`, fuzz |
| self-signed or wrong certificate | `tls_untrusted`, never accepted | `probe_test.go` |
| memory, swap, battery, 8 W charger, calls | admission, pause/resume with hysteresis, exit 75 to retry | `guard_test.go`, `eclipse_test.go`, `brownout_test.go`, `foreground_test.go` |
| new binary broken | not installed; installed one broken → rolled back | `install.sh` |

## Coverage

Statement coverage 75.3% on 3 Nov 2026 (69% before this plan; target reached) (`check.sh` prints it). `coverage-floor` holds the floor; raise it
when coverage goes up, never lower it to pass. Target 75% by end of November, from the gaps below.
Not chased: `main()`, `install`/`uninstall` (launchctl), and the darwin wrappers that only run a system
command (covered by the parsers they feed and by `-tags integration`).

## Gaps, in order

1. `relay_cmd.go`: carried-folder path and usage errors covered (relaycmd_test.go); the hub path (`sync`, `keys publish|trust`) still needs a fake hub.
2. `loop.go` (43%) and `wifiscan.go` (28%): the tick's decision path when the scan helper is missing or slow.
3. Relay end to end in the gate: make `argo enroll` skip the live network probe under a test flag, then add
   `ARGO_E2E=1` to the gate.
4. Long fuzz on a schedule (nightly, under the job guard) once the Mac has memory headroom.
5. BPSec/RFC 9173 interop vectors: GAU-199 (separate PR; crypto changes are Josh's to merge).
