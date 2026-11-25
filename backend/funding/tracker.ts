/**
 * The admin-only funding tracker view: a CSV export of the private pipeline (investors approached,
 * grant and programme applications, bids) that lives on this machine, read and summarised in memory.
 *
 * Pure: text in, summary out. Nothing here touches the disk, the network or the log, and nothing
 * here writes back: the spreadsheet is the source of truth and this is a dated copy of it.
 * Row contents never go into a problem or an error: those carry row numbers, a field name and a
 * fixed reason, so they are safe to log and to show beside the data.
 */
import { parseCsv } from "../trust/ingest.js";

/** Refused above this size before it is parsed (the route also refuses it before reading). */
export const MAX_TRACKER_BYTES = 2 * 1024 * 1024;
/** Rows kept; the rest are counted and reported, never read into the answer. */
export const MAX_TRACKER_ROWS = 1000;
/** Deadlines and next actions this many days ahead count as upcoming. */
export const UPCOMING_DAYS = 30;

export const FUNDING_TYPES = ["investor", "grant", "programme", "bid", "other"] as const;
export type FundingType = (typeof FUNDING_TYPES)[number];

export type FundingField = "name" | "type" | "organisation" | "stage" | "amount" | "deadline" | "nextAction" | "nextActionDate" | "owner" | "link" | "lastContact";

/**
 * Header wording each field answers to, after lower-casing and turning every run of spaces and
 * punctuation into one space ("Next-Action  Date" and "next action date" are the same header).
 * The first column that matches a field wins; any other column is counted as ignored.
 */
const HEADERS: Record<FundingField, readonly string[]> = {
  name: ["name", "opportunity", "programme", "program", "title", "item", "investor", "application", "bid", "call"],
  type: ["type", "category", "kind"],
  organisation: ["organisation", "organization", "org", "funder", "funder organisation", "funder organization", "organisation funder", "organiser", "organizer", "provider", "firm", "company", "agency", "run by"],
  stage: ["stage", "status", "state", "pipeline stage", "progress"],
  amount: ["amount", "ask", "value", "funding", "award", "ticket", "ticket size", "amount sought", "indicative value"],
  deadline: ["deadline", "closes", "closing date", "due", "due date", "submission deadline"],
  nextAction: ["next action", "next step", "next steps", "action", "follow up", "to do", "todo"],
  nextActionDate: ["next action date", "next step date", "action date", "follow up date", "next action due", "next action by", "next date"],
  owner: ["owner", "lead", "assignee", "responsible", "who"],
  link: ["link", "url", "website", "apply", "official link", "official url"],
  lastContact: ["last contact", "last contacted", "last contact date", "last touch", "last update", "contacted"],
};

/** The accepted header wording, for the page's "how to switch this on" text and the docs. */
export const ACCEPTED_HEADERS: Readonly<Record<FundingField, readonly string[]>> = HEADERS;

/** Longest text kept per field (characters); longer cells are cut and reported. */
const MAX_CELL: Record<Exclude<FundingField, "type" | "deadline" | "nextActionDate" | "lastContact" | "link">, number> = {
  name: 140,
  organisation: 100,
  stage: 40,
  amount: 60,
  nextAction: 240,
  owner: 60,
};
const MAX_LINK = 500;
const MAX_DATE_CELL = 40;

const TYPE_WORDS: ReadonlyArray<[FundingType, RegExp]> = [
  ["investor", /^(investor|investors|investment|vc|angel|angels|fund|equity)$/],
  ["grant", /^(grant|grants)$/],
  ["programme", /^(programme|programmes|program|programs|accelerator|incubator|incubation)$/],
  ["bid", /^(bid|bids|tender|tenders|rfp|proposal|contract|procurement)$/],
];

/**
 * How a free-text stage is read. "closed" ends a row (nothing about it is overdue or upcoming any
 * more); "submitted" means the application went in (its deadline is met, a dated next action still
 * counts); anything else is "open". A missed grant deadline costs far more than a stale one shown,
 * so every doubt falls to "open": a negation or instruction word anywhere ("Not submitted",
 * "To be sent", "Draft (not sent)", "Lost contact - chase", "Complete application") wins, and a
 * stage counts as closed or submitted only when EVERY word in it is a known status word, a filler
 * word or part of a date ("Closed - lost", "Submitted 3 Nov", "Application sent").
 */
