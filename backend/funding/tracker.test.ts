import assert from "node:assert/strict";
import test from "node:test";
import { SYNTHETIC_TRACKER_CSV, TODAY } from "./fixtures/synthetic-tracker.js";
import { linkOf, MAX_TRACKER_BYTES, MAX_TRACKER_ROWS, parseTracker, parseTrackerDate, stageStatusOf, typeOf, type TrackerSummary } from "./tracker.js";

// Synthetic data only (backend/funding/fixtures/synthetic-tracker.ts): no real tracker is read by any test.
function summaryOf(csv: string, today = TODAY): TrackerSummary {
  const parsed = parseTracker(csv, today);
  assert.ok(parsed.ok, `expected a summary, got ${parsed.ok ? "" : parsed.failure}`);
  return parsed.summary;
}

test("funding tracker: headers match by wording, not case, spacing or punctuation; synonyms map to one field", () => {
  const s = summaryOf(SYNTHETIC_TRACKER_CSV);
  assert.deepEqual(s.rows[0], {
    row: 2,
    name: "Example Ventures seed",
    type: "investor",
    organisation: "Example Ventures",
    stage: "Intro call",
    amount: "EUR 250k",
    deadline: "rolling",
    nextAction: "Send the deck",
    nextActionDate: "2026-11-23",
    owner: "Owner A",
    link: "https://example.org/ventures",
    lastContact: "2026-11-01",
    closed: false,
  });
  const other = summaryOf("Opportunity,Category,Organization,Stage,Ask,Closing date,Next step,Follow-up date,Lead,URL,Last contacted\nExample call,Tender,Example Org,Open,5k,1 Dec 2026,Write,2 Dec 2026,Owner Z,https://example.org/a,3 Nov 2026\n");
  assert.deepEqual(other.rows[0], {
    row: 2,
    name: "Example call",
    type: "bid",
    organisation: "Example Org",
    stage: "Open",
    amount: "5k",
    deadline: "2026-12-01",
    nextAction: "Write",
    nextActionDate: "2026-12-02",
    owner: "Owner Z",
    link: "https://example.org/a",
    lastContact: "2026-11-03",
    closed: false,
  });
  assert.equal(other.ignoredColumns, 0);
});

test("funding tracker: unknown columns are counted and never echoed", () => {
  const s = summaryOf(SYNTHETIC_TRACKER_CSV);
  assert.equal(s.ignoredColumns, 2);
  const out = JSON.stringify(s);
  for (const hidden of ["Private notes", "Probability", "synthetic note alpha", "synthetic note beta", "40%"]) assert.ok(!out.includes(hidden), hidden);
  // A second column for a field already matched is ignored too: the first one wins.
  const twice = summaryOf("Name,Status,Stage\nExample row,First,Second\n");
  assert.equal(twice.rows[0].stage, "First");
  assert.equal(twice.ignoredColumns, 1);
});

test("funding tracker: dates are ISO, worded or Rolling; slashed dates are refused as ambiguous with their row numbers", () => {
  assert.deepEqual(parseTrackerDate("2026-11-01"), { kind: "date", iso: "2026-11-01" });
  assert.deepEqual(parseTrackerDate(" 1 Nov 2026 "), { kind: "date", iso: "2026-11-01" });
  assert.deepEqual(parseTrackerDate("18 December 2026"), { kind: "date", iso: "2026-12-18" });
  assert.deepEqual(parseTrackerDate("Rolling"), { kind: "rolling" });
  assert.deepEqual(parseTrackerDate("always open"), { kind: "rolling" });
  assert.deepEqual(parseTrackerDate(""), { kind: "empty" });
  for (const slashed of ["04/11/2026", "11/04/26", "4.11.2026", "2026/11/04"]) assert.deepEqual(parseTrackerDate(slashed), { kind: "ambiguous" }, slashed);
  for (const bad of ["2026-02-31", "31 Feb 2026", "1 Foo 2026", "soon", "2026-11", "1 Nov 26", "1 Nov 1999", "x".repeat(200)]) assert.deepEqual(parseTrackerDate(bad), { kind: "invalid" }, bad);

  const s = summaryOf(SYNTHETIC_TRACKER_CSV);
  const dateProblems = s.problems.filter((p) => p.field === "deadline" || p.field === "lastContact").map((p) => [p.row, p.field, p.reason.split(":")[0]]);
  assert.deepEqual(dateProblems, [
    [4, "deadline", "slashed or dotted date is ambiguous (day/month or month/day)"],
    [9, "lastContact", "not a date"], // "Rolling" only means something for a deadline
    [10, "deadline", "not a date"],
  ]);
  assert.equal(s.rows.find((r) => r.row === 4)?.deadline, null, "an ambiguous date is not guessed");
});

