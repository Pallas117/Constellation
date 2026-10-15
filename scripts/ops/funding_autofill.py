#!/usr/bin/env python3
"""Autofill funding applications from the answer bank, and show what is still missing.

  funding_autofill.py status                 # coverage per tracked call
  funding_autofill.py pack GAU-103           # copy-ready fill pack -> ~/Documents/Gauss Funding/packs/GAU-103.md
  funding_autofill.py xlsx                   # write Answer bank / Requirements / Applications tabs into the tracker

Each requirement (tools/grantlint/requirements.json) is matched to answer-bank entries
(~/Documents/Gauss Funding/answer_bank.json) and marked:
  AUTO      a field we can copy as-is (verified or draft values only)
  SEEDED    a narrative with seed text from the bank; rewrite it to the question and limit
  DECISION  a founder decision is missing (never guessed)
  WRITE     nothing in the bank yet: draft it
  DOC       a document to produce and upload
Seeds that still need a citation, and URLs where the call forbids them, are flagged.
Run grantlint on the finished documents before submitting.

The tracker is edited at the XML level (tabs added or replaced, every other part copied
byte for byte) because openpyxl drops its conditional-formatting extensions. A timestamped
backup is written first. Standard library only.
"""
import argparse, datetime as dt, json, os, re, shutil, sys, zipfile
from pathlib import Path
from xml.sax.saxutils import escape

FUND = Path.home() / "Documents" / "Gauss Funding"
REPO = Path(__file__).resolve().parents[2]
URL = re.compile(r"https?://|www\.", re.I)
USABLE = {"verified", "draft"}


def load(answers_path, reqs_path):
    bank = json.loads(Path(answers_path).read_text())
    reqs = json.loads(Path(reqs_path).read_text())
    return bank["answers"], bank.get("do_not_claim", []), reqs["calls"]


def words(s):
    return len(re.findall(r"\b[\w'’-]+\b", s))


def classify(item, answers, rules):
    """(state, text, notes) for one requirement."""
    keys = item.get("answers", [])
    notes = []
    if item["kind"] == "document":
        return "DOC", "", ["produce and upload"] + ([f"limit {item['limit']}"] if item.get("limit") else [])
    missing = [k for k in keys if k not in answers]
    if missing:
        notes.append("unknown answer keys: " + ", ".join(missing))
    entries = [(k, answers[k]) for k in keys if k in answers]
    decisions = [k for k, a in entries if a["status"] == "decision" or not a["value"].strip()]
    usable = [(k, a) for k, a in entries if a["status"] in USABLE and a["value"].strip()]
    cite = [k for k, a in entries if a["status"] == "needs-source"]
    if cite:
        notes.append("cite before use: " + ", ".join(cite))
    text = "\n\n".join(a["value"] for _, a in usable)
    if rules.get("no_urls") and URL.search(text):
        notes.append("contains a URL: this call forbids URLs in answers")
    if item["kind"] in ("field", "choice"):
        if not keys:
            return "WRITE", "", notes + ["not in the answer bank"]
        if decisions:
            return "DECISION", text, notes + ["decide: " + ", ".join(decisions)]
        return "AUTO", text, notes
    # narrative
    if decisions:
        notes.append("decide: " + ", ".join(decisions))
    if not usable:
        return ("DECISION" if decisions else "WRITE"), "", notes + ([] if decisions else ["no seed text yet"])
    limit = (item.get("limit") or {}).get("words")
    if limit:
        n = words(text)
        notes.append(f"seeds {n} words, limit {limit}" + (" (trim)" if n > limit else ""))
    return "SEEDED", text, notes


def call_rows(call, answers):
    rules = call.get("rules", {})
    return [(item, *classify(item, answers, rules)) for item in call["items"]]


def coverage(rows):
    done = sum(1 for _, s, _, _ in rows if s in ("AUTO", "SEEDED"))
    return done, len(rows)


