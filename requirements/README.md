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
  - the ops tests (`scripts/ops/gauss-services.test.sh`, bash) pass; their checks are matched by exact name like node tests, through a JUnit report (`GAUSS_OPS_JUNIT`);
  - the production build passes (`--no-build` skips it while iterating);
  - the verification matrix shows every requirement verified.
  It writes `test-results/verification/vcrm.md` and `vcrm.json` (and the two JUnit reports, `junit.xml` and `ops-junit.xml`). Attach the Markdown to PRs and evidence packs.

The gate fails if a mapped test fails, is skipped, or **no longer exists**, so renaming a test means updating this baseline.

## Adding a requirement

1. Write the "shall" statement and link its Linear parent.
2. Write or identify the test, and put its exact name in `verifiedBy`.
3. Run `npm run verify`.
