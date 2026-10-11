"""Tests for funding_reminders.py:  python3 scripts/ops/test_funding_reminders.py"""
import datetime as dt, json, os, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(__file__))
import funding_reminders as fr  # noqa: E402

CALLS = {"calls": [
    {"id": "GAU-102", "name": "ESA Kick-start", "deadline": "2026-10-30T13:00:00+01:00", "owner": "Josh", "url": "https://x"},
    {"id": "GAU-103", "name": "Innovate UK AI", "deadline": "2026-11-18T11:00:00+00:00",
     "milestones": {"go/no-go": "2026-10-28"}},
    {"id": "GAU-105", "name": "ESA BIC UK", "status": "tbc", "url": "https://esa-bic.org.uk/apply/"},
    {"id": "P33", "name": "1337 Alpha", "deadline": "2026-11-08T23:59:00+08:00", "status": "verify"},
    {"id": "OLD", "name": "Submitted one", "deadline": "2026-10-20T12:00:00+00:00", "status": "submitted"},
]}


def load():
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump(CALLS, f)
    try:
        return fr.load(f.name)
    finally:
        os.unlink(f.name)


class Reminders(unittest.TestCase):
    def test_default_milestones_count_back_from_the_deadline(self):
        ms = dict((label, d.isoformat()) for d, label in fr.milestones(load()[0]))
        self.assertEqual(ms, {"go/no-go": "2026-10-09", "first draft": "2026-10-20", "grantlint pass": "2026-10-25",
                              "internal review": "2026-10-27", "submit": "2026-10-29", "deadline": "2026-10-30"})

    def test_custom_milestone_overrides_default(self):
        ms = dict((label, d.isoformat()) for d, label in fr.milestones(load()[1]))
        self.assertEqual(ms["go/no-go"], "2026-10-28")
        self.assertEqual(ms["first draft"], "2026-11-08")

    def test_milestone_day_sends_with_due_and_next(self):
        out = fr.reminders(load(), dt.date(2026, 10, 20))  # Kick-start first draft, 10 days left
        kick = [m for k, t, m in out if k.startswith("funding-GAU-102")]
        self.assertEqual(len(kick), 1)
        self.assertIn("10 days left (30 Oct 13:00 UTC+01:00)", kick[0])
        self.assertIn("Due today: first draft.", kick[0])
        self.assertIn("Next: grantlint pass 25 Oct.", kick[0])
        self.assertIn("Owner: Josh.", kick[0])

    def test_quiet_days_send_nothing(self):
        self.assertEqual(fr.reminders(load(), dt.date(2026, 10, 13)), [])  # a Tuesday, no offsets, no milestones

    def test_countdown_days_and_deadline_day(self):
        msgs = {k.split("-2026")[0]: m for k, t, m in fr.reminders(load(), dt.date(2026, 10, 30))}
        self.assertIn("Closes TODAY", msgs["funding-GAU-102"])
        out = fr.reminders(load(), dt.date(2026, 11, 4))  # 14 days before Innovate UK
        self.assertTrue(any("14 days left" in m for k, t, m in out if "GAU-103" in k))

    def test_unverified_is_flagged_and_submitted_or_past_is_silent(self):
        out = fr.reminders(load(), dt.date(2026, 11, 1))  # 7 days before 1337 Alpha
        titles = [t for k, t, m in out if "P33" in k]
        self.assertEqual(titles, ["Funding: 1337 Alpha (unverified: check the call page)"])
        self.assertFalse(any("OLD" in k for k, t, m in fr.reminders(load(), dt.date(2026, 10, 19))))
        self.assertFalse(any("GAU-102" in k for k, t, m in fr.reminders(load(), dt.date(2026, 11, 2))))

    def test_tbc_nudges_on_mondays_only(self):
        mon = [m for k, t, m in fr.reminders(load(), dt.date(2026, 10, 12)) if k.endswith("-tbc")]
        self.assertEqual(len(mon), 1)
        self.assertIn("https://esa-bic.org.uk/apply/", mon[0])
        self.assertFalse([k for k, t, m in fr.reminders(load(), dt.date(2026, 10, 14)) if k.endswith("-tbc")])

    def test_keys_are_daily_so_argo_sends_once_per_day(self):
        keys = [k for k, t, m in fr.reminders(load(), dt.date(2026, 10, 20))]
        self.assertIn("funding-GAU-102-2026-10-20", keys)

    def test_naive_deadline_is_rejected(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump({"calls": [{"id": "X", "name": "x", "deadline": "2026-10-30T13:00:00"}]}, f)
        try:
            with self.assertRaises(ValueError):
                fr.load(f.name)
        finally:
            os.unlink(f.name)


class PlanAndCalendar(unittest.TestCase):
    def test_plan_is_dated_then_tbc(self):
        rows = fr.plan(load(), dt.date(2026, 10, 19), 12)
        self.assertEqual(rows[0][:3], (dt.date(2026, 10, 20), "ESA Kick-start", "first draft"))
        self.assertEqual(rows[-1][:3], (None, "ESA BIC UK", "date not published"))
        self.assertFalse(any(r[1] == "Submitted one" for r in rows))

    def test_ics_has_utc_deadline_alarms_and_milestones(self):
        cal = fr.ics(load(), dt.datetime(2026, 10, 11, tzinfo=dt.timezone.utc))
        self.assertIn("DTSTART:20261030T120000Z", cal)  # 13:00 CET
        self.assertIn("TRIGGER:-PT24H", cal)
        self.assertIn("DTSTART;VALUE=DATE:20261025", cal)  # Kick-start grantlint pass
        self.assertNotIn("Submitted one", cal)
        self.assertTrue(cal.endswith("END:VCALENDAR\r\n"))


if __name__ == "__main__":
    unittest.main()
