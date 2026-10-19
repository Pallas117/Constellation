"""Tests for opportunity_scan.py:  python3 scripts/ops/test_opportunity_scan.py"""
import json, os, sys, tempfile, unittest, zipfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import opportunity_scan as osc  # noqa: E402

IOS = """[12/10/2026, 09:12:33] Aisha: Morning all
[12/10/2026, 09:14:02] Ravi: Seraphim just opened applications for the next accelerator cohort, deadline 14 November 2026: https://accelerator.seraphim.vc/apply
worth a look for Gauss
[12/10/2026, 10:01:10] Aisha: lunch?"""
ANDROID = "13/10/2026, 18:40 - Mei: Open call for startups: ESA BIC Noordwijk, apply by 30 Oct 2026 https://www.sbicnoordwijk.nl/esa-bic/"
EML = b"""From: Space South Central <news@example.org>
To: josh@example.com
Subject: Funding Flash: grants closing soon
Date: Mon, 12 Oct 2026 08:00:00 +0000
Content-Type: text/plain

The UK Space Agency proof-of-concept grant call closes on 21 October 2026. Apply here: https://www.gov.uk/example-call
"""


class Parse(unittest.TestCase):
    def test_whatsapp_ios_multiline_and_android(self):
        msgs = osc.whatsapp_messages(IOS, "chat.txt")
        self.assertEqual([m["from"] for m in msgs], ["Aisha", "Ravi", "Aisha"])
        self.assertIn("worth a look", msgs[1]["text"])
        self.assertEqual(osc.whatsapp_messages(ANDROID, "a.txt")[0]["from"], "Mei")

    def test_deadline_dates_need_a_deadline_word_nearby(self):
        self.assertEqual(osc.dates_near_deadline_words("deadline 14 November 2026"), ["2026-11-14"])
        self.assertEqual(osc.dates_near_deadline_words("apply by Nov 8, 2026"), ["2026-11-08"])
        self.assertEqual(osc.dates_near_deadline_words("we met on 14 November 2026"), [])

    def test_scores_rank_opportunities_above_chat(self):
        self.assertGreaterEqual(osc.score(osc.whatsapp_messages(IOS, "c")[1]["text"]), 3)
        self.assertLess(osc.score("lunch?"), 3)


class Scan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)
        inbox = self.d / "inbox"
        inbox.mkdir()
        (inbox / "WhatsApp Chat - Founders.txt").write_text(IOS)
        with zipfile.ZipFile(inbox / "WhatsApp Chat - Space.zip", "w") as z:
            z.writestr("_chat.txt", ANDROID)
        (inbox / "flash.eml").write_bytes(EML)
        (self.d / "deadlines.json").write_text(json.dumps({"calls": [{"id": "X", "url": "https://www.sbicnoordwijk.nl/esa-bic/"}]}))
        self.args = ["--inbox", str(inbox), "--leads", str(self.d / "leads.json"), "--deadlines", str(self.d / "deadlines.json")]

    def tearDown(self):
        self.tmp.cleanup()

    def test_finds_new_leads_skips_tracked_and_dedupes_on_rerun(self):
        osc.main(self.args)
        leads = json.loads((self.d / "leads.json").read_text())["leads"]
        kinds = sorted(l["kind"] for l in leads)
        self.assertEqual(kinds, ["email", "whatsapp"])  # Noordwijk is already in deadlines.json; chat filler ignored
        sera = next(l for l in leads if l["kind"] == "whatsapp")
        self.assertEqual(sera["deadlines"], ["2026-11-14"])
        self.assertEqual(sera["urls"], ["https://accelerator.seraphim.vc/apply"])
        mail = next(l for l in leads if l["kind"] == "email")
        self.assertEqual(mail["deadlines"], ["2026-10-21"])
        osc.main(self.args)  # second run: nothing new
        self.assertEqual(len(json.loads((self.d / "leads.json").read_text())["leads"]), 2)

    def test_dry_run_writes_nothing(self):
        osc.main(self.args + ["--dry-run"])
        self.assertFalse((self.d / "leads.json").exists())


if __name__ == "__main__":
    unittest.main()
