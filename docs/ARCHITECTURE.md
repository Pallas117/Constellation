# Gauss (Constellation) architecture

Last checked against `main` 96469f2 (2026-11-17). Every component below names its file, so a
reviewer can check this page against the code. When you add or remove a subsystem, route group or
gate step, update this page in the same PR.

Related: [requirements/README.md](../requirements/README.md) (requirements baseline and VCRM,
NASA SP-2016-6105 Rev 2), [WORKTREE_ARCHITECTURE.md](WORKTREE_ARCHITECTURE.md) (branches),
[ARGO_DTN.md](ARGO_DTN.md) (store-and-forward), [DEVICE_AUTH.md](DEVICE_AUTH.md),
[EVIDENCE_SIGNING.md](EVIDENCE_SIGNING.md), [CRYPTO_INVENTORY.md](CRYPTO_INVENTORY.md),
[STABILITY.md](STABILITY.md), [adr/](adr/).

## 1. System context

```
 External sources                 Gauss host                                    People and devices
 ────────────────                 ──────────                                    ──────────────────
 NOAA SWPC / RTSW (L1) ─┐   ┌──────────────────────────────────────────────┐
 Kyoto Dst ─────────────┤   │ backend (Express 4 + ws, Node 26, :3001)     │◄── browser: frontend (Vite/React/r3f)
 GOES particles ────────┼──►│  ingest worker → canonical feed → bedrock    │       served on :8080, same-origin /api
 SWPC products ─────────┤   │  API_POLICY (RBAC) · better-auth · CyberTiger│◄── org API keys: /api/v1 data API
 ESA HAPI (Swarm) ──────┤   │  trust records · evidence packs · mesh hub   │◄── Argo agents: /api/mesh (device token)
 NASA CDAWeb / LASP MMS ┤   └───────┬────────────────────────┬─────────────┘
 JAXA ERG (probe only) ─┘           │ loopback               │ loopback
                            gauss-brain memory sidecar   ml infer server
                            (/api/rag, GAUSS_MEMORY_URL)  (ml/infer, LOCAL_INFER_URL)
```

Runtimes: Node 26 (`frontend/`, `backend/`, `shared/`, `scripts/`), Go standard library
(`tools/argo/`), Python (`ml/`), Cloudflare Worker (`website/`). The C++ MHD core
(`backend/cpp/`) is parked: opt-in with `npm run build:native` + `GAUSS_NATIVE_MHD=1`; the
TypeScript nowcast (`backend/physics/mhd-nowcast.ts`) is the default.

## 2. Repository layout

| Path | What |
|---|---|
| `frontend/` | Operator and public UI: React 18, react-three-fiber, Tailwind/shadcn (`frontend/vite.config.ts`) |
| `backend/` | API server, ingest, physics, auth, trust, mesh hub (`backend/server.ts`) |
| `shared/` | Shared by both: `policy/freshness.{json,ts}`, `proto/telemetry.proto` |
| `tools/argo/` | Argo device agent (Go module, standard library only), see §6 |
| `ml/` | Kp model training (`ml/train/`), inference server (`ml/infer/infer_server.py`) |
| `website/` | Public website, one Cloudflare Worker (`website/README.md`) |
| `requirements/` | Requirements baseline (`requirements.json`) and FMEA (`fmea.json`) |
| `scripts/` | `ops/gauss-services.sh` (services, gates, deploy), `verify/` (VCRM gate), `release/`, `trust/`, `replay/`, `worktree/` |
| `tests/e2e/` | Playwright specs |
| `docs/` | This page, ADRs (`docs/adr/`), OpenAPI (`docs/api/openapi.json`), archive |
| Legacy | `supabase/migrations/` (SQL only; database access removed, `backend/server.ts`), `binding.gyp` (native MHD build) |

## 3. Backend