export type StageStatus = "open" | "submitted" | "closed";
/** Whole stages that are an outcome even though they start with a negation. */
const CLOSED_WHOLE_STAGES = new Set(["not selected", "not successful", "not funded", "not awarded"]);
const CLOSED_WORDS = new Set(["closed", "won", "lost", "declined", "rejected", "withdrawn", "awarded", "completed", "done", "dead", "unsuccessful", "funded", "invested"]);
const SUBMITTED_WORDS = new Set(["submitted", "applied", "sent"]);
/** Words that make any stage open, whatever else it says. */
const OPEN_GUARD_WORDS = new Set([
  "not", "no", "never", "yet", "draft", "drafting", "drafted", "unsent", "unsubmitted", "pending",
  "chase", "chasing", "todo", "tbd", "tbc", "complete", "resubmit", "resend", "reapply", "planned", "plan",
]);
const OPEN_GUARD_PHRASES = [/\bto (be|do)\b/, /\bcomplete (the |an )?application\b/, /\bre (submit|send|apply)\b/];
/** Words that may sit next to a status word without changing it. */
const FILLER_WORDS = new Set(["and", "on", "application", "proposal", "bid"]);
const MONTH_WORDS = new Set([
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
]);
const DATE_NUMBER = /^\d{1,4}(st|nd|rd|th)?$/;

