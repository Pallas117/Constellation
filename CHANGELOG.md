# Changelog

Notable changes to Gauss Aurora, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and versions follow [semantic versioning](docs/RELEASE_CHECKLIST.md). `npm run release:tag -- vX.Y.Z` refuses a tag
that has no `## [X.Y.Z]` entry here. Every line cites its pull request; the complete list is the
[merged pull requests](https://github.com/Pallas117/Constellation/pulls?q=is%3Apr+is%3Amerged).

## [Unreleased]

Nothing has been tagged yet. The first release is planned as v0.1.0, Fleet Integration v0.1 (milestone M1).
Before tagging, move these entries under `## [0.1.0] - <date>`.

### Added

- Inference trust records: the record engine (#115), `POST /api/v1/data/trust/records` on the metered data API (#116),
  SGP4 orbit context from TLEs (#122), and a South Atlantic Anomaly flag from IGRF-14 |B| (#128).
- Customer inference-log ingest (CSV, JSON, JSONL) with per-row provenance; every row is accepted or rejected with a
  reason (#126).
- Space weather: separate radiation (S) and geomagnetic (G) storm streams (#101), a sense-check layer with a NOAA
  cross-check (#103), replay of past storms through the live pipeline (#106), and L1 structure detection (#117, #118,
  #124), validated on held-out events (#127) and shown in the operator console (#132).
- Typed temporal world-state contracts with deterministic ids and replay (#88).
- Verification: a requirements baseline, verification matrix and local `npm run verify` gate (#64); deploys only from
  verified tags, with a health check and automatic rollback (#69).
- Release records: `npm run release:sbom` writes CycloneDX SBOMs for the runtime npm dependencies and Gauss Argo,
  third-party notices, and a licence check that fails on copyleft or unknown licences (GAU-69).

### Changed

- Missing, stale, failed or assumed inputs are reported as unknown or derived, never as nominal or measured (#51,
  #65, #109); explicit unknown answers replace canned "verified" assessments (#26).
- Strict type checking and ESLint over the frontend, backend, tests and scripts (#87, #91, #102).

### Fixed

- No fabricated output: no random values presented as model output (#45), no invented GEO objects (#46), canonical
  Dst labelled as modelled (#50).
- Radiation: absorbed dose from stopping power in Gy(Si) with cited alert thresholds (#16); native MHD kernels in
  double precision, matching the TypeScript path (#96); an unused magnetic-field estimate that was 10^7 too high was
  removed (#114).
- Telemetry store: bounded tail reads, corrupt lines skipped, buffer reloaded on restart (#59).

### Security

- Access control: role-based auth (#9); RAG, CORS and device-ownership holes closed (#10); a production auth guard
  (#63); post-login redirect guarded (#27).
- Device authentication fails closed without its secret (#39), uses one canonical proof timestamp (#40) and accepts
  each proof once (#41).
- Graph client input validation, safer Neo4j defaults and inference request limits (#72).
- Dependencies with known vulnerabilities updated; Gauss Argo built with Go 1.26.10 (#135).
- Fonts are served by the site, not Google: no visitor's address goes to a third party and no outside request can
  stall a page load. Their OFL-1.1 licence ships beside them and the release licence check recognises it (#142).
