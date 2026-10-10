---
name: gauss-backend
description: Repo map, conventions, security rules and test commands for the Gauss Node/TypeScript backend (Express server, better-auth roles, NOAA/ESA/MMS/JAXA adapters, physics services, C++ MHD core, CCSDS boundary plans). Use before adding or changing backend routes, adapters, auth, persistence or backend tests.
---

# Gauss backend

## Map
| Area | Path | Notes |
|---|---|---|
| HTTP server | `backend/server.ts` | Express on :3001 (`npm run dev:proxy`). Feeds under `/api/feed/*`, AI under `/api/ai/*`, security under `/api/security/*`. |
| Auth / RBAC | `backend/auth.ts`, `backend/better-auth.ts` | Roles are cumulative: user (live visualisation) < staff (+ Mesh onboarding of own devices) < operator (+ operator console, team status) < admin (+ roles, any device). Legacy `viewer` maps to `user`. New accounts are `user`. Guard with `requireRole("operator")`. `npm run auth:set-role -- <email> <user\|staff\|operator\|admin>`. Google Workspace SSO when `GOOGLE_CLIENT_ID/SECRET` set, limited to `SSO_ALLOWED_DOMAIN`. |
| Feed adapters | `backend/adapters/{noaa-swpc,esa-hapi,mms-cdaweb,mms-lasp,jaxa-erg}.ts` | Treat upstream as untrusted: validate, clamp, tag source + timestamp. |
| Physics | `backend/physics/{coordinates,mhd-nowcast,reconnection,healpix,deconvolution}.ts` | `gseToGsm`, `geoToGsm`; MHD nowcast with C++ core in `backend/cpp/mhd_core.cpp` (node-gyp, `binding.gyp`). |
| State / ingest | `backend/state.ts`, `backend/worker/` | Bedrock data written to `data/bedrock/` (never read `*.jsonl` into context). |
| Mesh / devices | `backend/mesh/`, `backend/device-registry.ts`, `tools/argo/` (Go) | `data/mesh/` is never committed. |
| Wire format | `shared/proto/telemetry.proto` | Source of truth for a future XTCE/CCSDS Space Packet export (see ADR 0001). |

## Rules
- Node 22 (`.nvmrc`); native modules must be built with the Node that runs them.
- Never weaken TLS; no secrets in logs, URLs, query strings or commits; tokens go in headers.
- Each route states its access level. Unauthenticated GETs are an explicit allowlist: `PUBLIC_READ_PATHS` in `backend/server.ts`; adding to it needs a stated reason.
- Never let the UI poll a route the current role can't use: CyberTiger counts 401/403s and auto-blocks the IP.
- Validate request bodies and adapter payloads at the boundary; return typed errors, not stack traces.
- Units and frames in field names or comments.

## Tests
- Single file while iterating: `node --import tsx --import ./backend/test-setup.ts --test backend/<path>.test.ts`
- Full: `npm test` (node:test, temp bedrock dir), types: `npm run lint`, gate: `npm run audit:adherence`.
- Go tool: `cd tools/argo && go test ./...`.
- GitHub Actions are billing-locked: local results are the gate, and must be pasted into the PR.

## Interop direction (ADR 0001)
Keep the ground stack on Node/TS. Add CCSDS at the boundary: Space Packet (133.0-B-2) encoder/decoder plus an XTCE definition generated from `telemetry.proto`; consider CFDP for file products. Any onboard component is a cFS app in C (or an F´ component), not Node.
