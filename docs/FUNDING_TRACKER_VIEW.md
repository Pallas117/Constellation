# Funding tracker view (admins only)

`/operator/funding` shows a read-only copy of a funding tracker (investors approached, grant and
programme applications, bids) to admins of the operator app. The data stays on the machine that
runs the backend: the backend reads one CSV file you export yourself. Nothing is uploaded, no
spreadsheet is connected, and the page cannot edit anything. The spreadsheet stays the source of
truth; the page always shows when its copy was exported.

This repository is public. It holds the code and a synthetic fixture
(`backend/funding/fixtures/synthetic-tracker.ts`) only. Never commit an export.

## Switch it on

1. Export the tracker tab as CSV (in Google Sheets: File, Download, Comma-separated values).
2. Keep the file in a folder outside every checkout of this repository, and `chmod 600` it.
3. Set `FUNDING_TRACKER_CSV` to the file's absolute path in the backend's environment (the `.env`
   of the checkout the backend runs from; `.env` is git-ignored), then restart the backend.
4. Sign in as an admin, open the operator console and choose "Funding". Export again and press
   Reload whenever the spreadsheet changes; the page never refreshes itself.

Empty or unset `FUNDING_TRACKER_CSV` means the view is off: the route answers
`{ "configured": false }` and the page shows these steps.

## What it reads

The first row is the header. Headers are matched without regard to case, spacing or punctuation,
and a few synonyms are accepted (`backend/funding/tracker.ts`, `HEADERS`):

| Field | Header | Notes |
|---|---|---|
| Name (required) | Name, Opportunity, Programme, Title, Investor, Application, Bid, Call | Rows without one are left out and reported |
| Type | Type, Category, Kind | investor, grant, programme, bid; anything else is "other" |
| Organisation | Organisation, Funder, Organiser, Provider, Firm, Company, Agency | |
| Stage | Stage, Status, State, Progress | Groups the pipeline; "closed", "won", "lost", "declined", "rejected", "withdrawn", "awarded" and similar end a row |
| Amount | Amount, Ask, Value, Funding, Award, Ticket size | Shown as written; never parsed or summed |
| Deadline | Deadline, Closes, Closing date, Due, Due date | `2026-11-01`, `1 Nov 2026` or `Rolling` |
| Next action | Next action, Next step, Action, Follow up, To do | |
| Next action date | Next action date, Next step date, Follow-up date | `2026-11-01` or `1 Nov 2026` |
| Owner | Owner, Lead, Assignee, Responsible | |
| Link | Link, URL, Website, Apply | http(s) only |
| Last contact | Last contact, Last contacted, Last update | `2026-11-01` or `1 Nov 2026` |

Any other column is ignored: the page shows how many, never their headers or contents.

Slashed or dotted dates (`04/11/2026`) are refused, because the day and month can't be told
apart; the page lists the sheet rows to fix. "Due in the next 30 days" and "Overdue" use the
deadline and the next action date. A closed row is never overdue, and a row whose stage says
submitted, applied or sent has met its deadline.

## Limits and refusals

- Admins only: no session 401, any lower role 403 (`API_POLICY`, `backend/rbac.ts`). `GET` only.
- A path inside the repository is refused, also through a symlink.
- At most 2 MB and 1,000 rows; long cells are cut and reported.
- A failure (file missing, not CSV, no Name column) is shown as a fixed sentence. The backend logs
  a code only: never the path, a header or a cell.
- Answers are sent with `cache-control: no-store` and are not cached by the backend.
