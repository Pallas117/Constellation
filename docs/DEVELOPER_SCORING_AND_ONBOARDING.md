# Developer Scoring and Onboarding

This document defines a rigorous contribution scoring system for roadmap PRs and a developer onboarding workflow to make new contributors productive quickly.

## Purpose

- Prevent low-quality or early roadmap changes from being merged.
- Establish clear, objective gating for alpha and POC work.
- Make the codebase welcoming and easy to join for developers.
- Provide a structured scoring rubric that can be automated later.

## Scoring System Overview

Each PR is scored across six categories. A merge-ready release PR must score at least `90/100`. Roadmap or alpha feature PRs targeting main should score `95+` for extra rigor.

### Category weights

- Code Quality: 25 points
- Testing & Coverage: 25 points
- Architecture & Fit: 20 points
- Documentation & Communication: 15 points
- Security & Compliance: 10 points
- Release Readiness: 5 points

## Category Criteria

### 1. Code Quality (25)

- 10 points: no TypeScript errors, no lint issues, no formatting drift
- 5 points: no disabled ESLint rules or skipped checks without justification
- 5 points: code style matches existing patterns and idioms
- 5 points: no TODO/FIXME left in merged code unless explicitly scoped as backlog

### 2. Testing & Coverage (25)

- 10 points: unit tests cover new logic and boundary conditions
- 5 points: end-to-end or integration tests cover the flow when applicable
- 5 points: regression test added for previously fixed issues if relevant
- 5 points: tests actually pass in CI and locally with `npm test`

### 3. Architecture & Fit (20)

- 10 points: the change fits the current architecture and data model
- 5 points: no risky shortcuts or hidden side effects introduced
- 5 points: the PR includes a brief architecture note when the scope is non-trivial

### 4. Documentation & Communication (15)

- 5 points: PR description clearly explains the change, why it matters, and how to verify it
- 5 points: docs updated when behavior, API, or developer workflow changes
- 5 points: dependencies, feature flags, and rollout notes are documented if needed

### 5. Security & Compliance (10)

- 5 points: new code passes existing security automation and dependency checks
- 5 points: no sensitive values, no open CORS changes, no insecure defaults

### 6. Release Readiness (5)

- 5 points: the change is scoped to a single, reviewable purpose and not a bundled mega-PR

## Gate Rules

- **Mandatory gate**: PRs targeting roadmap/main must include a `Developer Score` section in the description.
- **Merge block**: PRs scoring below `90` should not be merged.
- **Alpha/Roadmap gate**: PRs labeled `alpha` or `roadmap` must target `95+` before they can be merged.
- **Roadmap freeze**: any major roadmap feature needs an explicit architecture review before merge.
- **Score transparency**: reviewers should call out missing points during review; maintainers can annotate the PR with the calculated score.

## Developer Onboarding Best Practices

### 1. First-day setup

- Provide a short, copy/paste local setup guide in `README.md` and `/docs/`.
- Ensure `npm install` and `npm run dev` work from the base repo.
- Supply a local environment checklist with minimal required variables.
- Keep the dev environment fast and predictable.

### 2. Clear project map

- Document the repo structure and high-value entry points.
- Add a concise section for frontend, backend, ml, and shared contract areas.
- Add a “start here” pointer for common tasks: run app, run tests, run lint.

### 3. Issue and PR hygiene

- Use issue templates that capture: goal, acceptance criteria, non-goals, and dependencies.
- Use PR templates that require: summary, test plan, docs impact, and developer score.
- Keep PR sizes small and focused.

### 4. Codebase orientation

- Document common patterns: auth flow, data fetching, physics pipeline, visualization model.
- Provide examples for reading from the live space weather feed and the SWAP plan API.
- Add a short “where to edit” guide for typical hero flows.

### 5. Mentoring and support

- Maintain a `docs/CONTRIBUTING.md` or `docs/TEAM_ONBOARDING.md` reference for new contributors.
- Capture FAQs and common pitfalls in `/docs/`.
- Add a list of project stewards or reviewers for fast help.

### 6. Automation and shortcuts

- Provide scripts for common workflows: `npm run quality:full`, `npm run test:all`, `npm run dev`.
- Add explicit guidance for GitHub Actions feedback and status checks.
- Recommend `git` aliases or shell commands for repeated tasks.

## Suggested developer score section in PR descriptions

```
### Developer Score
- Code Quality: 24/25
- Testing & Coverage: 22/25
- Architecture & Fit: 18/20
- Documentation & Communication: 13/15
- Security & Compliance: 10/10
- Release Readiness: 5/5

**Total: 92/100**
```

## Why this helps

- Ensures roadmap PRs are held to a higher standard before merge.
- Reduces churn from early or unsound feature pushes.
- Gives new contributors clear expectations and a concrete checklist.
- Makes project health reviewable at a glance.

## Next step

- Implement automated score calculation in CI using the rubric in `docs/developer-scoring-rubric.json`.
- Add a PR template or GitHub Action that surfaces the score and blocks low-scoring PRs.
