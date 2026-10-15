# Quality & Testing Quick Reference

## Setup (One-Time)
```bash
# No special setup needed! All workflows active in GitHub.
# Just use npm scripts before pushing.
```

## Before Every PR
```bash
npm run quality:full     # Type check + linting
npm run test:all         # Unit + E2E tests
npm run perf:check       # Bundle size analysis
```

## Before Release
```bash
npm run release:prepare  # All gates: quality, tests, security
npm run release:check    # Optional release preflight validation
git tag v1.0.0
git push origin v1.0.0   # Triggers release workflow
```

## Common Commands

### Quality Checks
| Command | Does |
|---------|------|
| `npm run quality:types` | TypeScript type check (frontend app + Vite config) |
| `npm run quality:lint` | ESLint checking |
| `npm run quality:full` | Both together |

### Testing
| Command | Does |
|---------|------|
| `npm test` | Unit tests |
| `npm run test:ui` | E2E tests (Playwright) |
| `npm run test:all` | Both together |

### Performance
| Command | Does |
|---------|------|
| `npm run perf:check` | Bundle size analysis |
| `npm run build` | Build project |
| `du -sh frontend/dist` | Check dist size |

### Release
| Command | Does |
|---------|------|
| `npm run release:prepare` | All pre-release checks |
| `git tag v1.0.0` | Create release tag |
| `git push origin v1.0.0` | Trigger CI release |

## What Blocks PRs

❌ **Blocks merge to main:**
- Type errors
- Build failures
- Unit/E2E tests failing
- Pre-release gates failing

⚠️ **Shows warnings (doesn't block):**
- ESLint warnings
- Bundle size >1MB
- Missing tests
- Database downtime risks

## GitHub Actions Status

Check: Repository → Actions tab

**Workflows** (auto-triggered):
- ✅ type-safety-lint.yml — Every PR
- ✅ test-coverage.yml — Every PR
- ✅ release-pipeline.yml — Push to main
- ✅ migration-safety.yml — Migration changes
- ✅ performance-regression.yml — Every commit

## CI Feedback

### On Pull Requests
GitHub automatically comments with:
- ✅ Type check: PASSED/FAILED
- ✅ Linting: Results
- ✅ Tests: PASSED/FAILED
- ✅ Bundle: Size in KB
- ⚠️ Performance: Warnings

### On Main Branch
- Builds automatically
- Version bumped automatically (major/minor/patch)
- Changelog auto-generated
- Release created

## Troubleshooting

### Type errors fail PR
```bash
npm run quality:types
# Fix errors shown, then re-push
```

### Lint errors
```bash
npx eslint . --fix   # Auto-fix
git add . && git commit -m "fix: lint"
```

### Tests fail
```bash
npm test             # See failures
# Fix code, re-run
npm test
```

### Bundle too large
```bash
npm run build
du -sh frontend/dist  # Check size
# Reduce imports, code-split large components
```

## Performance Targets

| Metric | Target |
|--------|--------|
| JS Bundle | <512KB (optimal) |
| Type errors | 0 |
| Test pass rate | 100% |
| Memory | <200MB |
| FPS | 60 FPS |

## Metrics to Track

Automations monitor:
1. Type safety
2. Code quality (linting)
3. Test coverage
4. Bundle size
5. Memory usage
6. API response times
7. Database migration safety
8. Release readiness

## Documentation Links

- **Automations 1-4**: [AUTOMATION_1-4_COMPLETE.md](AUTOMATION_1-4_COMPLETE.md)
- **Automations 5-9**: [AUTOMATION_5-9_COMPLETE.md](AUTOMATION_5-9_COMPLETE.md)
- **Critical Bugs**: [docs/CRITICAL_BUGS_AND_FIXES.md](docs/CRITICAL_BUGS_AND_FIXES.md)
- **Security**: [docs/SECURITY_AUTOMATION.md](docs/SECURITY_AUTOMATION.md)
- **Developer scoring and onboarding**: [docs/DEVELOPER_SCORING_AND_ONBOARDING.md](docs/DEVELOPER_SCORING_AND_ONBOARDING.md)
- **Full Guides**: Check `/docs/` folder

## Release Versioning

Use semantic versioning:
- **v2.0.0** — Breaking changes (major)
- **v1.1.0** — New features (minor)
- **v1.0.1** — Bug fixes (patch)
- **v1.0.0-rc.1** — Release candidate

CI auto-detects from commit messages:
- `BREAKING:` or `feat!:` → major
- `feat:` → minor
- Everything else → patch

## Key Takeaways

✅ **Automation runs on every commit** — No manual checking needed  
✅ **Blocks bad code from merging** — Type errors, test failures, etc  
✅ **PR comments show status** — Results visible without clicking  
✅ **Release is one git tag** — Everything else automated  
✅ **Performance monitored** — Bundle size, memory, latency tracked  

Run `npm run release:prepare` before pushing — that's it!

