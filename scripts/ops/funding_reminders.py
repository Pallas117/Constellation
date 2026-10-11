#!/usr/bin/env python3
"""Funding deadline reminders and plan for Lightbound / Gauss.

Reads a deadlines file (default: ~/Documents/Gauss Funding/deadlines.json, or
$GAUSS_FUNDING_DEADLINES) and, once a day, texts the phone through `argo notify`
when a call is 30/14/7/3/2/1/0 days out or a prep milestone falls due. Calls
whose date isn't published yet ("tbc") get a Monday nudge to find it.

  funding_reminders.py remind              # daily (LaunchAgent); --dry-run prints instead
  funding_reminders.py plan [--days 45]    # upcoming milestones and deadlines
  funding_reminders.py ics [--out FILE]    # calendar with alarms: a second alert path
  funding_reminders.py outbox --days 90    # every future reminder as JSON lines (to pre-schedule in Slack)

"email_to" beside "calls" in the file adds a daily digest email through Mail.app.
  funding_reminders.py install             # write the 09:00 LaunchAgent; prints how to load it

The file holds call names, dates and owners only: no drafts, numbers or notes.
Standard library only; Python 3.9+.
"""
import argparse, datetime as dt, json, os, subprocess, sys
from pathlib import Path

DEFAULT_FILE = Path.home() / "Documents" / "Gauss Funding" / "deadlines.json"
ARGO = os.environ.get("ARGO", str(Path.home() / ".local" / "bin" / "argo"))
REMIND_DAYS = {30, 14, 7, 3, 2, 1, 0}
# Days before the deadline. ESA BIC UK Board #85 was rejected on format, so the
# grantlint pass and an internal review come well before the submit day, and
# Innovate UK asks to be contacted 15 working days ahead (go/no-go covers it).
MILESTONES = [("go/no-go", 21), ("first draft", 10), ("grantlint pass", 5), ("internal review", 3), ("submit", 1)]
ACTIVE = {"open", "drafting", "verify"}


def load(path):
    with open(path) as f:
        calls = json.load(f)["calls"]
    for c in calls:
        c.setdefault("status", "open")
        if c.get("deadline"):
            d = dt.datetime.fromisoformat(c["deadline"])
            if d.tzinfo is None:
                raise ValueError(f"{c['id']}: deadline needs a UTC offset, e.g. 2026-10-30T13:00:00+01:00")
            c["_deadline"] = d
    return calls


def load_meta(path):
    """Top-level settings beside "calls", e.g. {"email_to": "you@example.com"}."""
    with open(path) as f:
        return {k: v for k, v in json.load(f).items() if k != "calls"}


def milestones(call):
    """[(date, label)] for a call, oldest first; per-call dates in "milestones" override the defaults."""
    if "_deadline" not in call:
        return []
    due = call["_deadline"].date()
    custom = call.get("milestones") or {}
    out = []
    for label, before in MILESTONES:
        when = dt.date.fromisoformat(custom[label]) if label in custom else due - dt.timedelta(days=before)
        out.append((when, label))
    out.append((due, "deadline"))
    return sorted(out)


def when_text(d):
    return d.strftime("%-d %b %H:%M ") + (d.tzname() or d.strftime("%z"))


def reminders(calls, today):
    """[(key, title, message)] to send today."""
    out = []
    for c in calls:
        name = c["name"]
        flag = " (unverified: check the call page)" if c["status"] == "verify" else ""
        if c["status"] == "tbc":
            if today.weekday() == 0:  # Mondays
                out.append((f"funding-{c['id']}-tbc", f"Funding: {name}",
                            f"Deadline not published yet. Check {c.get('url', 'the call page')} and add it to deadlines.json."))
            continue
        if c["status"] not in ACTIVE or "_deadline" not in c:
            continue
        due = c["_deadline"]
        left = (due.date() - today).days
        if left < 0:
            continue
        ms = milestones(c)
        due_today = [label for d, label in ms if d == today and label != "deadline"]
        if left not in REMIND_DAYS and not due_today:
            continue
        nxt = next(((d, label) for d, label in ms if d > today), None)
        parts = ["Closes TODAY" if left == 0 else f"{left} day{'s' if left != 1 else ''} left"]
        parts[0] += f" ({when_text(due)})."
        if due_today:
            parts.append("Due today: " + ", ".join(due_today) + ".")
        if nxt and nxt[1] != "deadline":
            parts.append(f"Next: {nxt[1]} {nxt[0].strftime('%-d %b')}.")
        if c.get("owner"):
            parts.append(f"Owner: {c['owner']}.")
        out.append((f"funding-{c['id']}-{today.isoformat()}", f"Funding: {name}{flag}", " ".join(parts)))
    return out


def notify(key, title, msg):
    # Rate-limited per key in argo, so a second run the same day sends nothing new.
    subprocess.run([ARGO, "notify", "-key", key[:64].lower(), "-every", "20h", title, msg], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)


def email(to, items):
    """One digest email through the Mac's Mail.app (no tokens). Address, subject and body
    are argv items, never interpolated into the script. Returns True if Mail accepted it."""
    subject = f"Funding reminders: {len(items)} today"
    body = "\n\n".join(f"{t}\n{m}" for _, t, m in items) + "\n\n(Sent by scripts/ops/funding_reminders.py)"
    r = subprocess.run(["osascript", "-e", "on run argv", "-e", 'tell application "Mail"',
                        "-e", "set m to make new outgoing message with properties {subject:(item 2 of argv), content:(item 3 of argv), visible:false}",
                        "-e", "tell m to make new to recipient at end of to recipients with properties {address:(item 1 of argv)}",
                        "-e", "send m", "-e", "end tell", "-e", "end run", to, subject, body],
                       capture_output=True, text=True, timeout=120)
    return r.returncode == 0