def pack(call_id, call, answers, do_not_claim):
    rows = call_rows(call, answers)
    done, total = coverage(rows)
    out = [f"# {call['name']} ({call_id}) — fill pack", "",
           f"Deadline: {call.get('deadline') or 'not published'}  ",
           f"Source: {call['source']}  ",
           f"Generated {dt.date.today().isoformat()} from answer_bank.json: {done}/{total} items autofilled or seeded.", ""]
    if call.get("rules", {}).get("no_urls"):
        out += ["**This call forbids website addresses or URLs in answers.**", ""]
    out += ["Never claim: " + "; ".join(do_not_claim) + ".", "", "| Item | State | Ask |", "|---|---|---|"]
    out += [f"| {i['id']} | {s} | {i['ask'][:90]} |" for i, s, _, _ in rows]
    section = None
    for item, state, text, notes in rows:
        if item["section"] != section:
            section = item["section"]
            out += ["", f"## {section}"]
        limit = item.get("limit")
        out += ["", f"### {item['id']} · {state}" + (f" · limit {limit}" if limit else ""), "", f"_{item['ask']}_", ""]
        if text:
            out += [text, ""]
        out += [f"> {n}" for n in notes]
    out += ["", "Before submitting: run grantlint on the finished documents and fix every FAIL."]
    return "\n".join(out) + "\n"


# --- xlsx tabs, written without touching the rest of the workbook --------------------------

def _col(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def sheet_xml(rows, widths):
    clean = lambda v: re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(v))
    cols = "".join(f'<col min="{i}" max="{i}" width="{w}" customWidth="1"/>' for i, w in enumerate(widths, 1))
    body = []
    for r, row in enumerate(rows, 1):
        cells = []
        for c, v in enumerate(row, 1):
            if v is None or v == "":
                continue
            ref = f"{_col(c)}{r}"
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                cells.append(f'<c r="{ref}"><v>{v}</v></c>')
            else:
                cells.append(f'<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{escape(clean(v))}</t></is></c>')
        body.append(f'<row r="{r}">{"".join(cells)}</row>')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
            f'<cols>{cols}</cols><sheetData>{"".join(body)}</sheetData></worksheet>')


