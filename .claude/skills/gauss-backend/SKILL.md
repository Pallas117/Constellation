---
name: gauss-backend
description: Repo map, conventions, security rules and test commands for the Gauss Node/TypeScript backend (Express server, better-auth roles, NOAA/ESA/MMS/JAXA adapters, physics services, C++ MHD core, CCSDS boundary plans). Use before adding or changing backend routes, adapters, auth, persistence or backend tests.
---

# Gauss backend

## Map
| Area | Path | Notes |
|---|---|---|
| HTTP server | `backend/server.ts` | Express on :3001 (`npm run dev:proxy`). Feeds under `/api/feed/*`, AI under `/api/ai/*`, security under `/api/security/*`. |
| Auth / RBAC | `backend/auth.ts`, `backend/better-auth.ts` | Roles are cumulative: user (live visualisation) < staff (+ Mesh onboarding of own devices) < operator (+ operator console, team status) < admin (+ roles, any device). Legacy `viewer` maps to `user`. New accounts are `user`. Guard with `requireRole("operator")`. `npm run auth:set-role -- <email> <user\|staff\|operator\|admin>`. Google Workspace SSO when `GOOGLE_CLIENT_ID/SECRET` set, limited to `SSO_ALLOWED_DOMAIN`. Email/password sign-up is invite-only (`SIGNUP_ALLOWED_EMAILS`, empty = closed). |
| Feed adapters | `backend/adapters/{noaa-swpc,esa-hapi,mms-cdaweb,mms-lasp,jaxa-erg}.ts` | Treat upstream as untrusted: validate, clamp, tag source + timestamp. |
| Physics | `backend/physics/{coordinates,mhd-nowcast,reconnection,healpix,deconvolution}.ts` | `gseToGsm`, `geoToGsm`; MHD nowcast with C++ core in `backend/cpp/mhd_core.cpp` (node-gyp, `binding.gyp`). |
| State / ingest | `backend/state.ts`, `backend/worker/` | Bedrock data written to `data/bedrock/` (never read `*.jsonl` into context). |
| Mesh / devices | `backend/mesh/`, `backend/device-registry.ts`, `tools/argo/` (Go) | `data/mesh/` is never committed. |
| Wire format | `shared/proto/telemetry.proto` | Source of truth for a future XTCE/CCSDS Space Packet export (see ADR 0001). |

## Rules
- Node 26 (`.nvmrc`); native modules must be built with the Node that runs them.
- Never weaken TLS; no secrets in logs, URLs, query strings or commits; tokens go in headers.
- Each route states its access level in `API_POLICY` (`backend/rbac.ts`): unlisted routes answer 404, no session 401, wrong role 403. Unauthenticated routes (`access: "public"`) are an explicit allowlist; adding to it needs a stated reason.
- Never let the UI poll a route the current role can't use: CyberTiger counts 401/403s and auto-blocks the IP.
- Validate request bodies and adapter payloads at the boundary; return typed errors, not stack traces.
- Units and frames in field names or comments.

## Security self-check (before handing back; report each item as pass / n/a / fixed)
Built from the 17 Nov backend sweep (#292, #293, #294, plus #172 and #175).
1. **Access:** each new or changed route has an explicit level in `API_POLICY` (`backend/rbac.ts`), with tests for 401 (no session) and 403 (role too low). Routes outside the policy (auth, Argo token, `/api/v1`) have their own check, and a comment saying why.
2. **Mount order:** the route sits after the middleware it needs in `backend/server.ts` (session, `enforceApiPolicy`, CyberTiger). Anything mounted earlier gets its own rate limit and failure counting.
3. **Ownership:** device, org, mesh and file routes check owner or admin on the server for every path and verb, never trusting an id from the client.
4. **No self-attested trust:** a client can never set its own status, role, plan, "verified" or "trusted" flag. Status fields accept an enum, and only the proof or admin path raises trust. This was #292's bug.
5. **Client address:** rate limits, CyberTiger and stored IP hashes use CyberTiger's `extractClientIp` (X-Forwarded-For only from the local proxy, last hop), never `req.ip` (always 127.0.0.1 behind the proxy). This was #294's bug.
6. **Bounded memory:** every Map, array or registry that grows with clients, IPs, devices or requests has a cap and a sweep (the 8 GB host). Body and frame sizes are capped (`express.json` limit, `ws` `maxPayload`). These were #172's and #293's bugs.
7. **WebSockets:** origin, session and role are checked in the upgrade handler before `handleUpgrade`. Sessions that expire or lose their role are closed.
8. **Errors:** responses never carry `error.message`, stacks, upstream URLs or paths. A CORS refusal gives no CORS headers, not a 500. Details go to the log without secrets, tokens, emails or query text.
9. **Inputs:** payloads are validated at the boundary (types, enums, lengths, flat objects for free-form fields). No path built from input without an allowlisted name. Secret compares use `timingSafeEqual`, and fetch URLs never come from a request (no SSRF).
10. **Tests and requirements:** each item that applies has a test. Requirements (`REQ-SEC-*`) map to them by exact name, and the PR lists the self-check results. A change to auth, RBAC, crypto, CyberTiger or keys says "Josh merges".

## Tests
- Single file while iterating: `node --import tsx --import ./backend/test-setup.ts --test backend/<path>.test.ts`
- Full: `npm test` (node:test, temp bedrock dir), types: `npm run lint`, gate: `npm run audit:adherence`.
- Go tool: `cd tools/argo && go test ./...`.
- GitHub Actions are billing-locked: local results are the gate, and must be pasted into the PR.

## Interop direction (ADR 0001)
Keep the ground stack on Node/TS. Add CCSDS at the boundary: Space Packet (133.0-B-2) encoder/decoder plus an XTCE definition generated from `telemetry.proto`; consider CFDP for file products. Any onboard component is a cFS app in C (or an F´ component), not Node.
