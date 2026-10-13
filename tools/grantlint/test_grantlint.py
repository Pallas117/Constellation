"""Tests for grantlint:  python3 tools/grantlint/test_grantlint.py"""
import json, os, sys, unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import grantlint as gl  # noqa: E402

RULES = json.loads((Path(__file__).parent / "rules" / "esa_bic_uk.json").read_text())
TEMPLATE_IP = "[Please limit this Incubation Proposal to maximum 10 pages including cover page and any annexes. Don't change or reduce the font size.]\nDescribe the tasks you will carry out during the incubation period."
CL_OK = ["Cover letter", "DECLARATION OF MINIMAL FINANCIAL ASSISTANCE\n1. Date or period of MFA subsidy received: None\nTotal amount of MFA subsidy : £0\n"]


def bp(core, exec_pages=1):
    pages = ["1. EXECUTIVE SUMMARY\nWe validate inference."] + ["more summary"] * (exec_pages - 1)
    pages[-1] += "\n2. Company\nLightbound Limited"
    pages += ["body"] * (core - len(pages))
    return pages + ["Annex A\nCertificate"]


def levels(findings, key=None):
    return [(l, k) for l, k, m in findings if key is None or k == key]


class Limits(unittest.TestCase):
    def test_clean_application_has_no_fails(self):
        f = gl.lint(RULES, {"BP": bp(15), "IP": ["p"] * 10, "CL": CL_OK})
        self.assertFalse([x for x in f if x[0] == "FAIL"], f)

    def test_business_plan_core_over_20_fails_and_over_15_warns(self):
        self.assertIn(("FAIL", "BP"), levels(gl.lint(RULES, {"BP": bp(22), "IP": ["p"], "CL": CL_OK})))
        f = gl.lint(RULES, {"BP": bp(18), "IP": ["p"], "CL": CL_OK})
        self.assertIn(("WARN", "BP"), levels(f))
        self.assertNotIn(("FAIL", "BP"), levels(f))

    def test_annexes_dont_count_toward_core(self):
        f = gl.lint(RULES, {"BP": bp(20) + ["Annex B"] * 6, "IP": ["p"], "CL": CL_OK})
        self.assertNotIn(("FAIL", "BP"), levels(f))

    def test_incubation_proposal_over_10_pages_fails(self):
        f = gl.lint(RULES, {"BP": bp(15), "IP": ["p"] * 12, "CL": CL_OK})
        self.assertTrue(any(l == "FAIL" and k == "IP" and "12 pages, limit 10" in m for l, k, m in f))

    def test_executive_summary_over_one_page(self):
        f = gl.lint(RULES, {"BP": bp(15, exec_pages=3), "IP": ["p"], "CL": CL_OK})
        self.assertTrue(any(l == "FAIL" and "Executive Summary" in m for l, k, m in f))
        f = gl.lint(RULES, {"BP": bp(15, exec_pages=2), "IP": ["p"], "CL": CL_OK})
        self.assertTrue(any(l == "CHECK" and "Executive Summary" in m for l, k, m in f))

    def test_missing_document_fails(self):
        self.assertIn(("FAIL", "IP"), levels(gl.lint(RULES, {"BP": bp(15), "CL": CL_OK})))


class Content(unittest.TestCase):
    def test_blank_mfa_fails_and_none_passes(self):
        blank = ["DECLARATION OF MINIMAL FINANCIAL ASSISTANCE\n1. Date or period of MFA subsidy received:\nTotal amount of MFA subsidy :\n"]
        f = gl.lint(RULES, {"BP": bp(15), "IP": ["p"], "CL": blank})
        self.assertEqual(sum(1 for l, k, m in f if l == "FAIL" and "MFA" in m), 2)

    def test_board_85_phrases_fail(self):
        doc = ["Complaint with the SME definition. Minh is not a customer which you should have known. TODO costs"]
        f = gl.lint(RULES, {"BP": bp(15), "IP": doc, "CL": CL_OK})
        msgs = " ".join(m for l, k, m in f if l == "FAIL")
        self.assertIn("Complaint", msgs)
        self.assertIn("internal note", msgs)

    def test_template_guidance_left_in_fails(self):
        doc = ["Please limit this Incubation Proposal to maximum 10 pages including cover page and any annexes. Task 1"]
        f = gl.lint(RULES, {"BP": bp(15), "IP": doc, "CL": CL_OK}, templates={"IP": TEMPLATE_IP})
        self.assertTrue(any(l == "FAIL" and "template guidance left in" in m for l, k, m in f))
        clean = gl.lint(RULES, {"BP": bp(15), "IP": ["Task 1: build the replay pilot."], "CL": CL_OK}, templates={"IP": TEMPLATE_IP})
        self.assertFalse(any("template guidance" in m for l, k, m in clean))

    def test_overclaims_warn_not_fail(self):
        doc = ["Memoranda of understanding in progress with two partners."]
        f = gl.lint(RULES, {"BP": bp(15), "IP": doc, "CL": CL_OK})
        self.assertTrue(any(l == "WARN" and "MoU" in m for l, k, m in f))
        self.assertFalse(any(l == "FAIL" and k == "IP" for l, k, m in f))

    def test_unknown_limit_is_a_check_never_a_guess(self):
        rules = {"documents": {"X": {"label": "Proposal", "max_pages": None}}}
        self.assertEqual(levels(gl.lint(rules, {"X": ["a", "b"]})), [("CHECK", "X")])


class Cli(unittest.TestCase):
    def test_exit_code_and_summary(self):
        import io, contextlib, tempfile
        with tempfile.TemporaryDirectory() as d:
            txt = Path(d) / "ip.txt"
            txt.write_text("\f".join(["p"] * 12))
            rules = Path(d) / "r.json"
            rules.write_text(json.dumps({"funder": "Test", "documents": {"IP": {"label": "IP", "max_pages": 10}}}))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = gl.main([str(rules), f"IP={txt}"])
        self.assertEqual(rc, 1)
        self.assertIn("grantlint Test: 1 FAIL, 0 WARN, 0 CHECK — not ready to submit", out.getvalue())


if __name__ == "__main__":
    unittest.main()