test("funding tracker: problems carry row numbers and fixed reasons, never cell contents", () => {
  const s = summaryOf(SYNTHETIC_TRACKER_CSV);
  assert.deepEqual(
    s.problems.map((p) => `${p.row} ${p.field}`),
    ["4 deadline", "7 name", "9 link", "9 lastContact", "10 deadline"],
  );
  const reasons = s.problems.map((p) => p.reason).join("\n");
  for (const cell of ["04/11/2026", "Nameless", "javascript", "alert", "2026-02-31", "Rolling"]) assert.ok(!reasons.includes(cell), cell);
  // The empty row 8 is skipped without a problem, and the row without a name is left out.
  assert.deepEqual(s.rows.map((r) => r.row), [2, 3, 4, 5, 6, 9, 10]);
});

test("funding tracker: types are a fixed set; amounts stay as written and are never summed", () => {
  const s = summaryOf(SYNTHETIC_TRACKER_CSV);
  assert.deepEqual(s.counts.byType, { investor: 2, grant: 2, programme: 1, bid: 1, other: 1 });
  assert.equal(s.counts.total, 7);
  assert.deepEqual(s.rows.map((r) => r.amount), ["EUR 250k", "£50 000", null, "USD 1.2m", "10000", null, "1,000,000 (two tranches)"]);
  assert.deepEqual(Object.keys(s.counts), ["total", "byType", "byStage"], "counts of rows only: no summed amount");
  assert.equal(typeOf(" Accelerator "), "programme");
  assert.equal(typeOf("RFP"), "bid");
  assert.equal(typeOf("Angel"), "investor");
  assert.equal(typeOf(""), "other");
  assert.equal(typeOf("<script>"), "other");
});

test("funding tracker: counts by stage; upcoming is the next 30 days, overdue is past and not closed", () => {
  const s = summaryOf(SYNTHETIC_TRACKER_CSV);
  assert.deepEqual(s.counts.byStage, [
    { stage: "Intro call", count: 3 },
    { stage: "Drafting", count: 2 },
    { stage: "Closed - lost", count: 1 },
    { stage: "Submitted", count: 1 },
  ]);
  assert.deepEqual(s.upcoming, [
    { row: 2, kind: "nextAction", date: "2026-11-23", days: 5 },
    { row: 3, kind: "deadline", date: "2026-11-30", days: 12 },
    { row: 6, kind: "nextAction", date: "2026-12-18", days: 30 }, // day 30 is in; row 9's day 31 is out
  ]);
  assert.deepEqual(s.overdue, [
    { row: 9, kind: "deadline", date: "2026-11-08", days: -10 },
    { row: 4, kind: "nextAction", date: "2026-11-15", days: -3 },
  ]);
  // Row 5 is closed (its past deadline is not overdue); row 6 was submitted (its deadline is met).
  assert.equal(s.rows.find((r) => r.row === 5)?.closed, true);
  assert.ok(![...s.upcoming, ...s.overdue].some((d) => d.row === 5 || (d.row === 6 && d.kind === "deadline")));
  // Due today is upcoming, not overdue.
  assert.deepEqual(summaryOf("Name,Deadline\nExample row,2026-11-18\n").upcoming, [{ row: 2, kind: "deadline", date: "2026-11-18", days: 0 }]);
});

test("funding tracker: links must be http(s) without credentials; they are returned as text", () => {
  assert.equal(linkOf("https://example.org/a?b=1"), "https://example.org/a?b=1");
  assert.equal(linkOf(" http://example.org "), "http://example.org/");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/hosts", "example.org", "https://user:pw@example.org/", "https://example.org/a b", `https://example.org/${"a".repeat(600)}`, ""]) {
    assert.equal(linkOf(bad), null, bad.slice(0, 40));
  }
});

test("funding tracker: size, row and cell caps", () => {
  assert.deepEqual(parseTracker(`Name\n${"x".repeat(MAX_TRACKER_BYTES)}`, TODAY), { ok: false, failure: "too-large" });

  const many = summaryOf(`Name\n${Array.from({ length: MAX_TRACKER_ROWS + 5 }, (_, i) => `Example row ${i}`).join("\n")}\n`);
  assert.equal(many.rows.length, MAX_TRACKER_ROWS);
  assert.deepEqual(many.problems, [{ row: 0, field: "file", reason: `more than ${MAX_TRACKER_ROWS} rows: 5 left out` }]);

  const long = summaryOf(`Name,Next action,Status\n${"n".repeat(500)},${"a".repeat(5000)},${"s".repeat(90)}\n`);
  assert.equal(long.rows[0].name.length, 140);
  assert.equal(long.rows[0].nextAction?.length, 240);
  assert.equal(long.rows[0].stage?.length, 40);
  assert.deepEqual(long.problems.map((p) => `${p.row} ${p.field} ${p.reason}`), ["2 name longer than 140 characters: cut", "2 stage longer than 40 characters: cut", "2 nextAction longer than 240 characters: cut"]);
});

