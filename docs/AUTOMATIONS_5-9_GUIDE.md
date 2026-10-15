# Automations 5-9 Guide

This document describes the implementation and usage of Automations 5-9 for Gauss Aurora.

## Overview

Automations 5-9 cover quality, testing, release, migration safety, and performance regression.
They are implemented via GitHub Actions workflows and local npm scripts.

## 5. Type Safety & Linting Gate

### Purpose
Ensure code is type-safe and follows linting standards before merging.

### Workflow
- `.github/workflows/type-safety-lint.yml`

### Checks
- `npm run quality:types` (tsc on `frontend/tsconfig.app.json` and `frontend/tsconfig.node.json`)
- `npx eslint . --format json --output-file eslint-report.json`
- PR comment with type/lint results
- Fails PR if type errors exist

### Local commands
```bash
npm run quality:types
npm run quality:lint
npm run quality:full
```

## 6. Test Coverage Enforcement

### Purpose
Run unit and E2E tests on every PR and report coverage.

### Workflow
- `.github/workflows/test-coverage.yml`

### Checks
- `npm test` for backend/unit tests
- `npm run test:ui` for Playwright E2E tests
- Uploads test output to artifacts
- Comments PR with test status

### Local commands
```bash
npm test
npm run test:ui
npm run test:all
```

## 7. Build & Release Pipeline

### Purpose
Automate release validation, build verification, version detection, and changelog generation.

### Workflow
- `.github/workflows/release-pipeline.yml`

### Checks
- Full adherence audit
- Security compliance check
- RBAC smoke tests
- Type checking and build
- Upload build artifacts
- Auto version bump based on conventional commit messages
- Auto changelog generation

### Local commands
```bash
npm run release:prepare
```

## 8. Database Migration Safety

### Purpose
Validate SQL migrations and detect potentially disruptive changes.

### Workflow
- `.github/workflows/migration-safety.yml`

### Checks
- SQL syntax validation for migration files
- Downtime risk detection for `NOT NULL` additions without defaults
- `CREATE INDEX` without `CONCURRENTLY` warning
- Rollback capability check
- Backup checklist reminder
- PR comment summarizing migration health

### Local commands
```bash
# Review migration files manually
```

## 9. Performance Regression Testing

### Purpose
Catch frontend/backend regressions related to bundle size, memory, and API performance.

### Workflow
- `.github/workflows/performance-regression.yml`

### Checks
- Bundle size analysis after build
- Frontend performance heuristics: memoization, console logs, heavy imports
- API response time heuristics: timeouts, N+1 pattern detection, large response limits
- Memory leak detection: missing cleanup and circular references
- Summary report across all checks

### Local commands
```bash
npm run perf:check
```

## Critical Bug Reporting

We also performed a code quality audit and found the following critical issues:
- Ingestion worker unhandled promise rejection
- Memory leak in event-based interval handling
- GraphDB connection leak due to unpooled sessions
- Cascading RPC failures that block partial success

These issues are documented in `docs/CRITICAL_BUGS_AND_FIXES.md`.

## Recommended Workflow

1. Run `npm run quality:full` locally before opening PR.
2. Run `npm run test:all` locally to confirm coverage.
3. Run `npm run perf:check` for bundle size and performance insights.
4. Push branch and verify GitHub Actions.
5. For releases, run `npm run release:prepare` and then tag.

## Notes

- All workflows are active by default in GitHub Actions.
- No extra manual CI configuration is required.
- Quality automation is designed to fail fast on type/test issues and warn on performance regressions.
