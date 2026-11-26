import { apiBase } from "./base-url";
import { HttpFailure } from "./http-error";
import type { FundingType } from "@/lib/funding-view";
// Client for the admin-only funding tracker view (GET /api/admin/funding; backend/funding/router.ts).
// Read-only and never polled: one read when the page opens and one per press of "Reload".
// Only call it for an admin: any other role gets a 403, and CyberTiger counts those.
// Session cookies are attached by lib/api/backend-credentials.

export interface FundingRow {
  /** Row number in the sheet (the header is row 1). */
  row: number;
  name: string;
  type: FundingType;
  organisation: string | null;
  stage: string | null;
  /** As written in the sheet; never summed. */
  amount: string | null;
  /** YYYY-MM-DD, "rolling" or null. */
  deadline: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  owner: string | null;
  link: string | null;
  lastContact: string | null;
  closed: boolean;
}

export interface FundingDue {
  row: number;
  kind: "deadline" | "nextAction";
  date: string;
  /** Whole days from the export host's today; negative when overdue. */
  days: number;
}

export interface FundingProblem {
  row: number;
  field: string;
  reason: string;
}

export interface FundingTracker {
  configured: true;
  exportedAt: string;
  today: string;
  readableByOthers: boolean;
  rows: FundingRow[];
  counts: { total: number; byType: Record<FundingType, number>; byStage: Array<{ stage: string | null; count: number }> };
  upcoming: FundingDue[];
  overdue: FundingDue[];
  problems: FundingProblem[];
  ignoredColumns: number;
}

export type FundingAnswer = { configured: false } | { configured: true; error: { code: string; message: string } } | FundingTracker;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The answer if it has the shape the page renders; otherwise null (the page then shows nothing as data). */
export function fundingAnswerOf(value: unknown): FundingAnswer | null {
  if (!isObject(value) || typeof value.configured !== "boolean") return null;
  if (!value.configured) return { configured: false };
  if (isObject(value.error)) {
    const { code, message } = value.error;
    return typeof code === "string" && typeof message === "string" ? { configured: true, error: { code, message } } : null;
  }
  const lists = [value.rows, value.upcoming, value.overdue, value.problems];
  if (!lists.every(Array.isArray) || !isObject(value.counts) || !isObject(value.counts.byType) || !Array.isArray(value.counts.byStage)) return null;
  return value as unknown as FundingTracker;
}

export async function readFundingTracker(): Promise<FundingAnswer> {
  const res = await fetch(`${apiBase()}/api/admin/funding`, { cache: "no-store" });
  if (!res.ok) throw new HttpFailure("The funding tracker could not be read", res.status);
  const answer = fundingAnswerOf(await res.json().catch(() => null));
  if (!answer) throw new Error("The funding tracker could not be read: the answer was not in the expected form.");
  return answer;
}
