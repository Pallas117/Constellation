# grantlint

Format and compliance checks for grant applications, run before anyone reads for merit.
The ESA BIC UK application (Board #85, Sep 2026) was rejected on format alone; run on
those PDFs, grantlint reproduces every reason the board gave (17 FAIL).

```bash
python3 tools/grantlint/grantlint.py tools/grantlint/rules/esa_bic_uk.json \
  BP="Business Plan.pdf" IP="Incubation Proposal.pdf" CL="Cover Letter and Checklist.pdf"
```

Reads PDF (macOS PDFKit through `pdftext.swift`, no Homebrew), `.docx` (`textutil`) or `.txt`.
Exit code 1 while anything FAILs: don't call an application ready until it exits 0.

| Level | Meaning |
|---|---|
| FAIL | Breaks a stated limit or rule: page counts, executive summary length, blank MFA lines, template guidance left in (compared against the blank template), placeholders, internal notes, known typos |
| WARN | Needs a person: MoU / partner / customer / readiness wording to check against the answer bank's do-not-claim list |
| CHECK | Can't be checked automatically, or the limit isn't in the rules yet (never guessed) |

## Rules files

`rules/<funder>.json`: copy every limit **verbatim** from the call documents and cite the source.
An unknown limit is `null` and shows as a CHECK. Fields: `documents` (per file key: `max_pages`,
`ideal_pages`, `annex_heading`, `sections` with page limits, `required_text`, `must_not_be_blank`),
`templates` (blank templates for the leftover-guidance check), `forbidden` (FAIL patterns),
`review` (WARN patterns), `checks` (manual checklist lines).

- `esa_bic_uk.json`: limits from the Issue C templates; Board #85 reasons.
- `esa_bass.json`: Kick-start (AO 6-60021); page limits are only on esa-star, so fill them in first.

When an outcome comes back, add its reasons here so the same mistake can't recur.

Tests: `python3 tools/grantlint/test_grantlint.py` (also in `npm run test:ops`).
