# Gauss pilot: install and runbook (Fleet Integration v0.1)

For the engineer running a single-tenant Gauss pilot on their own machine or VM. The API
reference is [`docs/api/openapi.json`](api/openapi.json) (OpenAPI 3.1). Anything marked
**UNVERIFIED** has not been tested by us on that setup; ask Lightbound before relying on it.

## 1. What runs

- **Backend** (`backend/server.ts`), on 127.0.0.1:3001. Every 5 s it builds a refined
  space-weather point from public feeds and stores it. It serves the data API, trust records and
  sign-in.
- **Web app**, built once and served by `vite preview` on 127.0.0.1:8080. It forwards `/api` and
  `/ws` to the backend (`frontend/vite.config.ts`).
- **State** lives in two SQLite files and local directories (section 8). No external database
  or cloud service is needed.
- **Network**: outbound HTTPS only, to the public data providers: `services.swpc.noaa.gov`
  (NOAA SWPC: L1 solar wind, GOES, Kp, Kyoto Dst), `vires.services` (ESA), `cdaweb.gsfc.nasa.gov`
  and `lasp.colorado.edu` (NASA MMS), `darts.isas.jaxa.jp` (JAXA ERG). No inbound port is needed;
  you choose who can reach the web app.

## 2. Prerequisites

| Need | Detail |
|---|---|
| Node.js 22 | Pinned in `.nvmrc`. Install and run with the same Node: `better-sqlite3` is a native module built for the Node that installs it. |
| git | To fetch releases. |
| OS | macOS is the reference install. Linux (x86-64 or arm64) is expected to work, as the stack is Node and SQLite only: **UNVERIFIED**. Windows is not supported. |
| RAM | The running stack peaks at about 0.65 GB (measured on the reference install). Allow 2 GB: the backend-memory measure turns amber at 1 GB and red at 2 GB (`backend/lib/tpm.ts`), and `npm ci` and the build need more than running does. |
| Disk | Telemetry grows about 14-23 GB a year (measured). Keep at least 10 GB free on the data volume at all times (the disk measure turns amber at 10 GB free, red at 3 GB). For a one-year pilot, plan on 40 GB or more for data, plus the code and dependencies (a few GB, **UNVERIFIED**). |
| Optional | `sqlite3` command-line tool for online backups; `python3` only for the nightly model retraining in `ml/`, which the API does not need. |

Run everything as an ordinary user. No step needs root.

## 3. Get the code at a release

```sh
git clone <repository URL from Lightbound> gauss
cd gauss
git checkout <release tag>     # vX.Y.Z (scripts/release/create-tag.sh); the first tag is still pending
nvm use                        # or select Node 26 another way
npm ci
```

## 4. Configure

Settings go in `.env` in the checkout root; `npm run dev:proxy`, `npm run org` and the
`npm run auth:*` scripts read it (`--env-file-if-exists=.env` in `package.json`).
`.env.example` lists the names. `npm run env:check` lists names missing from your `.env`
without printing values; `npm run check:backend-env` shows backend settings with secrets
masked. Run `chmod 600 .env`. Never commit `.env` (it is git-ignored), never paste it into a
ticket, and never put a key or secret in a URL.

**Keep data outside the checkout.** The repository tracks a sample `data/bedrock/telemetry.jsonl`;
a backend writing there makes `git checkout` of a new release fail. Point the four storage
variables below at a data directory of your choice.

