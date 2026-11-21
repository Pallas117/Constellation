// Words and grouping for the admin-only funding tracker view (pages/FundingTracker.tsx).
// The backend answers with ISO days and counts (backend/funding/tracker.ts); this turns them into
// what a person reads. Fail closed: anything missing or malformed is "—", never a guess.

export const DASH = "—";

export type FundingType = "investor" | "grant" | "programme" | "bid" | "other";

export const TYPE_WORD: Record<FundingType, string> = {
  investor: "Investor",
  grant: "Grant",
  programme: "Programme",
  bid: "Bid",
  other: "Other",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-30" -> "30 Nov 2026"; "rolling" -> "Rolling"; anything else -> "—". No time zone is involved. */
export function dayWords(value: string | null | undefined): string {
  if (value === "rolling") return "Rolling";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  const month = m ? MONTHS[Number(m[2]) - 1] : undefined;
  return m && month ? `${Number(m[3])} ${month} ${m[1]}` : DASH;
}

/** Whole days from today -> "today", "in 5 days", "3 days late". */
export function dueWords(days: number): string {
  if (!Number.isFinite(days)) return DASH;
  if (days === 0) return "today";
  const n = Math.abs(Math.trunc(days));
  const unit = n === 1 ? "day" : "days";
  return days > 0 ? `in ${n} ${unit}` : `${n} ${unit} late`;
}

/** The export's file time in the reader's own zone: "18 Nov 14:20" (with the year when it is not this one). */
export function exportedWords(iso: string | null | undefined, now: Date = new Date()): string {
  const t = iso ? new Date(iso) : null;
  if (!t || !Number.isFinite(t.getTime())) return DASH;
  const pad = (n: number) => String(n).padStart(2, "0");
  const year = t.getFullYear() === now.getFullYear() ? "" : ` ${t.getFullYear()}`;
  return `${t.getDate()} ${MONTHS[t.getMonth()]}${year} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** Whole days since the export was written, or null when that is unknown. */
export function exportAgeDays(iso: string | null | undefined, now: Date = new Date()): number | null {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((now.getTime() - t) / 86_400_000)) : null;
}

/** A copy older than this is labelled stale. */
export const STALE_AFTER_DAYS = 7;

/** An http(s) link to render, with the host as its visible text; null for anything else. */
export function safeLink(value: string | null | undefined): { href: string; host: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return { href: url.href, host: url.host };
  } catch {
    return null;
  }
}

/** Rows under their stage, open stages first (largest first), closed stages after, rows by sheet order. */
export function groupByStage<T extends { stage: string | null; closed: boolean; row: number }>(rows: readonly T[]): Array<{ stage: string | null; closed: boolean; rows: T[] }> {
  const groups = new Map<string, { stage: string | null; closed: boolean; rows: T[] }>();
  for (const r of rows) {
    const key = (r.stage ?? "").toLowerCase();
    const group = groups.get(key) ?? { stage: r.stage, closed: r.closed, rows: [] };
    group.rows.push(r);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, rows: [...g.rows].sort((a, b) => a.row - b.row) }))
    .sort((a, b) => Number(a.closed) - Number(b.closed) || b.rows.length - a.rows.length || (a.stage ?? "").localeCompare(b.stage ?? ""));
}
