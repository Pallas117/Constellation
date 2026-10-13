#!/usr/bin/env python3
"""grantlint: format and compliance checks for grant applications, before anything else.

Rebuilt on 13 Oct 2026 from the funding-applications skill after the ESA BIC UK
application (Board #85, Sep 2026) was rejected on FORMAT, not merit: template guidance
left in, a blank MFA section, an over-length business plan, a 2-page executive summary,
a 12-page incubation proposal, costs consolidated per task, an internal note, the typo
"Complaint" and overclaims. Every limit in a rules file is copied verbatim from the
call documents, with its source; a limit that isn't known is a CHECK, never a guess.

  python3 tools/grantlint/grantlint.py tools/grantlint/rules/esa_bic_uk.json BP=plan.pdf IP=proposal.pdf CL=cover.pdf

Reads PDF (macOS PDFKit via pdftext.swift), .docx (textutil) or .txt. Prints one line per
finding (FAIL / WARN / CHECK) and a summary line; exits 1 if anything FAILs.
"""
import json, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def read_pages(path):
    """A document as a list of page texts. .txt splits pages on form feeds."""
    p = Path(path)
    ext = p.suffix.lower()
    if ext == ".pdf":
        out = subprocess.run(["swift", str(HERE / "pdftext.swift"), str(p)], capture_output=True, text=True, timeout=300)
        if out.returncode != 0:
            raise SystemExit(f"grantlint: can't read {p}: {out.stderr.strip()[:200]}")
        return json.loads(out.stdout)["text"]
    if ext in (".docx", ".doc", ".rtf"):
        out = subprocess.run(["textutil", "-convert", "txt", "-stdout", str(p)], capture_output=True, text=True, timeout=120)
        return [out.stdout]  # page breaks aren't kept: page limits become CHECKs
    return p.read_text(errors="replace").split("\f")


def norm(s):
    return re.sub(r"\s+", " ", s).strip().lower()


def guidance_sentences(template_text):
    """Instruction text from a blank template: bracketed blocks and imperative lines."""
    out = set()
    for block in re.findall(r"\[([^\]]{25,})\]", template_text, re.S):
        out.update(s for s in re.split(r"(?<=[.!?])\s+", norm(block)) if len(s) >= 30)
    for line in template_text.splitlines():
        line = norm(line)
        if len(line) >= 30 and re.match(r"(please|describe|explain|provide|insert|list|add|delete|state|give|outline|summari[sz]e)\b", line):
            out.add(line)
    return out


def section_pages(pages, start_re, end_re):
    """(first, last) 0-based pages touched by a section, or None if its heading isn't found."""
    start = next((i for i, t in enumerate(pages) if re.search(start_re, t, re.I | re.M)), None)
    if start is None:
        return None
    end = next((i for i in range(start, len(pages)) if re.search(end_re, pages[i], re.I | re.M)
                and (i > start or re.search(start_re + r"[\s\S]*" + end_re, pages[i], re.I | re.M))), None)
    return (start, start if end is None else end)


def core_pages(pages, annex_re):
    first_annex = next((i for i, t in enumerate(pages) if re.search(annex_re, t[:300], re.I | re.M)), None)
    return len(pages) if first_annex is None else first_annex


