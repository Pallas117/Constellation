/**
 * A SYNTHETIC tracker export for tests. Every organisation, person, amount and status here is
 * invented; nothing is taken from a real tracker. Keep it that way: the repository is public.
 *
 * Sheet rows (the header is row 1), read on TODAY = 2026-11-18:
 *   2  investor, deadline rolling, next action in 5 days
 *   3  grant, deadline in 12 days
 *   4  programme, slashed deadline (ambiguous), next action 3 days ago (overdue)
 *   5  bid, deadline 8 days ago, stage closed (not overdue)
 *   6  grant, submitted, deadline 4 days ago (met, not overdue), next action in 30 days
 *   7  no name (left out)
 *   8  empty row
 *   9  unknown type, deadline 10 days ago (overdue), link not http(s), next action date in 31 days
 *   10 quoted cell with a comma and a line break, deadline that is not a day (31 Feb)
 */
export const TODAY = "2026-11-18";

export const SYNTHETIC_TRACKER_CSV = [
  "\uFEFFName, TYPE ,Funder / Organisation,Status,Amount,Deadline,Next-Action,Next action date,Owner,Link,Last Contact,Private notes,Probability",
  "Example Ventures seed,Investor,Example Ventures,Intro call,EUR 250k,Rolling,Send the deck,2026-11-23,Owner A,https://example.org/ventures,1 Nov 2026,synthetic note alpha,40%",
  "Sample Space Agency call,Grant,Sample Space Agency,Drafting,£50 000,2026-11-30,,,Owner B,https://example.org/call,2026-11-10,synthetic note beta,",
  "Placeholder Accelerator,Programme,Placeholder Labs,Drafting,,04/11/2026,Book the interview,15 Nov 2026,Owner A,http://example.org/accelerator,,,",
  "Demo Constellation tender,Bid,Demo Operator Ltd,Closed - lost,USD 1.2m,2026-11-10,,,Owner C,,,,",
  "Sample Innovation grant,grant,Sample Innovation Fund,Submitted,10000,2026-11-14,Chase the outcome,18 December 2026,Owner B,,,,",
  ",Grant,Nameless Fund,Drafting,,2026-12-01,,,,,,,",
  ",,,,,,,,,,,,",
  "Mystery Prize,Competition,Example Prize Board,Intro call,,2026-11-08,Decide,2026-12-19,,javascript:alert(1),Rolling,,",
  '"Quoted, Example Fund","VC","Quoted, Example Capital",Intro call,"1,000,000 (two\ntranches)",2026-02-31,,,,https://example.org/quoted,,,',
  "",
].join("\r\n");

/** Cell text that must never reach a log line (fixture words, one per kind of column). */
export const FIXTURE_CELL_WORDS = ["Example Ventures", "Sample Space Agency", "EUR 250k", "Owner A", "synthetic note alpha", "Private notes", "Send the deck", "example.org"];
