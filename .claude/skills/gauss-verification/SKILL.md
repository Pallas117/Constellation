---
name: gauss-verification
description: Requirements baseline, FMEA and VCRM gate for Gauss (NASA SP-2016-6105 Rev 2 §5.3/§6.2/§6.4), with the id scheme, cheap checks and the traceability-audit method. Use before editing requirements/requirements.json or requirements/fmea.json, mapping tests to requirements, or auditing coverage.
---

# Gauss verification

## Map
| What | Path |
|---|---|
| Requirements baseline | `requirements/requirements.json` (`version`, `requirements[]`: id, title, statement, rationale, parent, method, owner, verifiedBy or evidence) |
| FMEA | `requirements/fmea.json` (`rows[]`: id, item, failureMode, effect, detection, mitigation, severity, likelihood, residualLikelihood, verifiedBy, optional gap) |
| VCRM builder | `scripts/verify/vcrm.ts` (`validateBaseline`, `buildMatrix`, `buildFmea`, `mergeOutcomes`, `parseJunit`) |
| Gate | `npm run verify` (`scripts/verify/verify.ts`): baseline → website tests → full tests (JUnit) → ops tests → build → VCRM + FMEA; output in `test-results/verification/` |
| Unit tests | `backend/lib/vcrm.test.ts` |
| Why | `requirements/README.md`, `docs/ARCHITECTURE.md` §7–8 |

## Rules
- Ids look like `REQ-ABC-001`; FMEA rows `FM-NN`. Continue a prefix's numbering, and first check ids used by open PRs:
  `for b in $(gh pr list --limit 50 --json headRefName -q '.[].headRefName'); do git show "origin/${b}:requirements/requirements.json" 2>/dev/null | grep -o 'REQ-[A-Z]*-[0-9]*'; done | sort -u`
  (in zsh write `${b}:` with braces: `$b:r` is a modifier).
- Method T needs exact test names; the gate fails if one fails, is skipped or no longer exists, so a renamed test means a baseline edit.
- A FMEA row with a `gap` counts as open (the gate's "FMEA n/m" is mitigated rows over all rows); open gaps report but don't block.
- Bump `version` when the baseline changes.

## Cheap checks (no installs; the 8 GB Mac runs one heavy job at a time)
```sh
node --input-type=module -e "import fs from 'node:fs'; const {validateBaseline}=await import('./scripts/verify/vcrm.ts'); console.log(validateBaseline(JSON.parse(fs.readFileSync('requirements/requirements.json','utf8'))))"
git grep -F -e "<exact test name>" -- '*.test.ts' '*.test.sh' '*_test.go'
```
Use `-e` before a name that starts with `--`. The full gate runs on the merge train (`scripts/ops/gauss-services.sh gates enqueue <sha> --pr N`).

## Audit method (bidirectional trace)
1. Statement quality: singular, measurable, unambiguous.
2. Forward: every mapped test exists verbatim and actually checks the "shall" (spot-check security first).
3. Backward: every shipped behaviour (each API_POLICY group, auth, CyberTiger, device auth, mesh, bundles, trust, retention, deploy guards, Argo, website) has a requirement.
4. FMEA: every row has a mitigation and a test or an honest gap; look for missing modes (auth bypass, token leak, queue exhaustion, key compromise, data loss).
Report ids, file:line evidence and UNVERIFIED where unsure.
