# Contributing to Lovable

Thank you for contributing to this project. This guide explains how to get started, how contributions are reviewed, and the developer score system that keeps roadmap work rigorous.

## Quick start for new contributors

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the app locally:
   ```bash
   npm run dev
   ```
4. Run quality checks before pushing:
   ```bash
   npm run quality:full
   npm run test:all
   ```
5. Read these docs before your first PR:
   - `docs/CONTRIBUTING.md`
   - `docs/DEVELOPER_SCORING_AND_ONBOARDING.md`
   - `docs/QUALITY_AND_TESTING_QUICK_REF.md`
   - `docs/QA_TEST_PLAN.md`

## Local setup checklist

- Node.js and npm installed
- Repository cloned
- `npm install` successful
- `npm run dev` opens the app
- `npm run quality:full` passes locally
- `npm run test:all` passes locally

## What to work on first

- Start with issues tagged `good first issue`, `documentation`, or `bugfix`.
- Smaller, focused PRs are easier to review.
- If you need help, ask for a quick architecture review before implementation.

## Developer Score requirement

All PRs must include a `Developer Score` section in the PR description. The score helps ensure roadmap changes do not land too early.

Example:

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

For alpha and roadmap-impact PRs, target `95+`.

> The developer-score workflow now enforces:
> - minimum `90/100` for standard PRs
> - minimum `95/100` for PRs labeled `alpha` or `roadmap`

See also: `docs/DEVELOPER_SCORING_AND_ONBOARDING.md`

## PR workflow

1. Open an issue or link to an existing one.
2. Create a feature branch from `main`.
3. Keep scope narrow and avoid unrelated churn.
4. Include a clear test plan, docs impact, and the developer score.
5. Run CI commands locally before pushing.
6. Request a review and mark the PR ready once checks pass.

## GitHub checks and quality gates

- `npm run quality:full` must pass.
- `npm run test:all` should pass.
- `npm run perf:check` is recommended for feature-heavy changes.
- Security and compliance checks are required for any dependency or config change.

## Making developer life easier

- Use the docs as your first navigation aid.
- Prefer small PRs over large refactor bundles.
- Document non-obvious architecture decisions in the PR.
- If you add new APIs, update docs and tests together.
- Ask for help early if the change touches shared infrastructure.

## What blocks a PR from merging

- Type or lint failures.
- Failing tests.
- Missing or weak developer score.
- Large feature bundles without an architecture note.
- Unknown side effects or missing documentation.

## Onboarding resources

- `README.md` for repository structure and quick setup.
- `docs/ARCHITECTURE.md` for system architecture and data flow.
- `docs/QUALITY_AND_TESTING_QUICK_REF.md` for developer commands and release gates.
- `docs/QA_TEST_PLAN.md` for test expectations.
- `docs/DEVELOPER_SCORING_AND_ONBOARDING.md` for scoring rules.
- New GitHub issue templates in `.github/ISSUE_TEMPLATE/` for bugs and feature requests.
- New GitHub Action in `.github/workflows/developer-score-check.yml` validates the PR score section.