### 3.1 Request pipeline (`backend/server.ts`)
Mount order matters:
1. `/health`, `/api/sso-options`
2. `/api/mesh` agent routes (Argo device token, §3.6)
3. `/api/v1` commerce data API (organisation API keys, `backend/commerce/`)
4. better-auth session (`backend/better-auth.ts`, SQLite)
5. `enforceApiPolicy` (`backend/rbac.ts`)
6. UI routes: `/api/orgs`, `/api/pilot-requests`, `/api/mesh` UI, `/api/rag/*`, `/api/device`, feeds

WebSockets: `/ws/feed/space-weather`, `/ws/feed/mms-reconnection` (`backend/lib/ws-upgrade.ts`).

### 3.2 Access control
- **`API_POLICY` allowlist** (`backend/rbac.ts`): no session → 401 for every non-public path (sign-in runs first, so anonymous callers cannot enumerate routes); signed in: unlisted route → 404, wrong
  role → 403. Roles rank user < staff < operator < admin (`backend/auth.ts`, `roleSatisfies`);
  new accounts are `user`.

  | Role | Route groups |
  |---|---|
  | public | `GET /feed/space-weather/latest`, `GET /system/connectivity`, `POST /pilot-requests` |
  | user | space-weather feeds (5 s, proto), space objects, aurora map, MMS, source status, world state, pipeline, anomaly forecast, own devices, own organisation keys and usage |
  | staff | `/mesh/onboarding`, `/mesh/devices` |
  | operator | `/rag/*`, CyberTiger status, `/system/tpm`, `/swx/structures`, nowcast inference, device swap plan, device quality |
  | admin | CyberTiger events/block/unblock, nowcast training |

  Outside the policy by design (comment in `backend/rbac.ts`): `/api/auth/*`, `/api/sso-options`,
  the Argo token routes (`/api/mesh/{report,bundles*,directory,keys}`) and `/api/v1/*`.
- **CyberTiger** (`backend/cybertiger/daemon.ts`): blocks a client IP after repeated auth failures
  (default 8 in 300 s). Consequence for the UI: never poll a route the role can't use (§4).
- **Device auth** (`backend/services/device-auth.ts`, `backend/device-registry.ts`): fails closed
  without a key.

### 3.3 Space-weather ingest and feed
1. `IngestionWorker` (`backend/worker/ingest-loop.ts`, 5 s tick, per-source rates and back-off)
   calls the adapters in `backend/adapters/`: `noaa-swpc` + `rtsw-series` (RTSW L1), `kyoto-dst`,
   `goes-particles`, `swpc-products` (cross-check only), `esa-hapi` (Swarm, never used as an IMF
   source: `docs/adr/swarm-not-an-imf-source.md`), `jaxa-erg` (reachability probe), `mms-cdaweb`,
   `mms-lasp`.
2. Sense checks (`backend/lib/sense-checks.ts`), then `computeCanonicalPoint`
   (`backend/physics/mhd-nowcast.ts`; also `igrf.ts`, `noaa-scales.ts`, `reconnection.ts`,
   `healpix.ts` aurora grid, `l1-structures.ts`).
3. `publish()` pushes to the in-memory feed (`backend/state.ts`) and appends to the bedrock store
   (`backend/lib/local-db.ts`, `telemetry.jsonl` under `GAUSS_BEDROCK_DIR`; retention in
   `backend/lib/telemetry-retention.ts`). On boot the feed reloads from bedrock.
4. The tick callback broadcasts over the WebSockets; REST `/api/feed/*` reads `state.ts`;
   `/api/v1` adds freshness (`shared/policy/freshness.ts`: stale after 15 min, REQ-ING-001).
   Wire format: `backend/lib/proto.ts` (`sw.point/2.0.0`).