| Variable | Default | Secret | Purpose |
|---|---|---|---|
| `NODE_ENV` | unset | no | Set `production`: the sign-in bypass can never apply and only `ALLOWED_ORIGINS` are accepted (`backend/auth.ts`, `backend/server.ts`). The reference install does not set it, so production mode end to end is **UNVERIFIED**. |
| `PROXY_HOST` / `PROXY_PORT` | `127.0.0.1` / `3001` | no | Backend address. Keep loopback; the server warns on `0.0.0.0`. |
| `ALLOWED_ORIGINS` | `http://localhost:8080,http://localhost:5173,http://127.0.0.1:5173,http://127.0.0.1:8080` | no | Comma-separated origins allowed by CORS and sign-in. Include the exact URL people open. |
| `BETTER_AUTH_URL` | unset | no | The URL people open. Read by the better-auth library, which warns when it is unset. |
| `BETTER_AUTH_SECRET` | unset | **yes** | Long random value that signs sessions. Read by better-auth itself, not by Gauss code; required in production per better-auth's documentation (**UNVERIFIED** here). |
| `AUTH_REQUIRED` | `true` | no | Never set `false`: that bypass makes every visitor an admin. Ignored when `NODE_ENV=production`. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | unset | **secret: the `_SECRET`** | Google sign-in, on only when both are set. Callback: `<BETTER_AUTH_URL>/api/auth/callback/google`. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | unset | **secret: the `_SECRET`** | GitHub sign-in, as above, callback `.../github`. |
| `SSO_ALLOWED_DOMAIN` | Lightbound's own domain | no | Single sign-on may create accounts only for this email domain: set yours if SSO is on (`backend/sso-policy.ts`). |
| `SSO_ALLOWED_EMAILS` | empty | no | Extra individual addresses allowed through SSO. |
| `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` | unset | no | One Lightbound login: the Cloudflare Access team (`<team>.cloudflareaccess.com`) and the app's AUD tag. With both set, the login page offers **Continue with Lightbound** (`backend/lightbound-sign-in.ts`, docs/ONE_LOGIN.md). |
| `GAUSS_BEDROCK_DIR` | `data/bedrock` in the checkout | no | Telemetry: `telemetry.jsonl` and `archive/`. |
| `GAUSS_TELEMETRY_KEEP_LINES` | `40000` (minimum 25000) | no | Lines kept live, about 3 days; older lines move to `archive/` (`backend/lib/telemetry-retention.ts`). |
| `GAUSS_TELEMETRY_ARCHIVE_HOURS` | `24` | no | Hours between archive runs; `0` turns archiving off. |
| `COMMERCE_DB_PATH` | `data/commerce/commerce.db` (relative to the working directory) | file is sensitive | Organisations, API-key hashes, usage, trust-record log. |
| `MESH_STORE_PATH` / `MESH_BUNDLE_PATH` | `data/mesh/devices.json` / `data/mesh/bundles` | files are sensitive | Argo device registry and bundles; unused unless you enrol Argo devices. |
| `CYBERTIGER_ENABLED` | `true` | no | The intrusion guard on every `/api` request. Keep it on. |
| `CYBERTIGER_RATE_LIMIT_MAX` / `_WINDOW_MS` | `120` / `60000` | no | Requests per IP per window, across all of `/api`. |
| `CYBERTIGER_AUTH_FAILURE_THRESHOLD` / `_WINDOW_MS` | `8` / `300000` | no | This many 401/403 responses from one IP in the window block it... |
| `CYBERTIGER_AUTO_BLOCK_SECONDS` | `900` | no | ...for this long. |
| `CYBERTIGER_MAX_EVENTS` | `5000` | no | Security events kept in memory. |
| `DEVICE_AUTH_SECRET` | unset | **yes** | 32 or more random characters; device proofs are off while unset. `DEVICE_PROOF_TTL_MS` (default `60000`) sets their lifetime. |
| `LOCAL_INFER_URL` | unset | no | External ML inference service; unset uses the built-in heuristic nowcast. |
| `GAUSS_MEMORY_URL` | `http://127.0.0.1:3002` | no | Knowledge-memory sidecar for the operator console (loopback only). Set `off` if you don't run it; the console then hides its search panel. |
| `GAUSS_MMS` | on | no | MMS CDAWeb polling every 10 min, which feeds the reconnection vectors. `0` stops it and drops MMS from the source status. |
| `GAUSS_LASP` | on | no | MMS LASP SDC burst-window polling every 60 s. Only its reachability is used (source status); `0` stops it and drops it from the source status. |
| `GAUSS_SWAP_TIMER` | on | no | Device swap rebalance every `SWAP_BALANCE_INTERVAL_MS`; a tick does nothing while no device is registered. `0` stops it, and with it the automatic `needs_reauth` for devices whose health score falls below 45. |
| `GAUSS_NATIVE_MHD` | off | no | `1` loads the optional C++ MHD kernel. Build it first with `npm run build:native` (needs a C++ toolchain); installs no longer build it. The TypeScript formulas give the same numbers. |
| `GAUSS_BACKEND_URL` | `http://127.0.0.1:3001` | no | Backend address for `npm run tpm`. Set it in that command's environment: `npm run tpm` does not read `.env`. |
| `GAUSS_API_TARGET` | `http://127.0.0.1:3001` | no | Where the web app forwards `/api` and `/ws`. Set it in the environment of `npm run preview`, which does not read it from `.env`. |

Leave these unset for a data-API pilot: `OFFICIAL_SOURCES_ONLY` (`false`), `MESH_EXIT_NODES`,
`TRAINING_SCRIPT_PATH` (`ml/train/train_kp.py`), `CLOSED_LOOP_SCRIPT` (`scripts/closed-loop.sh`),
`SWAP_BALANCE_INTERVAL_MS` (`45000`), `DEVICE_SWAP_THERMAL_THRESHOLD_C` (`70`),
`DEVICE_SWAP_DEFAULT_COMPUTE_PERCENT` (`70`), `DEVICE_SWAP_DEFAULT_POWER_W` (`120`). The
`SUPABASE_*` and `VITE_SUPABASE_*` names are legacy and unused by the pilot stack.

