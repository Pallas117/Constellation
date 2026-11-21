import assert from "node:assert/strict";
import test from "node:test";
import { dayWords, dueWords, exportAgeDays, exportedWords, groupByStage, safeLink } from "./funding-view";

test("funding view words: days, due and late; missing or malformed is a dash", () => {
  assert.equal(dayWords("2026-11-30"), "30 Nov 2026");
  assert.equal(dayWords("2026-02-01"), "1 Feb 2026");
  assert.equal(dayWords("rolling"), "Rolling");
  for (const missing of [null, undefined, "", "30/11/2026", "2026-13-01", "soon"]) assert.equal(dayWords(missing), "—", String(missing));
  assert.equal(dueWords(0), "today");
  assert.equal(dueWords(1), "in 1 day");
  assert.equal(dueWords(12), "in 12 days");
  assert.equal(dueWords(-1), "1 day late");
  assert.equal(dueWords(-10), "10 days late");
  assert.equal(dueWords(Number.NaN), "—");
});

test("funding view words: the export's age in the reader's zone; unknown is a dash, never 'now'", () => {
  const now = new Date(2026, 10, 18, 16, 0);
  assert.equal(exportedWords(new Date(2026, 10, 18, 14, 20).toISOString(), now), "18 Nov 14:20");
  assert.equal(exportedWords(new Date(2025, 11, 3, 9, 5).toISOString(), now), "3 Dec 2025 09:05");
  for (const missing of [null, undefined, "", "not a time"]) assert.equal(exportedWords(missing, now), "—");
  assert.equal(exportAgeDays(new Date(2026, 10, 18, 14, 20).toISOString(), now), 0);
  assert.equal(exportAgeDays(new Date(2026, 10, 8, 14, 20).toISOString(), now), 10);
  assert.equal(exportAgeDays("not a time", now), null);
});

test("funding view links: only http(s) without credentials is rendered as a link", () => {
  assert.deepEqual(safeLink("https://example.org/call?x=1"), { href: "https://example.org/call?x=1", host: "example.org" });
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "example.org", "https://user:pw@example.org/", "", null, undefined]) assert.equal(safeLink(bad), null, String(bad));
});

test("funding view groups: by stage whatever its case, open stages first, closed last", () => {
  const rows = [
    { row: 5, stage: "Closed - lost", closed: true },
    { row: 6, stage: "Closed - lost", closed: true },
    { row: 7, stage: "Closed - lost", closed: true },
    { row: 4, stage: "drafting", closed: false },
    { row: 2, stage: "Drafting", closed: false },
    { row: 3, stage: null, closed: false },
  ];
  assert.deepEqual(
    groupByStage(rows).map((g) => [g.stage, g.closed, g.rows.map((r) => r.row)]),
    [
      ["drafting", false, [2, 4]],
      [null, false, [3]],
      ["Closed - lost", true, [5, 6, 7]],
    ],
  );
});
