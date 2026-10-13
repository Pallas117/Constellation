#!/usr/bin/env python3
"""Find funding opportunities in exported WhatsApp chats and saved emails.

Drop files into ~/Documents/Gauss Funding/inbox/ (or pass --inbox):
  - WhatsApp: a chat's "Export chat" (Without media) .txt, or the .zip it makes
  - Email: .eml files or an .mbox (e.g. a Gmail label exported with Google Takeout)
Nothing is read from WhatsApp's or Mail's own databases: you choose what to scan.

Each message is scored for funding signals (grant, accelerator, cohort, call for
applications, deadline...), with links and dates near deadline words pulled out.
Leads already in deadlines.json, or already seen, are skipped; new ones are added
to leads.json beside it. --notify texts a one-line summary through `argo notify`.

  opportunity_scan.py [--inbox DIR] [--min-score 3] [--notify] [--dry-run]

Standard library only. A lead is a pointer to read, not a verified deadline.
"""
import argparse, datetime as dt, email, email.policy, hashlib, json, mailbox, os, re, subprocess, sys, zipfile
from pathlib import Path

FUND = Path.home() / "Documents" / "Gauss Funding"
ARGO = os.environ.get("ARGO", str(Path.home() / ".local" / "bin" / "argo"))
SIGNALS = {  # weight per signal; a message needs --min-score to count
    r"\bgrants?\b": 2, r"\bfunding\b": 1, r"\baccelerator\b": 2, r"\bincubat(or|ion)\b": 2, r"\bcohort\b": 2,
    r"\bfellowship\b": 2, r"call for (applications|proposals|projects|startups)": 3, r"\bopen call\b": 3,
    r"\bapplications? (are )?(now )?open\b": 3, r"\bapply (now|by|here|before)\b": 2, r"\bdeadline\b": 2,
    r"\bcompetition\b": 1, r"\bpitch(ing)?\b": 1, r"\b(pre-?seed|seed round|angels?|investors?)\b": 1,
    r"\binnovate uk\b|\bukri\b|\besa\b|\bhorizon europe\b|\beic\b": 2, r"\bnon-dilutive\b|\bequity-free\b": 2,
    r"\b(space|satellite|deep ?tech|defen[cs]e|dual-use)\b": 1,
}
MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?"
DATE_RES = [
    re.compile(rf"\b(\d{{1,2}})(?:st|nd|rd|th)?\s+({MONTHS})\.?,?\s+(20\d\d)\b", re.I),
    re.compile(rf"\b({MONTHS})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(20\d\d)\b", re.I),
    re.compile(r"\b(20\d\d)-(\d{2})-(\d{2})\b"),
]
DEADLINE_NEAR = re.compile(r"(deadline|closes?|closing|apply by|due|until|before|submissions?)", re.I)
URL = re.compile(r"https?://[^\s<>\"')\]]+")
# WhatsApp exports: iOS "[13/10/2026, 09:12:33] Name: text", Android "13/10/2026, 09:12 - Name: text"
WA_LINE = re.compile(r"^‎?\[?(\d{1,2}/\d{1,2}/\d{2,4}),? (\d{1,2}:\d{2})(?::\d{2})?(?:\s?[APap][Mm])?\]?(?: -)? ([^:]{1,60}): (.*)$")


def month_num(s):
    return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].index(s[:3].lower()) + 1


def dates_near_deadline_words(text):
    found = set()
    for rx in DATE_RES:
        for m in rx.finditer(text):
            window = text[max(0, m.start() - 60):m.start()]
            if not DEADLINE_NEAR.search(window):
                continue
            g = m.groups()
            try:
                if rx is DATE_RES[0]:
                    d = dt.date(int(g[2]), month_num(g[1]), int(g[0]))
                elif rx is DATE_RES[1]:
                    d = dt.date(int(g[2]), month_num(g[0]), int(g[1]))
                else:
                    d = dt.date(int(g[0]), int(g[1]), int(g[2]))
            except ValueError:
                continue
            found.add(d.isoformat())
    return sorted(found)


def score(text):
    return sum(w for rx, w in SIGNALS.items() if re.search(rx, text, re.I)) + (1 if URL.search(text) else 0)


def whatsapp_messages(text, source):
    msgs, cur = [], None
    for line in text.splitlines():
        m = WA_LINE.match(line)
        if m:
            if cur:
                msgs.append(cur)
            cur = {"source": source, "kind": "whatsapp", "when": f"{m.group(1)} {m.group(2)}", "from": m.group(3).strip(),
                   "text": m.group(4)}
        elif cur:
            cur["text"] += "\n" + line
    if cur:
        msgs.append(cur)
    return msgs