def write_tabs(xlsx_path, tabs, backup=True):
    """tabs: {name: xml}. Adds or replaces those worksheets; every other zip entry is copied unchanged."""
    xlsx_path = Path(xlsx_path)
    if backup:
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(xlsx_path, xlsx_path.with_name(f"{xlsx_path.stem}.backup-{stamp}{xlsx_path.suffix}"))
    with zipfile.ZipFile(xlsx_path) as z:
        entries = {n: z.read(n) for n in z.namelist()}
        infos = {i.filename: i for i in z.infolist()}
    wb = entries["xl/workbook.xml"].decode()
    rels = entries["xl/_rels/workbook.xml.rels"].decode()
    ctypes = entries["[Content_Types].xml"].decode()
    target_of = {m.group(1): m.group(2) for m in re.finditer(r'<Relationship [^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"', rels)}
    target_of.update({m.group(2): m.group(1) for m in re.finditer(r'<Relationship [^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"', rels)})
    for name, xml in tabs.items():
        m = re.search(rf'<sheet [^>]*name="{re.escape(escape(name, {chr(34): "&quot;"}))}"[^>]*?r:id="([^"]+)"', wb)
        if m:  # replace the existing tab's part in place
            target = target_of[m.group(1)]
            part = "xl/" + target.lstrip("/").removeprefix("xl/")
        else:
            nums = [int(n) for n in re.findall(r"xl/worksheets/sheet(\d+)\.xml", " ".join(entries))] or [0]
            part = f"xl/worksheets/sheet{max(nums) + 1}.xml"
            rid = "rId" + str(max([int(n) for n in re.findall(r'Id="rId(\d+)"', rels)] or [0]) + 1)
            sid = max([int(n) for n in re.findall(r'sheetId="(\d+)"', wb)] or [0]) + 1
            rels = rels.replace("</Relationships>", f'<Relationship Id="{rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="{part.removeprefix("xl/")}"/></Relationships>')
            wb = wb.replace("</sheets>", f'<sheet name="{escape(name, {chr(34): "&quot;"})}" sheetId="{sid}" r:id="{rid}"/></sheets>')
            ctypes = ctypes.replace("</Types>", f'<Override PartName="/{part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        entries[part] = xml.encode()
    entries["xl/workbook.xml"], entries["xl/_rels/workbook.xml.rels"], entries["[Content_Types].xml"] = wb.encode(), rels.encode(), ctypes.encode()
    tmp = xlsx_path.with_suffix(".tmp.xlsx")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
        for n, data in entries.items():
            info = infos.get(n)
            if info is not None:
                out.writestr(info, data, compress_type=info.compress_type)
            else:
                out.writestr(n, data)
    os.replace(tmp, xlsx_path)


def tracker_tabs(answers, calls, deadlines):
    status = {c["id"]: c.get("status", "") for c in deadlines}
    bank = [["Key", "Answer", "Status", "Source", "Used by"]]
    used = {}
    for cid, call in calls.items():
        for it in call["items"]:
            for k in it.get("answers", []):
                used.setdefault(k, set()).add(cid)
    for k, a in answers.items():
        bank.append([k, a["value"] or "(missing)", a["status"], a["source"], ", ".join(sorted(used.get(k, [])))])
    reqs = [["Call", "Item", "Section", "Ask", "Kind", "Limit", "State", "Autofill answer keys", "Notes"]]
    apps = [["Linear", "Call", "Deadline", "Pipeline status", "Autofilled / seeded", "Items", "Coverage %", "Decisions needed", "Documents to produce", "Requirements source"]]
    for cid, call in calls.items():
        rows = call_rows(call, answers)
        for it, state, _, notes in rows:
            lim = ", ".join(f"{v} {k}" for k, v in (it.get("limit") or {}).items())
            reqs.append([cid, it["id"], it["section"], it["ask"], it["kind"], lim, state, ", ".join(it.get("answers", [])), "; ".join(notes)])
        done, total = coverage(rows)
        apps.append([cid, call["name"], (call.get("deadline") or "")[:10] or "not published", status.get(cid, ""), done, total,
                     round(100 * done / total) if total else 0, sum(1 for r in rows if r[1] == "DECISION"),
                     sum(1 for r in rows if r[1] == "DOC"), call["source"]])
    return {"Applications": sheet_xml(apps, [10, 48, 12, 14, 12, 8, 11, 12, 14, 70]),
            "Requirements": sheet_xml(reqs, [10, 10, 20, 70, 11, 12, 10, 34, 60]),
            "Answer bank": sheet_xml(bank, [22, 90, 12, 60, 28])}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("cmd", choices=["status", "pack", "xlsx"])
    ap.add_argument("call", nargs="?")
    ap.add_argument("--answers", default=str(FUND / "answer_bank.json"))
    ap.add_argument("--requirements", default=str(REPO / "tools" / "grantlint" / "requirements.json"))
    ap.add_argument("--deadlines", default=str(FUND / "deadlines.json"))
    ap.add_argument("--tracker", default=str(FUND / "Gauss_Funding_Tracker.xlsx"))
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    answers, dnc, calls = load(a.answers, a.requirements)
    if a.cmd == "status":
        for cid, call in calls.items():
            rows = call_rows(call, answers)
            done, total = coverage(rows)
            counts = {s: sum(1 for r in rows if r[1] == s) for s in ("AUTO", "SEEDED", "DECISION", "WRITE", "DOC")}
            print(f"{cid:<8} {done:>2}/{total:<2} filled  " + "  ".join(f"{k} {v}" for k, v in counts.items()) + f"  {call['name']}")
    elif a.cmd == "pack":
        if a.call not in calls:
            ap.error(f"call must be one of {', '.join(calls)}")
        out = Path(a.out) if a.out else FUND / "packs" / f"{a.call}.md"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(pack(a.call, calls[a.call], answers, dnc))
        print(f"wrote {out}")
    else:
        deadlines = json.loads(Path(a.deadlines).read_text())["calls"] if Path(a.deadlines).exists() else []
        write_tabs(a.tracker, tracker_tabs(answers, calls, deadlines))
        print(f"updated {a.tracker}: Applications, Requirements, Answer bank tabs (backup written beside it)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