def outbox(calls, start, days):
    """Every reminder from `start` for `days` days: [(date, key, title, message)], for
    scheduling the same messages in another channel ahead of time (e.g. Slack)."""
    out = []
    for i in range(days):
        d = start + dt.timedelta(days=i)
        out += [(d, k, t, m) for k, t, m in reminders(calls, d)]
    return out


def plan(calls, today, days):
    rows = []
    for c in calls:
        if c["status"] == "tbc":
            rows.append((None, c["name"], "date not published", c.get("owner", "")))
        elif c["status"] in ACTIVE:
            for d, label in milestones(c):
                if today <= d <= today + dt.timedelta(days=days):
                    rows.append((d, c["name"], label, c.get("owner", "")))
    rows.sort(key=lambda r: (r[0] is None, r[0] or today))
    return rows


def ics(calls, now):
    def esc(s):
        return s.replace("\\", "\\\\").replace(",", "\\,").replace(";", "\\;").replace("\n", "\\n")
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lightbound//Gauss funding//EN", "CALSCALE:GREGORIAN",
             "X-WR-CALNAME:Gauss funding deadlines"]
    for c in calls:
        if c["status"] not in ACTIVE or "_deadline" not in c:
            continue
        due = c["_deadline"].astimezone(dt.timezone.utc)
        lines += ["BEGIN:VEVENT", f"UID:{c['id']}-deadline@gauss-funding", f"DTSTAMP:{stamp}",
                  f"DTSTART:{due.strftime('%Y%m%dT%H%M%SZ')}", f"DTEND:{due.strftime('%Y%m%dT%H%M%SZ')}",
                  f"SUMMARY:{esc('DEADLINE ' + c['name'])}", f"URL:{c.get('url', '')}",
                  "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-P2D", f"DESCRIPTION:{esc(c['name'] + ' closes in 2 days')}",
                  "END:VALARM", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT24H",
                  f"DESCRIPTION:{esc(c['name'] + ' closes tomorrow')}", "END:VALARM", "END:VEVENT"]
        for d, label in milestones(c):
            if label == "deadline":
                continue
            slug = label.replace("/", "-").replace(" ", "-")
            lines += ["BEGIN:VEVENT", f"UID:{c['id']}-{slug}@gauss-funding", f"DTSTAMP:{stamp}",
                      f"DTSTART;VALUE=DATE:{d.strftime('%Y%m%d')}",
                      f"DTEND;VALUE=DATE:{(d + dt.timedelta(days=1)).strftime('%Y%m%d')}",
                      f"SUMMARY:{esc(c['name'] + ': ' + label)}", "BEGIN:VALARM", "ACTION:DISPLAY",
                      "TRIGGER:-PT15H", f"DESCRIPTION:{esc(label + ' due: ' + c['name'])}", "END:VALARM", "END:VEVENT"]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"


PLIST = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>uk.lightbound.funding-reminders</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/python3</string><string>-I</string><string>{script}</string><string>remind</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"""


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("cmd", choices=["remind", "plan", "ics", "outbox", "install"])
    ap.add_argument("--file", default=os.environ.get("GAUSS_FUNDING_DEADLINES", str(DEFAULT_FILE)))
    ap.add_argument("--days", type=int, default=45)
    ap.add_argument("--out", default=str(DEFAULT_FILE.with_name("gauss-funding.ics")))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--today", help=argparse.SUPPRESS)  # tests and what-if checks
    a = ap.parse_args(argv)
    today = dt.date.fromisoformat(a.today) if a.today else dt.date.today()
    if a.cmd == "install":
        agent = Path.home() / "Library" / "LaunchAgents" / "uk.lightbound.funding-reminders.plist"
        log = Path.home() / "Library" / "Logs" / "gauss" / "funding-reminders.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        agent.write_text(PLIST.format(script=Path(__file__).resolve(), log=log))
        print(f"wrote {agent}\nload it with:\n  launchctl bootstrap gui/{os.getuid()} '{agent}'")
        return 0
    calls = load(a.file)
    if a.cmd == "remind":
        items = reminders(calls, today)
        for key, title, msg in items:
            print(f"{title}: {msg}") if a.dry_run else notify(key, title, msg)
        to = load_meta(a.file).get("email_to")
        if items and to and not a.dry_run and not email(to, items):
            print("email via Mail.app failed: open Mail once and allow automation", file=sys.stderr)
    elif a.cmd == "outbox":
        for d, key, title, msg in outbox(calls, today, a.days):
            print(json.dumps({"date": d.isoformat(), "key": key, "title": title, "message": msg}))
    elif a.cmd == "plan":
        for d, name, label, owner in plan(calls, today, a.days):
            print(f"{d.strftime('%a %d %b') if d else 'TBC       '}  {label:<16} {name}" + (f"  [{owner}]" if owner else ""))
    elif a.cmd == "ics":
        Path(a.out).write_text(ics(calls, dt.datetime.now(dt.timezone.utc)))
        print(f"wrote {a.out}: open it on the Mac (or AirDrop to the phone) to add the deadlines with alarms")
    return 0


if __name__ == "__main__":
    sys.exit(main())