def email_message(msg, source):
    body = msg.get_body(preferencelist=("plain", "html"))
    text = body.get_content() if body else ""
    if body is not None and body.get_content_type() == "text/html":
        text = re.sub(r"<[^>]+>", " ", text)
    return {"source": source, "kind": "email", "when": str(msg.get("date", "")), "from": str(msg.get("from", "")),
            "text": f"{msg.get('subject', '')}\n{text}"}


def read_inbox(inbox):
    msgs = []
    for p in sorted(Path(inbox).glob("*")):
        try:
            if p.suffix == ".zip":
                with zipfile.ZipFile(p) as z:
                    for name in z.namelist():
                        if name.endswith(".txt"):
                            msgs += whatsapp_messages(z.read(name).decode("utf-8", "replace"), f"{p.name}/{name}")
            elif p.suffix == ".txt":
                msgs += whatsapp_messages(p.read_text(errors="replace"), p.name)
            elif p.suffix == ".eml":
                msgs.append(email_message(email.message_from_bytes(p.read_bytes(), policy=email.policy.default), p.name))
            elif p.suffix == ".mbox":
                for m in mailbox.mbox(str(p), factory=lambda f: email.message_from_binary_file(f, policy=email.policy.default)):
                    msgs.append(email_message(m, p.name))
        except (OSError, zipfile.BadZipFile, ValueError) as e:
            print(f"skipped {p.name}: {e}", file=sys.stderr)
    return msgs


def known_keys(deadlines_path, leads):
    keys = {l["id"] for l in leads}
    urls = {u for l in leads for u in l.get("urls", [])}
    try:
        for c in json.loads(Path(deadlines_path).read_text())["calls"]:
            if c.get("url"):
                urls.add(c["url"].rstrip("/"))
    except (OSError, ValueError, KeyError):
        pass
    return keys, urls


def find_leads(msgs, known_ids, known_urls, min_score):
    out = []
    for m in msgs:
        s = score(m["text"])
        if s < min_score:
            continue
        urls = sorted({u.rstrip(".,;:/") for u in URL.findall(m["text"])})
        if urls and all(u.rstrip("/") in known_urls for u in urls):
            continue  # already tracked
        lid = hashlib.sha256((m["from"] + m["text"]).encode()).hexdigest()[:16]
        if lid in known_ids:
            continue
        known_ids.add(lid)
        first = re.sub(r"\s+", " ", m["text"]).strip()
        out.append({"id": lid, "score": s, "kind": m["kind"], "source": m["source"], "from": m["from"], "when": m["when"],
                    "urls": urls, "deadlines": dates_near_deadline_words(m["text"]), "snippet": first[:300],
                    "found": dt.date.today().isoformat(), "status": "new"})
    return sorted(out, key=lambda l: -l["score"])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--inbox", default=str(FUND / "inbox"))
    ap.add_argument("--leads", default=str(FUND / "leads.json"))
    ap.add_argument("--deadlines", default=os.environ.get("GAUSS_FUNDING_DEADLINES", str(FUND / "deadlines.json")))
    ap.add_argument("--min-score", type=int, default=3)
    ap.add_argument("--notify", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    Path(a.inbox).mkdir(parents=True, exist_ok=True)
    leads = json.loads(Path(a.leads).read_text())["leads"] if Path(a.leads).exists() else []
    ids, urls = known_keys(a.deadlines, leads)
    new = find_leads(read_inbox(a.inbox), ids, urls, a.min_score)
    for l in new:
        dl = f" deadline? {', '.join(l['deadlines'])}" if l["deadlines"] else ""
        print(f"[{l['score']:>2}] {l['kind']} · {l['from'][:30]} · {l['snippet'][:110]}{dl}" + (f"\n     {l['urls'][0]}" if l["urls"] else ""))
    print(f"{len(new)} new lead(s) from {a.inbox}" + ("" if a.dry_run else f"; saved to {a.leads}"))
    if new and not a.dry_run:
        Path(a.leads).write_text(json.dumps({"leads": leads + new}, indent=1, ensure_ascii=False))
        if a.notify:
            top = new[0]["snippet"][:80]
            subprocess.run([ARGO, "notify", "-key", "funding-leads", "-every", "1h", f"Funding: {len(new)} new lead(s)",
                            f"Top: {top}. See leads.json; add real calls to deadlines.json."], check=False, timeout=120)
    return 0


if __name__ == "__main__":
    sys.exit(main())