Pending, not on main yet: canonical-telemetry validation at the sink (GAU-244, PR #277).

### 3.4 Trust records and evidence (`backend/trust/`)
Customer inference logs (CSV/JSON/JSONL) → `ingestLog` (`ingest.ts`, mappings in `mappings/`) →
`buildTrustRecord` (`record.ts`) over an `EnvironmentHistory` (`environment.ts`; replay from
`backend/replay/` or the live feed; `orbit.ts` L-shell, `saa.ts` SAA flag) → `buildEvidencePack`
(`evidence.ts`, PDF via `evidence-pdf.ts`) → Ed25519 signing (`signing.ts`, keys unlocked by
`key-lock.ts`). Live route: `POST /api/v1/data/trust/records` (`backend/commerce/routers.ts`).
CLIs: `scripts/trust/`. Pending: processor radiation profiles (GAU-58, PR #160) and the
Jetson/GPU log pack (GAU-245, PR #281).

### 3.5 Memory (RAG) and ML
- `/api/rag/{status,query}` (operator) → `backend/memory/client.ts` → the gauss-brain evidence
  memory sidecar on loopback (`docs/memory-sidecar.md`). It returns checksum-verified passages
  or abstains.
- `backend/ml-client/client.ts` → the local inference server (`ml/infer/infer_server.py`);
  nightly training in `ml/train/`.

### 3.6 Mesh hub (`backend/mesh/`)
- Reports: Argo `POST /api/mesh/report` → `parseReport` → `MeshStore` (`store.ts`; classes
  mirror `tools/argo/classify.go`) → `GET /api/mesh/devices` → `/mesh` page.
- Store-and-forward: `BundleStore` (`bundles.ts`) keeps BPv7 bundles as ciphertext plus public
  keys only; routes `/api/mesh/{bundles,directory,keys}` (`docs/ARGO_DTN.md`).

## 4. Frontend (`frontend/src/`)
- Entry `main.tsx` → `App` in `Cybertiger.tsx` (router + react-query).
- Routes: `/` public dashboard, `/login`, `/member`, `/heliophysics` and `/account/api` (user),
  `/mesh` (staff), `/operator` and `/protection` (operator); guarded by
  `components/ProtectedRoute.tsx` (`minRole`).
- Data hooks (`hooks/`): `useSpaceWeather`, `useSolarWind5s` (REST + WebSocket),
  `useMMSReconnection`, `useAuroraMap`, `useAnomalyForecast`, `usePipelineLatency`,
  `useSpaceObjects`, `useConnectivity`, `useL1Structures` (operator only), `useDeviceSwapPlan`,
  `useMesh`.
- Polling rule: every poll goes through `usePolledFeed` (`lib/api/feed-poller.ts`): one request
  at a time, back-off on 429/404/5xx/network, nothing while the tab is hidden, and a 401/403 stops
  polling until the session changes. A hook for a role-gated route must pass `path: null` when the
  role can't use it.
- 3D scene (`components/scene/`): `SpaceScene` (canvas), `Earth`, `Magnetosphere`
  (+ `useTracedMagnetosphere`), `VanAllenBelts`, `RadiationDataOverlay`, `MHDWaves`,
  `MMSReconnectionVectors`, `OrbitRings`, `SpaceObjectOverlay`, `ShaderWarmup`
  (`docs/SHADER_SPEC.md`, `docs/SCENE_RADIATION_VISUALIZATION.md`).

## 5. Data flow summary

| Flow | Path | Freshness / safety |
|---|---|---|
| Space weather | adapters → sense checks → canonical point → feed + bedrock → WS/REST → hooks → scene/HUD | stale after 15 min, never carried forward |
| Customer logs | file → `ingestLog` → trust record → evidence pack → signature | banned-wording check on limitation text |
| Device health | Argo → `/api/mesh/report` → `MeshStore` → `/mesh` | device token, staff+ to view |
| Store-and-forward | Argo relay → `/api/mesh/bundles` → peer Argo | hub sees ciphertext only |
| Evidence memory | approved docs → gauss-brain → `/api/rag` | operator only, abstains without evidence |

## 6. Argo (`tools/argo/`)
A device agent (macOS LaunchAgent) that keeps the operator's link usable on hotspots and public
Wi-Fi and reports device health to the hub. Diagnose: `classify.go` (OK, OFFLINE, CAPTIVE, DNS,
DEAD_PROXY, STALE_DAEMON, TLS_INTERCEPT, PORT_BLOCK, REGION, WPAD_RISK, WIFI_RISK). Remediate:
least-invasive ladder in `loop.go` (automatic actions only; admin actions never automatic),
`heal.go`. Resource guard / admission: `guard.go`. Alerts: `notify.go`, `phone.go`,
`attention.go`. Relay: `relay.go`, `hub.go`, `bundle.go`, `bpsec*.go`, `linkkeys.go`. Tests:
`tools/argo/check.sh`. Details: `tools/argo/README.md`.

## 7. Verification and delivery (CI)

GitHub Actions are billing-locked (`.github/dependabot.yml`), so the **local gate is the CI**.
The workflow files stay valid for when Actions return.

| Level (V-model) | What runs | Where |
|---|---|---|
| Unit | `npm test` (node:test, backend + frontend libs), Go tests in `tools/argo` | `package.json`, `tools/argo/check.sh` |
| Integration | ops tests (`scripts/ops/gauss-services.test.sh`), Argo relay end-to-end | `npm run test:ops`, `npm run test:argo-e2e` |
| Static | strict tsc on all projects, ESLint | `npm run quality:full` |
| Requirements | `npm run verify`: baseline well-formed → website tests → full tests (JUnit) → ops tests → build → VCRM + FMEA | `scripts/verify/verify.ts`, `requirements/` |
| System | deploy health check (backend, frontend, same-origin API, data live) | `gauss-services.sh check` |

- **Gate set**: `test:ops`, `quality:full`, `verify` (`GATES` in `scripts/ops/gauss-services.sh`).
  `verify` already runs the tests and the build.
- **Gate runner and merge train**: `gauss-services.sh gates enqueue <sha> [--pr N]` hands the run
  to one runner (one at a time, deduped by tree, records by tree). With `--pr` it merges main into
  the PR just before the run and merges the PR after a pass only when the PR is CLEAN, contains
  main, is not a draft and touches nothing under auth, crypto/TLS, secrets, CyberTiger or keys;
  those pass and wait for a human merge. `gates result <sha>` reads the record.
- **Deploy**: `gauss-services.sh deploy <sha>` refuses commits not on main or without a passing
  record, refreshes a fallback, switches live (keeping its data) and rolls back by itself if the
  services don't come up. `scripts/release/deploy.ts` (tag-based) is the older path.
- **PRs** follow `.github/pull_request_template.md`, including the Developer Score.

## 8. Requirements traceability
Each requirement in `requirements/requirements.json` has one "shall", a parent Linear issue, a
verification method (Test, Analysis, Inspection, Demonstration) and its evidence (exact test
names for T). `npm run verify` fails if a mapped test fails, is skipped or no longer exists, and
writes the VCRM to `test-results/verification/`. New behaviour needs a requirement and a mapped
test in the same PR. Argo's Go tests (short mode) are ingested by Go test name (REQ-ARG-001..003). Known coverage gap: the website tests are not yet
ingested into the VCRM.

From the same evidence the gate computes an implementation readiness score per requirement and per parent issue (`scripts/verify/readiness.ts`, read by `readiness-io.ts`; unit tests in `backend/lib/readiness.test.ts`), written to `test-results/verification/readiness.md` and `readiness.json`. It is report only. The parts are explained in `requirements/README.md`.

## 9. Documents that predate this layout
These describe earlier designs and are kept for history; trust this page and the code over them:
`IMPLEMENTATION_SUMMARY_1-4.md`, `AUTOMATIONS_5-9_GUIDE.md` (assume GitHub Actions),
`CRITICAL_BUGS_AND_FIXES.md` (names removed Neo4j code), `OFFLOAD_GUIDE.md`,
`CONTRIBUTING.md` (Lovable-era), `DEVELOPER_SCORING_AND_ONBOARDING.md` (links a missing
onboarding page). `SECURITY_AUTOMATION.md`, `SECURITY_QUICK_REFERENCE.md` and
`QUALITY_AND_TESTING_QUICK_REF.md` are current except where they assume GitHub Actions.