def lint(rules, docs, templates=None):
    """docs: {KEY: [page texts]}. templates: {KEY: template text}. Returns [(level, key, message)]."""
    findings = []
    add = lambda lvl, key, msg: findings.append((lvl, key, msg))
    templates = templates or {}
    for key, spec in rules["documents"].items():
        label = spec.get("label", key)
        if key not in docs:
            add("FAIL" if spec.get("required", True) else "CHECK", key, f"{label}: not provided")
            continue
        pages = docs[key]
        paged = len(pages) > 1 or spec.get("single_page_ok", False)
        n = core_pages(pages, spec["annex_heading"]) if spec.get("annex_heading") else len(pages)
        what = "core pages (before the first annex)" if spec.get("annex_heading") else "pages"
        if spec.get("max_pages") is None:
            add("CHECK", key, f"{label}: page limit not set in the rules; copy it from the call guidance")
        elif not paged:
            add("CHECK", key, f"{label}: page count unknown for this file type; check against {spec['max_pages']} pages")
        elif n > spec["max_pages"]:
            add("FAIL", key, f"{label}: {n} {what}, limit {spec['max_pages']} ({spec.get('limit_source', 'call guidance')})")
        elif spec.get("ideal_pages") and n > spec["ideal_pages"]:
            add("WARN", key, f"{label}: {n} {what}; guidance says ideally {spec['ideal_pages']}, max {spec['max_pages']}")
        for sec in spec.get("sections", []):
            span = section_pages(pages, sec["start"], sec["end"])
            if span is None:
                add("FAIL" if sec.get("required", True) else "CHECK", key, f"{label}: section '{sec['name']}' not found")
                continue
            touched = span[1] - span[0] + 1
            if touched > sec["max_pages"] + 1:
                add("FAIL", key, f"{label}: '{sec['name']}' runs over {touched} pages, limit {sec['max_pages']} ({sec.get('limit_source', '')})".rstrip(" ()"))
            elif touched == sec["max_pages"] + 1:
                add("CHECK", key, f"{label}: '{sec['name']}' touches {touched} pages; make sure it fits in {sec['max_pages']}")
        text = "\n".join(pages)
        for req in spec.get("required_text", []):
            if not re.search(req["pattern"], text, re.I):
                add("FAIL", key, f"{label}: missing {req['why']}")
        for blank in spec.get("must_not_be_blank", []):
            m = re.search(blank["pattern"], text, re.I | re.S)
            if m and not norm(m.group("value")):
                add("FAIL", key, f"{label}: {blank['why']} is blank; write the funder's word for nothing (e.g. 'None' / 'N/A')")
        if key in templates:
            body = norm(text)
            leaked = sorted(s for s in guidance_sentences(templates[key]) if s in body)
            for s in leaked[:10]:
                add("FAIL", key, f"{label}: template guidance left in: \"{s[:90]}\"")
            if len(leaked) > 10:
                add("FAIL", key, f"{label}: {len(leaked) - 10} more template guidance sentences left in")
    every = {k: "\n".join(v) for k, v in docs.items()}
    for rule in rules.get("forbidden", []):
        for key, text in every.items():
            for m in list(re.finditer(rule["pattern"], text, re.I | re.M))[:3]:
                snippet = norm(text[max(0, m.start() - 30):m.end() + 30])
                add("FAIL", key, f"{rule['why']}: \"…{snippet}…\"")
    for rule in rules.get("review", []):
        for key, text in every.items():
            hits = list(re.finditer(rule["pattern"], text, re.I))
            if hits:
                snippet = norm(text[max(0, hits[0].start() - 40):hits[0].end() + 40])
                add("WARN", key, f"{rule['why']} ({len(hits)}x), e.g. \"…{snippet}…\"")
    for item in rules.get("checks", []):
        add("CHECK", "-", item)
    return findings


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) < 2 or any("=" not in a for a in argv[1:]):
        print(__doc__.split("\n\n")[2], file=sys.stderr)
        return 2
    rules_path = Path(argv[0])
    rules = json.loads(rules_path.read_text())
    docs = {k: read_pages(v) for k, v in (a.split("=", 1) for a in argv[1:])}
    templates = {}
    for key, tpath in rules.get("templates", {}).items():
        tp = Path(tpath).expanduser()
        if key in docs and tp.exists():
            templates[key] = "\n".join(read_pages(tp))
        elif key in docs:
            print(f"CHECK {key}: template {tp} not found; template-leftover check skipped")
    findings = lint(rules, docs, templates)
    order = {"FAIL": 0, "WARN": 1, "CHECK": 2}
    for lvl, key, msg in sorted(findings, key=lambda f: order[f[0]]):
        print(f"{lvl:<5} {key}: {msg}")
    count = {lvl: sum(1 for f in findings if f[0] == lvl) for lvl in order}
    print(f"grantlint {rules.get('funder', rules_path.stem)}: {count['FAIL']} FAIL, {count['WARN']} WARN, {count['CHECK']} CHECK"
          + (" — not ready to submit" if count["FAIL"] else " — no FAILs; review WARN and CHECK with a person"))
    return 1 if count["FAIL"] else 0


if __name__ == "__main__":
    sys.exit(main())
