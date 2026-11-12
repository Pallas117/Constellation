# Changelog

Notable changes to Gauss Aurora, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [semantic versioning](docs/RELEASE_CHECKLIST.md). `npm run release:tag -- vX.Y.Z` refuses a tag
that has no `## [X.Y.Z]` entry here. Every line cites its pull request; the complete list is the
[merged pull requests](https://github.com/Pallas117/Constellation/pulls?q=is%3Apr+is%3Amerged).

## [Unreleased]

Nothing has been tagged yet. The first release is planned as v0.1.0, Fleet Integration v0.1 (milestone M1).
Before tagging, move these entries under `## [0.1.0] - <date>`.

### Added

- Argo third-party registry: every outside service as a node with what it can see, its scopes, where its credential
  lives and where to revoke it; `argo thirdparty check` flags new, changed and unregistered services (#219).
- Inference trust records: the record engine (#115), `POST /api/v1/data/trust/records` on the metered data API (#116),
  SGP4 orbit context from TLEs (#122), and a South Atlantic Anomaly flag from IGRF-14 |B| (#128).
- Ed25519 signing of evidence packs and release files, with one offline verify command for customers (#161), and the
  first published evidence-pack and release keys (#197), which can be locked under a pattern drawn on a rotating
  tesseract (#200).
- Customer inference-log ingest (CSV, JSON, JSONL) with per-row provenance; every row is accepted or rejected with a
  reason (#126).
- Space weather: separate radiation (S) and geomagnetic (G) storm streams (#101), a sense-check layer with a NOAA
  cross-check (#103), replay of past storms through the live pipeline (#106), and L1 structure detection (#117, #118,
  #124), validated on held-out events (#127) and shown in the operator console (#132).
- Typed temporal world-state contracts with deterministic ids and replay (#88).
- Verification: a requirements baseline, verification matrix and local `npm run verify` gate (#64); deploys only from
  verified tags, with a health check and automatic rollback (#69).
- Release records: `npm run release:sbom` writes CycloneDX SBOMs for the runtime npm dependencies and Gauss Argo,
  third-party notices, and a licence check that fails on copyleft or unknown licences (#140).
- Argo egress log: `argo egress` shows what Argo sent off the device and where, kept on the device; `argo egress off`
  holds third-party sends until `on`; `argo phone imessage|sms` chooses who carries alerts (#215).
- Evidence packs: one per analysis window, as hash-chained JSON plus a deterministic PDF, holding the trust records
  and the SHA-256 of each stored input (#131).
- Trust-record metering per spacecraft-month: every record returned to a customer is logged in an append-only table
  (the database refuses updates and deletes), with CSV export (#170).
- An OpenAPI 3.1 spec for the `/api/v1` data API with a drift test (#147), now covering every pilot route, plus a
  customer install and runbook guide (#193).
- Telemetry retention: archive-first trimming that verifies the archive before touching the live file (#121), run
  daily to keep about 3 days live and every archive (#179).
- Gauss Argo: delay-tolerant file sharing between enrolled devices over Bundle Protocol v7, signed and end-to-end
  encrypted, through the Gauss hub (#153); RFC 9173 security contexts for working with standard DTN nodes (#158) and
  per-link keys on the relay (#210); per-network privacy, speed and signal scores (#134); a resource guard with memory
  and battery risk levels (#150), learned job sizing (#162, #183), pause on battery (#185) and a power budget (#204);
  rejoining when offline and choosing the best saved network in range (#202, #207); an app data watch (#191); and
  self-healing blocker episodes (#234).
- Operations: a structured ops event log (#144); deploys only from `origin/main` with a gate record for the exact
  tree, a deploy history (#146) and a kept fallback (#221); a detached gate queue and merge train (#182, #218).
- Verification: ops behaviour in the VCRM and FMEA, REQ-OPS-004..007 and FM-20..24 (#155).

### Changed

- Missing, stale, failed or assumed inputs are reported as unknown or derived, never as nominal or measured (#51,
  #65, #109); explicit unknown answers replace canned "verified" assessments (#26).
- Strict type checking and ESLint over the frontend, backend, tests and scripts (#87, #91, #102).
- `npm run alerts:watch` keeps alerts on the machine; raw log lines no longer go to Slack or Linear, and phone alerts
  through Argo are opt-in (`ALERTS_VIA_ARGO=1`) (#215). Wrangler usage metrics are off for the website (#215).
- One freshness policy, `shared/policy/freshness.json`, sets the maximum age of every measured quantity on every
  surface, where 18 places had their own numbers (#190).
- Node 26 LTS, as Node 25 reached end of life (#208).
- Lower memory and CPU: duplicate feed buffers dropped (#181), the aurora grid reused while its inputs are unchanged
  (#192), the backend run as prebuilt JavaScript (#194), and indexed feed lookbacks with a streamed 24 h backfill
  (#225).
- Argo sail mark, Gauss app icon and console mark, and the Brand Book colours in the app (#235).

### Removed
- Unused Supabase and Neo4j leftovers: the `@supabase/supabase-js` and `neo4j-driver` packages, the client modules nothing imported, the Supabase-era `setup:rbac` / `test:rbac` scripts (roles: `npm run auth:set-role`; RBAC tests: `npm test`), the Neo4j seed script and compose file, and their env names (#136).

### Fixed

- API: a request body that is not valid JSON answers 400, and one over 2 MB answers 413, where both were 500; a
  rejected body is no longer written to the log (#258).
- No fabricated output: no random values presented as model output (#45), no invented GEO objects (#46), canonical
  Dst labelled as modelled (#50).
- Radiation: absorbed dose from stopping power in Gy(Si) with cited alert thresholds (#16); native MHD kernels in
  double precision, matching the TypeScript path (#96); an unused magnetic-field estimate that was 10^7 too high was
  removed (#114).
- Telemetry store: bounded tail reads, corrupt lines skipped, buffer reloaded on restart (#59).
- Live-feed WebSockets stay connected: one upgrade router instead of two servers that each rejected the other's
  sockets (#163).
- The protobuf feed keeps every field, with unknown values absent rather than zero, in double precision (#184).
- Kp: a missing value stays unknown, never 2 (#195); a stale value expires in the nowcast, and NOAA L1 data is kept
  when Kp is missing (#232).
- Newell coupling was zero whenever IMF By was negative (#174).
- One lost ping no longer stops every external data fetch, and the link log records only changes (#228).
- Memory: stalled feed sockets are detected, ingest retries cancel, and GPU buffers are released (#171).
- Operator app: pollers stop on 401/403 instead of tripping CyberTiger, readouts say only what they know, and
  revoking an API key or device and rebalancing SWAP ask for confirmation (#236); two misleading lines of app copy
  corrected (#201).
- End-to-end tests run against the production build with no network (#137).

### Security

- Access control: role-based auth (#9); RAG, CORS and device-ownership holes closed (#10); a production auth guard
  (#63); post-login redirect guarded (#27).
- Device authentication fails closed without its secret (#39), uses one canonical proof timestamp (#40) and accepts
  each proof once (#41).
- Graph client input validation, safer Neo4j defaults and inference request limits (#72).
- Dependencies with known vulnerabilities updated; Gauss Argo built with Go 1.26.10 (#135); zod 4 and body-parser
  for high-severity advisories (#226); grouped Dependabot updates with a cooldown (#176).
- Fonts are served by the site, not Google: no visitor's address goes to a third party and no outside request can
  stall a page load. Their OFL-1.1 licence ships beside them and the release licence check recognises it (#142).