## 5. First start

```sh
npm run auth:migrate                        # creates the sign-in tables in .auth.db; safe to re-run
npm run check:backend-env
VITE_HELIO_PROXY_URL=same-origin npm run build
npm run dev:proxy                           # the backend entry point, despite the name
npm run preview                             # in a second terminal: web app on 127.0.0.1:8080
```

Open http://127.0.0.1:8080 and create your account. Make yourself admin with
`npm run auth:set-role -- <email> admin`. Roles build on each other: `user` (live view, own API
keys) < `staff` < `operator` (operator console) < `admin`. New accounts start as `user`.

To keep it running, put both commands under your process supervisor (systemd, launchd) as an
ordinary user, working directory = the checkout, restart on failure, output to a log file.
`scripts/ops/gauss-services.sh` is our own macOS setup; read it as an example, don't run it as is.

To reach the web app from other machines, put your own TLS reverse proxy on the same host in
front of 127.0.0.1:8080 and have it set `X-Forwarded-For` (CyberTiger trusts that header only
from a loopback peer, so per-client limits keep working). Add the HTTPS URL to `ALLOWED_ORIGINS`
and `BETTER_AUTH_URL`. `vite preview` accepts only local and Tailscale host names
(`preview.allowedHosts` in `frontend/vite.config.ts`), so the proxy must send
`Host: 127.0.0.1:8080` or that list must be extended. Remote access this way is **UNVERIFIED**;
agree the setup with Lightbound.

## 6. Health checks

- `curl -s http://127.0.0.1:3001/health` returns `{"ok":true,"timestamp":"…","tpm":{"status":"green","red":[]}}`.
  It needs no credentials and shows no values. `ok` is true whenever the process answers; judge
  health by `tpm.status` (`green`, `amber`, `red`, `insufficient`) and the ids in `red`.
- `npm run tpm` (or `npm run tpm -- --url <backend URL>`) exits 0 for green or insufficient,
  1 amber, 2 red, 3 unreachable. Use it from your monitoring. `insufficient` is normal for a
  while after start, until every measure has a value (forecast skill needs resolved forecasts).
- Data is flowing (key in an environment variable, never on the command line or in a URL):
  `curl -s -H "Authorization: Bearer $GAUSS_API_KEY" http://127.0.0.1:3001/api/v1/data/sources/status`
  shows each upstream source's health; `/api/v1/data/space-weather/latest` returns the newest
  point. In a point, `quality.tier` 0 is live and 3 is stale: treat tier-3 values as unknown.
- Measure values (data age, tick latency, disk, memory and so on) are at `GET /api/system/tpm`
  for the `operator` role.

## 7. API keys and metering

Plans are in `backend/commerce/plans.ts`. `pilot`: 60 requests a minute per key, 50,000 a day per
organisation (UTC day), history up to 24 h. `free` has no API access. CyberTiger's per-IP limit
(120 a minute by default) applies on top, across all `/api` calls from one address.

1. Admin creates the organisation: `npm run org -- create "<organisation name>" pilot` (prints its
   id; `npm run org -- list` shows all).
2. Each person signs in once, then the admin adds them: `npm run org -- add-member <org-id> <email>`.
3. A member creates a key in the web app at `/account/api`, or with `POST /api/orgs/{orgId}/keys`.
   The key is shown once; Gauss keeps only its SHA-256. Put it in your secret manager.
4. Calls send `Authorization: Bearer gk_…`. Revoke a key in the same page or with
   `DELETE /api/orgs/{orgId}/keys/{keyId}`; it stops working at once.

Metering, as the code does it: every successful (`status < 400`) `/api/v1` call is counted per UTC
day, key and route (`GET /api/orgs/{orgId}/usage`, or `npm run org -- usage <org-id> [YYYY-MM]`).
Every trust record returned is logged once, by spacecraft and month, in a table the database
refuses to change or delete; export it with
`npm run org -- usage-csv <org-id> <from YYYY-MM> [to YYYY-MM] > usage.csv`. If that log can't be
written, the API returns 500 and issues no records, so a retry never double-counts.

Customer-log ingest and evidence packs (`npm run trust:ingest`, `npm run trust:verify`; usage in
the header of each script under `scripts/trust/`) run offline. They don't call the API and are
not metered.

## 8. Backup and restore

