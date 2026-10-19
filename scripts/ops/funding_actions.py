#!/usr/bin/env python3
"""Today's 3-6 funding action points, from the deadlines, the requirements and what's done.

  funding_actions.py [--today 2026-10-15] [--json]

Order (stops at --max, tops up to --min):
  1. prep milestones overdue or due today (deadlines.json)
  2. calls closing within 7 days: finish and submit
  3. for the open calls, nearest deadline first: DECISION items, then documents, then
     narratives to write or rewrite (requirements.json x answer_bank.json)
  4. Mondays: calls with no published date (check the funder's page)
Items marked done in ~/Documents/Gauss Funding/progress.json ({"GAU-103": ["Q8", ...]})
are skipped. The same rules drive the daily email routine reading the Google Sheet.
"""
import argparse, datetime as dt, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import funding_autofill as fa  # noqa: E402
import funding_reminders as fr  # noqa: E402

ACTIVE = {"open", "drafting", "verify"}
VERB = {"DECISION": "Decide", "DOC": "Produce", "WRITE": "Draft", "SEEDED": "Rewrite to the limit"}


def plan(deadline_calls, req_calls, answers, done, today, lo=3, hi=6):
    """[(priority, call_id, action, why)] — between lo and hi items when there is enough to do."""
    acts, seen = [], set()
    add = lambda p, cid, text, why: (text not in seen) and (seen.add(text) or acts.append((p, cid, text, why)))
    dated = sorted((c for c in deadline_calls if c["status"] in ACTIVE and "_deadline" in c), key=lambda c: c["_deadline"])
    for c in dated:  # 1. milestones
        for d, label in fr.milestones(c):
            if label != "deadline" and d <= today and (d - today).days >= -7 and label not in done.get(c["id"], []):
                when = "today" if d == today else f"overdue since {d.strftime('%-d %b')}"
                add(1, c["id"], f"{c['name']}: {label}", f"{when}; closes {fr.when_text(c['_deadline'])}")
    for c in dated:  # 2. closing soon
        left = (c["_deadline"].date() - today).days
        if 0 <= left <= 7:
            add(1, c["id"], f"{c['name']}: finish and submit", f"{left} day(s) left")
    open_ids = [c["id"] for c in dated if c["id"] in req_calls] + [cid for cid in req_calls if cid not in {c["id"] for c in dated}]
    decided = {}  # one action per missing decision, listing every item it unblocks
    for state in ("DECISION", "DOC", "WRITE", "SEEDED"):  # 3. requirement gaps, nearest call first
        for cid in open_ids:
            status = next((c["status"] for c in deadline_calls if c["id"] == cid), "open")
            if status not in ACTIVE and status != "tbc":
                continue
            for item, st, _, notes in fa.call_rows(req_calls[cid], answers):
                if st != state or item["id"] in done.get(cid, []):
                    continue
                why = "; ".join(n for n in notes if n.startswith(("decide", "seeds", "cite", "produce", "contains")))
                if state == "DECISION":
                    keys = tuple(n for n in notes if n.startswith("decide"))
                    if keys in decided:
                        decided[keys][1].append(item["id"])
                        continue
                    decided[keys] = (len(acts), [])
                add(2 if state == "DECISION" else 3, cid, f"{req_calls[cid]['name']}: {VERB[state]} {item['id']} — {item['ask'][:80]}", why)
                if len(acts) >= hi:
                    break
            if len(acts) >= hi:
                break
    for i, extra in decided.values():
        if extra:
            p, cid, text, why = acts[i]
            acts[i] = (p, cid, f"{text} (also unblocks {', '.join(extra)})", why)
    if today.weekday() == 0:  # 4. Monday date checks
        for c in deadline_calls:
            start = dt.date.fromisoformat(c["check_from"]) if c.get("check_from") else today
            if c["status"] == "tbc" and today >= start:
                add(4, c["id"], f"{c['name']}: check for a published deadline", c.get("url", ""))
    acts.sort(key=lambda a: a[0])
    return acts[:hi] if len(acts) >= lo else acts


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--deadlines", default=str(fa.FUND / "deadlines.json"))
    ap.add_argument("--answers", default=str(fa.FUND / "answer_bank.json"))
    ap.add_argument("--requirements", default=str(fa.REPO / "tools" / "grantlint" / "requirements.json"))
    ap.add_argument("--progress", default=str(fa.FUND / "progress.json"))
    ap.add_argument("--today")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    answers, _, reqs = fa.load(a.answers, a.requirements)
    done = json.loads(Path(a.progress).read_text()) if Path(a.progress).exists() else {}
    acts = plan(fr.load(a.deadlines), reqs, answers, done, today)
    if a.json:
        print(json.dumps([{"priority": p, "call": c, "action": t, "why": w} for p, c, t, w in acts], ensure_ascii=False))
    else:
        print(f"Funding actions for {today.strftime('%a %-d %b')}:")
        for i, (p, c, t, w) in enumerate(acts, 1):
            print(f"{i}. {t}" + (f"  ({w})" if w else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