/** A stage cell -> open, submitted or closed. Unknown or mixed wording is open (the deadline stays shown). */
export function stageStatusOf(stage: string | null | undefined): StageStatus {
  if (stage === null || stage === undefined) return "open";
  const normalised = stage.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (normalised === "") return "open";
  if (CLOSED_WHOLE_STAGES.has(normalised)) return "closed";
  if (OPEN_GUARD_PHRASES.some((p) => p.test(normalised))) return "open";
  let closed = false;
  let submitted = false;
  for (const w of normalised.split(" ")) {
    if (OPEN_GUARD_WORDS.has(w)) return "open";
    if (CLOSED_WORDS.has(w)) closed = true;
    else if (SUBMITTED_WORDS.has(w)) submitted = true;
    else if (!FILLER_WORDS.has(w) && !MONTH_WORDS.has(w) && !DATE_NUMBER.test(w)) return "open";
  }
  return closed ? "closed" : submitted ? "submitted" : "open";
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export interface FundingRow {
  /** The row's number in the sheet (the header is row 1), so a problem can be found there. */
  row: number;
  name: string;
  type: FundingType;
  organisation: string | null;
  stage: string | null;
  /** As written in the sheet. Never parsed or summed: currencies differ. */
  amount: string | null;
  /** YYYY-MM-DD, "rolling", or null when empty or not a date this parser accepts. */
  deadline: string | null;
  nextAction: string | null;
  /** YYYY-MM-DD or null. */
  nextActionDate: string | null;
  owner: string | null;
  /** An http(s) URL as text, or null. The page renders it; nothing here fetches it. */
  link: string | null;
  /** YYYY-MM-DD or null. */
  lastContact: string | null;
  closed: boolean;
}

export interface DueItem {
  row: number;
  kind: "deadline" | "nextAction";
  /** YYYY-MM-DD */
  date: string;
  /** Whole days from `today`: negative when overdue. */
  days: number;
}

export interface TrackerProblem {
  /** Sheet row number; 0 for a problem with the whole file. */
  row: number;
  field: FundingField | "file";
  /** One of a fixed set of sentences; never a cell's text. */
  reason: string;
}

export interface TrackerSummary {
  rows: FundingRow[];
  counts: { total: number; byType: Record<FundingType, number>; byStage: Array<{ stage: string | null; count: number }> };
  upcoming: DueItem[];
  overdue: DueItem[];
  problems: TrackerProblem[];
  /** How many columns matched no field. A count only: their headers and cells are never returned. */
  ignoredColumns: number;
}

export type TrackerFailure = "too-large" | "not-csv" | "no-name-column";

const normaliseHeader = (h: string) =>
  h
    .replace(/^\uFEFF/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** One line of text: control characters and runs of white space become single spaces. */
const clean = (v: string | undefined) =>
  (v ?? "")
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const pad = (n: number) => String(n).padStart(2, "0");

/** A real calendar day as YYYY-MM-DD, or null (31 Feb is not rolled over into March). */
function isoDay(year: number, month: number, day: number): string | null {
  const t = new Date(Date.UTC(year, month - 1, day));
  if (t.getUTCFullYear() !== year || t.getUTCMonth() !== month - 1 || t.getUTCDate() !== day) return null;
  if (year < 2000 || year > 2100) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

export type ParsedDate = { kind: "empty" } | { kind: "date"; iso: string } | { kind: "rolling" } | { kind: "ambiguous" } | { kind: "invalid" };

/**
 * `2026-11-01`, `1 Nov 2026` / `1 November 2026`, or `Rolling` (also open, ongoing, always open).
 * A slashed date is refused as ambiguous: 04/11 is 4 November in the UK and 11 April in the US
 * (website/worker/feeds.js normaliseProgrammes refuses them for the same reason).
 */
export function parseTrackerDate(value: string | undefined): ParsedDate {
  const s = clean(value);
  if (s === "") return { kind: "empty" };
  if (s.length > MAX_DATE_CELL) return { kind: "invalid" };
  if (/^(rolling|open|ongoing|always open)$/i.test(s)) return { kind: "rolling" };
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const day = isoDay(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return day ? { kind: "date", iso: day } : { kind: "invalid" };
  }
  const worded = /^(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4})$/.exec(s);
  if (worded) {
    const word = worded[2].toLowerCase();
    const month = (word.length === 3 ? MONTHS.indexOf(word) : MONTH_NAMES.indexOf(word)) + 1;
    const day = month > 0 ? isoDay(Number(worded[3]), month, Number(worded[1])) : null;
    return day ? { kind: "date", iso: day } : { kind: "invalid" };
  }
  if (/^\d{1,4}[/.]\d{1,2}[/.]\d{1,4}$/.test(s)) return { kind: "ambiguous" };
  return { kind: "invalid" };
}

export function typeOf(value: string | undefined): FundingType {
  const s = clean(value).toLowerCase();
  return TYPE_WORDS.find(([, re]) => re.test(s))?.[0] ?? "other";
}

/** An http(s) URL without credentials in it, as text; null for anything else. */
export function linkOf(value: string | undefined): string | null {
  const s = (value ?? "").trim();
  if (s === "" || s.length > MAX_LINK || /\s/.test(s)) return null;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return url.href;
}

const daysBetween = (fromIso: string, toIso: string) => Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);

/**
 * The export as text -> the admin view's summary. `today` is the reader's calendar day
 * (YYYY-MM-DD): upcoming is today to today + 30 days, overdue is before today on a row whose
 * stage is not closed.
 */
export function parseTracker(text: string, today: string): { ok: true; summary: TrackerSummary } | { ok: false; failure: TrackerFailure } {
  if (text.length > MAX_TRACKER_BYTES) return { ok: false, failure: "too-large" };
  // A sign-in page or an error page saved under a .csv name is not an export.
  if (/^\uFEFF?\s*<(?:!doctype|html|\?xml)/i.test(text) || text.includes("\u0000")) return { ok: false, failure: "not-csv" };
  const parsed = parseCsv(text.replace(/^\uFEFF/, ""));
  if ("error" in parsed) return { ok: false, failure: "not-csv" };
  const [head = [], ...body] = parsed.rows;

  const at: Partial<Record<FundingField, number>> = {};
  let ignoredColumns = 0;
  head.forEach((h, i) => {
    const wording = normaliseHeader(h);
    const field = (Object.keys(HEADERS) as FundingField[]).find((f) => HEADERS[f].includes(wording));
    if (field && at[field] === undefined) at[field] = i;
    else ignoredColumns += 1;
  });
  if (at.name === undefined) return { ok: false, failure: "no-name-column" };

  const problems: TrackerProblem[] = [];
  const rows: FundingRow[] = [];
  let beyondCap = 0;

  body.forEach((cells, index) => {
    const row = index + 2; // the header is sheet row 1
    if (cells.every((c) => clean(c) === "")) return;
    if (rows.length >= MAX_TRACKER_ROWS) {
      beyondCap += 1;
      return;
    }
    const raw = (f: FundingField) => (at[f] === undefined ? undefined : cells[at[f]]);
    const textOf = (f: keyof typeof MAX_CELL): string | null => {
      const s = clean(raw(f));
      if (s === "") return null;
      if (s.length <= MAX_CELL[f]) return s;
      problems.push({ row, field: f, reason: `longer than ${MAX_CELL[f]} characters: cut` });
      return `${s.slice(0, MAX_CELL[f] - 1)}…`;
    };
    const dateOf = (f: "deadline" | "nextActionDate" | "lastContact"): string | null => {
      const d = parseTrackerDate(raw(f));
      if (d.kind === "date") return d.iso;
      if (d.kind === "rolling") {
        if (f === "deadline") return "rolling";
        problems.push({ row, field: f, reason: "not a date: write it as 2026-11-01 or 1 Nov 2026" });
      } else if (d.kind === "ambiguous") {
        problems.push({ row, field: f, reason: "slashed or dotted date is ambiguous (day/month or month/day): write it as 2026-11-01 or 1 Nov 2026" });
      } else if (d.kind === "invalid") {
        problems.push({ row, field: f, reason: "not a date: write it as 2026-11-01 or 1 Nov 2026" });
      }
      return null;
    };

    const name = textOf("name");
    if (name === null) {
      problems.push({ row, field: "name", reason: "no name: row left out" });
      return;
    }
    const link = linkOf(raw("link"));
    if (link === null && clean(raw("link")) !== "") problems.push({ row, field: "link", reason: "not an http(s) link: left out" });
    const stage = textOf("stage");
    rows.push({
      row,
      name,
      type: typeOf(raw("type")),
      organisation: textOf("organisation"),
      stage,
      amount: textOf("amount"),
      deadline: dateOf("deadline"),
      nextAction: textOf("nextAction"),
      nextActionDate: dateOf("nextActionDate"),
      owner: textOf("owner"),
      link,
      lastContact: dateOf("lastContact"),
      closed: stageStatusOf(stage) === "closed",
    });
  });
  if (beyondCap > 0) problems.push({ row: 0, field: "file", reason: `more than ${MAX_TRACKER_ROWS} rows: ${beyondCap} left out` });

  const byType = Object.fromEntries(FUNDING_TYPES.map((t) => [t, 0])) as Record<FundingType, number>;
  const stages = new Map<string, { stage: string | null; count: number }>();
  const upcoming: DueItem[] = [];
  const overdue: DueItem[] = [];
  for (const r of rows) {
    byType[r.type] += 1;
    const key = (r.stage ?? "").toLowerCase();
    const group = stages.get(key) ?? { stage: r.stage, count: 0 };
    group.count += 1;
    stages.set(key, group);
    if (r.closed) continue;
    const due: Array<[DueItem["kind"], string | null]> = [
      ["deadline", stageStatusOf(r.stage) === "submitted" ? null : r.deadline],
      ["nextAction", r.nextActionDate],
    ];
    for (const [kind, date] of due) {
      if (date === null || date === "rolling") continue;
      const days = daysBetween(today, date);
      if (days < 0) overdue.push({ row: r.row, kind, date, days });
      else if (days <= UPCOMING_DAYS) upcoming.push({ row: r.row, kind, date, days });
    }
  }
  const soonest = (a: DueItem, b: DueItem) => a.days - b.days || a.row - b.row;
  upcoming.sort(soonest);
  overdue.sort(soonest);

  return {
    ok: true,
    summary: {
      rows,
      counts: { total: rows.length, byType, byStage: [...stages.values()].sort((a, b) => b.count - a.count || (a.stage ?? "").localeCompare(b.stage ?? "")) },
      upcoming,
      overdue,
      problems,
      ignoredColumns,
    },
  };
}
