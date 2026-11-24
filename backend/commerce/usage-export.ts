/**
 * Invoicing export for pilots (GAU-70): trust records issued per spacecraft per month, as CSV.
 * Pilots are invoiced per spacecraft-month and per 1,000 trust records; the totals here are
 * counted from the append-only trust_issued log, so they reconcile with what was returned.
 *
 * Spacecraft IDs come from customers, so every field is quoted per RFC 4180, and a field that a
 * spreadsheet would run as a formula (=, +, -, @, tab, CR) is prefixed with a single quote.
 */
import type { TrustUsageRow } from "./store.js";

const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV field: formula-safe, quoted, embedded quotes doubled. */
export function csvField(value: string | number): string {
  const text = String(value);
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export interface TrustUsageSummary {
  records: number;
  /** Distinct (month, spacecraft) pairs: the spacecraft-months to invoice. */
  spacecraftMonths: number;
}

export function summarise(rows: TrustUsageRow[]): TrustUsageSummary {
  return { records: rows.reduce((n, r) => n + r.records, 0), spacecraftMonths: rows.length };
}

/** Header plus one line per month and spacecraft, CRLF line ends (RFC 4180). */
export function trustUsageCsv(orgName: string, rows: TrustUsageRow[]): string {
  const lines = [["month", "organisation", "spacecraft_id", "trust_records"].map(csvField).join(",")];
  for (const r of rows) lines.push([r.month, orgName, r.spacecraftId, r.records].map(csvField).join(","));
  return lines.join("\r\n") + "\r\n";
}