| State | Where | Holds |
|---|---|---|
| Sign-in database | `.auth.db` in the checkout root (fixed path, `backend/better-auth.ts`) | Accounts, emails, password hashes, sessions, roles |
| Commerce database | `COMMERCE_DB_PATH`, with `-wal` and `-shm` files beside it | Organisations, members, API-key hashes, usage, trust-record log |
| Telemetry | `GAUSS_BEDROCK_DIR`: `telemetry.jsonl` and `archive/` (gzip files and their manifest) | Refined telemetry; on start the backend reloads the last 24 h from here |
| Mesh store | `MESH_STORE_PATH`, `MESH_BUNDLE_PATH` | Argo devices (hashed tokens) and bundles, if used |
| Configuration | `.env` | Secrets: keep them in your secret manager, not in the data backup |

Back up nightly and before every upgrade:

```sh
sqlite3 .auth.db ".backup '<backup dir>/auth.db'"                # consistent copy while running
sqlite3 "$COMMERCE_DB_PATH" ".backup '<backup dir>/commerce.db'"
```

Or stop the backend and copy the files, including `commerce.db-wal` and `commerce.db-shm`.
Archives can be copied at any time, skipping hidden `*.part` files: each archive is written to
one and renamed only when complete. Copy `telemetry.jsonl` and the mesh files while the backend
is stopped, or accept that the last line may be cut. Backups hold personal data and credential hashes: encrypt them and
limit who can read them.

Restore: stop both services; put each file back at the path its variable names; delete any old
`commerce.db-wal` and `commerce.db-shm` beside a restored `commerce.db`; start; check `/health`,
sign in, and run `npm run org -- list`.

Never run `git clean -x` in the checkout: it deletes `.auth.db` and `.env`.

## 9. Upgrade

1. Back up (section 8).
2. `git fetch --tags && git checkout <new tag>`, and read its release notes.
3. If `.nvmrc` changed, switch Node. Then `npm ci`.
4. `npm run env:check` for new variable names, then `npm run auth:migrate`.
5. `VITE_HELIO_PROXY_URL=same-origin npm run build`.
6. Restart the backend, then the web app, and run the health checks.

The commerce database adds missing tables itself at start (`backend/commerce/store.ts`); no other
migration step exists today. To roll back, check out the previous tag and repeat steps 3-6; if
the new version already wrote to the databases, restore the pre-upgrade backup (anything written
since is lost).

## 10. Troubleshooting

- **`npm run tpm` says unreachable (exit 3):** the backend is not running or listens elsewhere.
  Check its log and `PROXY_PORT`.
- **Error mentioning `NODE_MODULE_VERSION` or "compiled against a different Node.js version":**
  dependencies were installed with another Node. Select Node 26 and run `npm ci` again.
- **Sign-in fails with "Invalid origin":** the URL in the browser is not in `ALLOWED_ORIGINS`.
- **401 from `/api/v1`:** key missing, mistyped or revoked, or the `Bearer ` prefix is missing.
  Stop retrying: by default 8 failures in 5 minutes block your IP for 15 minutes (requests made
  directly on the same machine are never blocked). Blocks are held
  in memory; they expire, end when the backend restarts, or an admin can lift one
  (`POST /api/security/cybertiger/unblock`, admin role).
- **403 "plan does not include API access":** the organisation is on `free`:
  `npm run org -- plan <org-id> pilot`.
- **429:** with `Retry-After`, the per-key minute limit; "Daily quota", resets at 00:00 UTC; with a
  `requestId`, CyberTiger's per-IP limit.
- **404 "No data yet" from `/latest`:** the first ingest has not finished. Check
  `/api/v1/data/sources/status` and outbound HTTPS to the providers in section 1.
- **TPM amber or red:** `data_age` or `official_sources_down` = upstream unreachable (firewall,
  provider outage); `disk_free` = free space or move old archives elsewhere; `persist_failures` =
  disk or permissions on `GAUSS_BEDROCK_DIR`; `loop_liveness` or `tick_p95` = CPU starved;
  `memory_rss` = restart and report it.
- **500 on a POST:** "Internal server error" means the body was not valid JSON or was over 2 MB;
  "Could not record usage" means the commerce database is not writable (disk, permissions);
  nothing was issued, so retrying is safe.
- **`git checkout` refuses because of `data/bedrock/telemetry.jsonl`:** the backend is writing
  inside the checkout. Stop it, copy the file into your data directory, set `GAUSS_BEDROCK_DIR`,
  then `git checkout -- data/bedrock/telemetry.jsonl` and continue.

When reporting a problem, include the `x-request-id` response header and the TPM status. Never
send `.env`, database files, API keys or session cookies.
