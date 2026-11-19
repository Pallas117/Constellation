# Requirements baseline and verification

This folder holds the Constellation requirements baseline. It follows the NASA Systems Engineering Handbook (SP-2016-6105 Rev 2): requirements management (§6.2) and verification (§5.3).

- **`requirements.json`:** one entry per requirement, with:
  - `id` (`REQ-ABC-001`);
  - a **"shall"** statement;
  - its rationale;
  - its `parent` (Linear issue);
  - an `owner`;
  - a verification `method`: **T**est, **A**nalysis, **I**nspection or **D**emonstration;
  - its evidence: exact test names in `verifiedBy` for T, or repo paths in `evidence` for A, I and D.
- **`npm run verify`:** the local gate. GitHub Actions is billing-locked, so this is what a commit must pass before merge or deploy. It checks:
  - the baseline is well-formed;
  - the full test suite passes;
  - the ops tests (`scripts/ops/gauss-services.test.sh` and `scripts/ops/vps/vps-kit.test.sh`, bash) pass; their checks are matched by exact name like node tests, through a JUnit report (`GAUSS_OPS_JUNIT`);
  - the UI tests (`npm run test:ui:gate`, hermetic Playwright on its own port, a gate of its own run before `verify`) pass; their names are matched like node tests, through `ui-junit.xml` (`verify` reruns them only if that report is older than 2 h);
  - the production build passes (`--no-build` skips it while iterating);
  - the verification matrix shows every requirement verified.
  It writes `test-results/verification/vcrm.md` and `vcrm.json` (and the four JUnit reports, `junit.xml`, `ops-junit.xml`, `vps-junit.xml` and `ui-junit.xml`). Attach the Markdown to PRs and evidence packs.
  It also writes `readiness.md` and `readiness.json` (see below).

The gate fails if a mapped test fails, is skipped, or **no longer exists**, so renaming a test means updating this baseline.

## Adding a requirement

1. Write the "shall" statement and link its Linear parent.
2. Write or identify the test, and put its exact name in `verifiedBy`.
3. Run `npm run verify`.

## Implementation readiness score

`npm run verify` computes a readiness score from 0 to 100 for every requirement, and rolls it up per parent Linear issue. It is **computed from evidence the repo already has, not self-reported**; the PR template's Developer Score stays only for the CI check. The gate prints one line (`readiness: median 84, 6 requirements below 60: ...`) and writes `test-results/verification/readiness.md` and `readiness.json` with each part, its reason and a to-do list of missing evidence. In this first version it **never fails the gate**.

| Part | Max | Earned when |
|---|---|---|
| Specification | 15 | the requirement passes the baseline checks (4), has exactly one "shall" (4), contains a number or enumerated value (4), and has a rationale and a `GAU-NN` parent (3) |
| Verification | 30 | method T: every `verifiedBy` test passed in this run's JUnit reports, 30 for two or more tests and 22 for one; any failed, skipped or missing test gives 0. Methods A, I, D: 18 when all evidence paths exist (no automated test) |
| End-to-end | 20 | for user-facing requirements (an `API_POLICY` route found in its statement or tests, or a frontend or website page in its evidence), a Playwright spec (`tests/e2e/`), server harness test (`backend/server.*.test.ts`) or website test mentions the route or page; otherwise full marks, reason "internal" |
| Failure analysis | 15 | the FMEA rows citing its tests are mitigated: scaled by the mitigated share, minus 3 for each row with high residual risk; no row, full marks |
| Security | 10 | for route-backed requirements: the route has an explicit access level in `API_POLICY` (5) and a test that asserts 401 or 403 for it (5); otherwise full marks |
| Documentation | 10 | its key paths (evidence paths and the files holding its tests) are mentioned in `docs/` |

The mapping is deliberately simple (route and page strings found in test text), so a low part is a prompt to add or name evidence, not a verdict. The scoring is in `scripts/verify/readiness.ts`, with unit tests in `backend/lib/readiness.test.ts`.
