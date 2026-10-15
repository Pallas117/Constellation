"""Tests for funding_autofill.py:  python3 scripts/ops/test_funding_autofill.py"""
import json, os, re, sys, tempfile, unittest, zipfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import funding_autofill as fa  # noqa: E402

ANSWERS = {
    "name": {"value": "Lightbound Limited", "status": "verified", "source": "CH"},
    "addr": {"value": "30A Commercial Street, Harrogate", "status": "verified", "source": "BP"},
    "mfa": {"value": "", "status": "decision", "source": "declare"},
    "problem": {"value": "Radiation silently corrupts outputs. " * 3, "status": "draft", "source": "BP"},
    "market": {"value": "USD 3.8 billion", "status": "needs-source", "source": "BP"},
    "site": {"value": "See https://example.org for more", "status": "draft", "source": "x"},
}


def item(kind, answers, **kw):
    return {"id": "X", "section": "S", "ask": "ask", "kind": kind, "answers": answers, **kw}


class Classify(unittest.TestCase):
    def test_field_with_verified_values_is_auto(self):
        s, text, _ = fa.classify(item("field", ["name", "addr"]), ANSWERS, {})
        self.assertEqual(s, "AUTO")
        self.assertIn("Lightbound Limited", text)

    def test_missing_decision_is_never_guessed(self):
        s, text, notes = fa.classify(item("field", ["mfa"]), ANSWERS, {})
        self.assertEqual((s, text), ("DECISION", ""))
        self.assertIn("decide: mfa", notes)

    def test_narrative_seeded_with_word_count_and_citation_flag(self):
        s, text, notes = fa.classify(item("narrative", ["problem", "market"], limit={"words": 10}), ANSWERS, {})
        self.assertEqual(s, "SEEDED")
        self.assertNotIn("USD 3.8", text)  # needs-source seeds are not pasted in
        self.assertTrue(any("cite before use: market" in n for n in notes))
        self.assertTrue(any("limit 10 (trim)" in n for n in notes))

    def test_url_flagged_when_call_forbids_urls(self):
        _, _, notes = fa.classify(item("narrative", ["site"]), ANSWERS, {"no_urls": True})
        self.assertTrue(any("forbids URLs" in n for n in notes))

    def test_unmapped_and_documents(self):
        self.assertEqual(fa.classify(item("narrative", []), ANSWERS, {})[0], "WRITE")
        self.assertEqual(fa.classify(item("document", []), ANSWERS, {})[0], "DOC")


class RealFiles(unittest.TestCase):
    def test_every_requirement_key_exists_in_the_answer_bank_template(self):
        reqs = json.loads((fa.REPO / "tools" / "grantlint" / "requirements.json").read_text())["calls"]
        bank = Path.home() / "Documents" / "Gauss Funding" / "answer_bank.json"
        if not bank.exists():
            self.skipTest("no local answer bank")
        keys = set(json.loads(bank.read_text())["answers"])
        used = {k for c in reqs.values() for i in c["items"] for k in i.get("answers", [])}
        self.assertEqual(used - keys, set())


def minimal_xlsx(path):
    parts = {
        "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        "xl/workbook.xml": '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Programmes" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        "xl/worksheets/sheet1.xml": '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><f>TODAY()</f></c></row></sheetData></worksheet>',
    }
    with zipfile.ZipFile(path, "w") as z:
        for n, d in parts.items():
            z.writestr(n, d)
    return parts


class Xlsx(unittest.TestCase):
    def test_adds_then_replaces_tabs_and_leaves_other_parts_untouched(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "t.xlsx"
            original = minimal_xlsx(p)
            fa.write_tabs(p, {"Answer bank": fa.sheet_xml([["Key", "Answer"], ["a", "x < y & z"]], [10, 20])})
            self.assertEqual(len(list(Path(d).glob("t.backup-*.xlsx"))), 1)
            with zipfile.ZipFile(p) as z:
                self.assertEqual(z.read("xl/worksheets/sheet1.xml").decode(), original["xl/worksheets/sheet1.xml"])
                wb = z.read("xl/workbook.xml").decode()
                self.assertIn('name="Answer bank" sheetId="2" r:id="rId2"', wb)
                self.assertIn("x &lt; y &amp; z", z.read("xl/worksheets/sheet2.xml").decode())
                self.assertIn('/xl/worksheets/sheet2.xml', z.read("[Content_Types].xml").decode())
            fa.write_tabs(p, {"Answer bank": fa.sheet_xml([["Key"], ["b"]], [10])}, backup=False)  # re-run replaces
            with zipfile.ZipFile(p) as z:
                self.assertEqual(z.read("xl/workbook.xml").decode().count('name="Answer bank"'), 1)
                self.assertIn(">b<", z.read("xl/worksheets/sheet2.xml").decode())
                self.assertNotIn("sheet3.xml", " ".join(z.namelist()))

    def test_pack_lists_states_and_url_rule(self):
        call = {"name": "Test call", "source": "src", "rules": {"no_urls": True},
                "items": [item("field", ["name"]), item("field", ["mfa"]) | {"id": "Y"}]}
        md = fa.pack("C1", call, ANSWERS, ["dose figures"])
        self.assertIn("1/2 items autofilled or seeded", md)
        self.assertIn("forbids website addresses", md)
        self.assertIn("Never claim: dose figures.", md)
        self.assertTrue(re.search(r"### Y · DECISION", md))


if __name__ == "__main__":
    unittest.main()
