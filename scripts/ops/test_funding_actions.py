"""Tests for funding_actions.py:  python3 scripts/ops/test_funding_actions.py"""
import datetime as dt, os, sys, unittest

sys.path.insert(0, os.path.dirname(__file__))
import funding_actions as fx  # noqa: E402

D = lambda s: dt.datetime.fromisoformat(s)
ANSWERS = {
    "name": {"value": "Lightbound", "status": "verified", "source": ""},
    "mfa": {"value": "", "status": "decision", "source": ""},
    "export": {"value": "", "status": "decision", "source": ""},
    "problem": {"value": "Radiation corrupts outputs.", "status": "draft", "source": ""},
}
REQS = {"C1": {"name": "Call one", "source": "", "rules": {}, "items": [
    {"id": "Q2", "section": "S", "ask": "Address", "kind": "field", "answers": ["name"]},
    {"id": "Q6", "section": "S", "ask": "Export licence", "kind": "choice", "answers": ["export"]},
    {"id": "Q7", "section": "S", "ask": "Trusted research", "kind": "narrative", "answers": ["export"]},
    {"id": "SUB", "section": "S", "ask": "Subsidy", "kind": "field", "answers": ["mfa"]},
    {"id": "CV", "section": "S", "ask": "CVs", "kind": "document", "answers": []},
    {"id": "Q9", "section": "S", "ask": "Need", "kind": "narrative", "answers": ["problem"]},
    {"id": "Q14", "section": "S", "ask": "Project management", "kind": "narrative", "answers": []},
]}}


def calls(deadline="2026-11-18T11:00:00+00:00", status="open"):
    return [{"id": "C1", "name": "Call one", "status": status, "deadline": deadline, "_deadline": D(deadline)}]


class Plan(unittest.TestCase):
    def test_three_to_six_actions_decisions_first_and_merged(self):
        acts = fx.plan(calls(), REQS, ANSWERS, {}, dt.date(2026, 10, 15))
        self.assertTrue(3 <= len(acts) <= 6)
        texts = [t for _, _, t, _ in acts]
        self.assertTrue(texts[0].startswith("Call one: Decide Q6"))
        self.assertIn("(also unblocks Q7)", texts[0])  # one action per missing decision
        self.assertFalse(any("Decide Q7" in t for t in texts))
        self.assertTrue(any("Produce CV" in t for t in texts))

    def test_milestones_and_closing_soon_come_first(self):
        acts = fx.plan(calls(), REQS, ANSWERS, {}, dt.date(2026, 11, 13))  # grantlint day, 5 days out
        self.assertEqual([a[2] for a in acts[:2]], ["Call one: first draft", "Call one: grantlint pass"])  # overdue first
        self.assertIn("overdue since 8 Nov", acts[0][3])
        acts = fx.plan(calls(), REQS, ANSWERS, {}, dt.date(2026, 11, 16))
        self.assertTrue(any("finish and submit" in a[2] for a in acts))

    def test_done_items_and_milestones_are_skipped(self):
        done = {"C1": ["Q6", "Q7", "SUB", "CV", "first draft", "grantlint pass"]}
        acts = fx.plan(calls(), REQS, ANSWERS, done, dt.date(2026, 11, 13))
        texts = " ".join(a[2] for a in acts)
        self.assertNotIn("Q6", texts)
        self.assertNotIn("grantlint pass", texts)

    def test_dropped_calls_are_ignored(self):
        self.assertEqual(fx.plan(calls(status="dropped"), REQS, ANSWERS, {}, dt.date(2026, 10, 15)), [])

    def test_never_more_than_six(self):
        many = {"C1": dict(REQS["C1"], items=[dict(REQS["C1"]["items"][4], id=f"D{i}") for i in range(10)])}
        self.assertEqual(len(fx.plan(calls(), many, ANSWERS, {}, dt.date(2026, 10, 15))), 6)


if __name__ == "__main__":
    unittest.main()