test("funding tracker: not CSV, or no Name column, is refused with a code and no contents", () => {
  assert.deepEqual(parseTracker("<!DOCTYPE html><html><body>Sign in</body></html>", TODAY), { ok: false, failure: "not-csv" });
  assert.deepEqual(parseTracker('Name,Status\n"Example never closes,Open\n', TODAY), { ok: false, failure: "not-csv" });
  assert.deepEqual(parseTracker("Name\nExample\u0000binary\n", TODAY), { ok: false, failure: "not-csv" });
  assert.deepEqual(parseTracker("Status,Deadline\nOpen,2026-11-30\n", TODAY), { ok: false, failure: "no-name-column" });
  assert.deepEqual(parseTracker("", TODAY), { ok: false, failure: "no-name-column" });
  // A header and no rows is an empty tracker, not an error.
  assert.equal(summaryOf("Name,Status\n").counts.total, 0);
});

test("funding tracker: control characters and line breaks inside cells become spaces", () => {
  const s = summaryOf('Name,Owner\n"Example\tname\u0007\nsecond line","Owner\u2028A"\n');
  assert.equal(s.rows[0].name, "Example name second line");
  assert.equal(s.rows[0].owner, "Owner A");
});

test("funding tracker: stages are closed or submitted only when every word says so; negations and doubt keep the deadline", () => {
  const cases: Array<[string | null, "open" | "submitted" | "closed"]> = [
    // A negation or an instruction wins: the deadline must stay visible.
    ["Not submitted", "open"],
    ["To be submitted", "open"],
    ["Draft (not sent)", "open"],
    ["Not done", "open"],
    ["Complete application", "open"],
    ["Lost contact - chase", "open"],
    ["Lost contact", "open"],
    ["Unsent", "open"],
    ["Pending", "open"],
    ["Submitted? not yet", "open"],
    ["Re-submit", "open"],
    ["Complete", "open"],
    ["Submitted, awaiting decision", "open"],
    // Unknown or empty stages are open.
    [null, "open"],
    ["", "open"],
    ["Intro call", "open"],
    ["Drafting", "open"],
    // The normal positives.
    ["Submitted", "submitted"],
    ["submitted 3 Nov", "submitted"],
    ["Sent", "submitted"],
    ["Applied", "submitted"],
    ["Application sent", "submitted"],
    ["Closed", "closed"],
    ["Closed - lost", "closed"],
    ["Won", "closed"],
    ["Lost", "closed"],
    ["Awarded", "closed"],
    ["Rejected", "closed"],
    ["Withdrawn", "closed"],
    ["DECLINED", "closed"],
    ["Done", "closed"],
    ["Completed", "closed"],
    ["Not selected", "closed"],
    ["Submitted - rejected", "closed"],
  ];
  for (const [stage, expected] of cases) assert.equal(stageStatusOf(stage), expected, `stage ${JSON.stringify(stage)}`);
});

test("funding tracker: a negated stage keeps its row due or overdue", () => {
  const csv = [
    "Name,Stage,Deadline",
    "Row not submitted,Not submitted,2026-11-20",
    "Row to be submitted,To be submitted,2026-11-21",
    "Row draft,Draft (not sent),2026-11-22",
    "Row not done,Not done,2026-11-10",
    "Row complete application,Complete application,2026-11-11",
    "Row lost contact,Lost contact - chase,2026-11-12",
    "Row submitted,Submitted,2026-11-23",
    "Row closed,Closed - lost,2026-11-13",
    "",
  ].join("\n");
  const s = summaryOf(csv);
  assert.deepEqual(s.rows.map((r) => r.closed), [false, false, false, false, false, false, false, true]);
  assert.deepEqual(s.upcoming, [
    { row: 2, kind: "deadline", date: "2026-11-20", days: 2 },
    { row: 3, kind: "deadline", date: "2026-11-21", days: 3 },
    { row: 4, kind: "deadline", date: "2026-11-22", days: 4 },
  ]);
  assert.deepEqual(
    s.overdue.map((d) => d.row).sort((a, b) => a - b),
    [5, 6, 7],
  );
});
