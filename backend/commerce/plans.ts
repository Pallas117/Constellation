/**
 * What an organisation has bought. Plans are separate from roles: a role says
 * what a person may do in Gauss (backend/rbac.ts); a plan says what their
 * organisation's API keys may do.
 *
 * Commercial context (Linear P-GAU-7 / P-GAU-12): the data API is sold
 * sales-led as part of the Fleet Integration pilot, not self-serve. These
 * limits exist for pilot evidence, fair use and invoicing, not price tiers.
 */
export type Plan = "free" | "pilot" | "enterprise";

export interface PlanLimits {
  /** Whether the organisation's keys may call /api/v1/data at all. */
  api: boolean;
  requestsPerMinute: number;
  requestsPerDay: number;
  /** Longest history window a single request may ask for. */
  maxLookbackMs: number;
}

const HOUR = 60 * 60 * 1000;

export const PLANS: Readonly<Record<Plan, PlanLimits>> = {
  free: { api: false, requestsPerMinute: 0, requestsPerDay: 0, maxLookbackMs: 0 },
  pilot: { api: true, requestsPerMinute: 60, requestsPerDay: 50_000, maxLookbackMs: 24 * HOUR },
  enterprise: { api: true, requestsPerMinute: 600, requestsPerDay: 500_000, maxLookbackMs: 24 * HOUR },
};

export function isPlan(value: unknown): value is Plan {
  return value === "free" || value === "pilot" || value === "enterprise";
}
