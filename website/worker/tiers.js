// Gauss plans: this one table drives the plans on /gauss/, the plan choice on the application form,
// what an approved account pays (Stripe Checkout, or a Stripe invoice where allowed) and what its workspace shows.
//
// Packages and planning prices come from the sales plan, "Gauss Aurora sales feature list and
// onboarding flow" (Gauss Aurora repo, docs/SALES_FEATURE_LIST_AND_ONBOARDING.md, 21 Aug 2026).
// Each customer's actual price is a fixed quote inside the range, set when they are approved.
// Constellation is not here: it is free and by invitation.

export const SHOW_PRICES = true;
// US dollars (Josh, 3 Nov 2026: one currency everywhere). The ranges were the sales plan's pounds at $1.34 to the pound
// (ECB reference rate, 2 Nov 2026), rounded.
export const CURRENCY = "usd";

export const FEATURES = Object.freeze({
  replay: "Replay of your telemetry against the space environment it met (CCSDS, XTCE, Yamcs-shaped data)",
  feed: "One live or near-live feed",
  acceptance: "One measurable acceptance outcome, agreed before day one",
  provenance: "Provenance, freshness and uncertainty on every exported decision",
  correlation: "Radiation and space-weather context correlated with telemetry quality",
  states: "Explicit nominal, degraded, abstain, unknown and blocked states",
  evidence: "Operator-visible incident and acceptance reports",
  recurring: "Recurring mission-data quality checks across your fleet",
  exports: "Evidence exports for engineers and assurance reviewers",
  archive: "Your archive and mission dictionary, integrated",
  ground: "Yamcs and ground-segment integration, with acceptance work",
  adapter: "Target-processor and mission-specific validation",
  review: "An evidence report and a review session with your team",
});

export const TIERS = Object.freeze([
  {
    id: "pilot",
    name: "Design-partner pilot",
    short: "Pilot",
    stage: "Start here",
    outcome: "One asset group, one historical replay, one live or near-live feed, one measurable acceptance outcome.",
    price: { min: 25_000, max: 50_000, unit: "per pilot" },
    billing: "payment", // one Stripe payment
    features: ["replay", "feed", "acceptance", "provenance", "correlation", "review"],
    entry: "Bounded and paid: about 30 days, at a fixed price agreed from your scope before you pay.",
  },
  {
    id: "fleet_integration",
    name: "Fleet Integration",
    short: "Fleet Integration",
    stage: "Now",
    outcome: "Recurring mission-data quality, provenance, radiation correlation and evidence exports.",
    price: { min: 80_000, max: 160_000, unit: "a year" },
    billing: "subscription", // annual Stripe subscription
    features: ["recurring", "provenance", "correlation", "states", "exports", "evidence"],
    entry: "Usually follows a pilot. Billed yearly.",
  },
  {
    id: "mission_integration",
    name: "Mission integration",
    short: "Mission integration",
    stage: "Project",
    outcome: "Your archive, mission dictionary, Yamcs and ground integration, and acceptance work.",
    price: { min: 150_000, max: 400_000, unit: "one-off" },
    billing: "invoice", // invoiced by milestone
    features: ["archive", "ground", "acceptance", "evidence"],
    entry: "Scoped with your team and invoiced by milestone.",
  },
  {
    id: "flight_candidate_adapter",
    name: "Flight Candidate Adapter",
    short: "Flight adapter",
    stage: "Gated",
    outcome: "Target-processor and mission-specific validation, after hardware and operator gates.",
    price: { min: 1_000_000, max: 3_300_000, unit: "one-off" },
    billing: "invoice",
    features: ["adapter", "evidence"],
    entry: "Only with a named mission, target processor, mission dictionary, hardware evidence and operator authority.",
  },
]);

export const tierById = (id) => TIERS.find((t) => t.id === id) ?? null;

/** $25k, $160k, $3.3m */
export const usdShort = (dollars) => (dollars >= 1_000_000 ? `$${+(dollars / 1_000_000).toFixed(2)}m` : `$${Math.round(dollars / 1000)}k`);
/** $28,000 from cents */
export const usd = (cents) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 ? 2 : 0 })}`;
export const priceLabel = (t) => (SHOW_PRICES ? `${usdShort(t.price.min)}–${usdShort(t.price.max)} ${t.price.unit}` : "Priced per scope");
/** Short form for tight spaces (the plan picker on a phone): "Pilot · $25k–$50k". */
export const optionLabel = (t) => `${t.short} · ${usdShort(t.price.min)}–${usdShort(t.price.max)}${t.billing === "subscription" ? " a year" : ""}`;
export const quoteInRange = (t, dollars) => Number.isFinite(dollars) && dollars >= t.price.min && dollars <= t.price.max;

/** Where a pilot is up to; shown to the customer, set by an admin. */
export const PILOT_STEPS = Object.freeze(["Scoping", "Data-sharing agreement", "Data received", "Replay running", "Evidence report delivered"]);

/** Billing states. Stripe webhooks move paid plans between them; milestone-billed plans are set by an admin. */
export const BILLING = Object.freeze({
  due: "Payment due",
  processing: "Payment processing",
  paid: "Paid",
  active: "Active",
  past_due: "Payment failed",
  canceled: "Cancelled",
  invoice_open: "Invoice sent",
  overdue: "Invoice overdue",
  invoiced: "Invoiced by milestone",
});
// A failed renewal keeps access while Stripe retries the payment, and an invoice keeps it open until its
// due date; cancellation or an overdue invoice locks the workspace.
export const unlocked = (status) => ["paid", "active", "past_due", "invoice_open", "invoiced"].includes(status);

// Gauss Argo: the device agent (tools/argo). Included for operators and staff, never sold on its own and never priced
// on the public site (Josh, 2026-10-21; the sales plan rules out a low-price SaaS on the site).
export const ARGO = Object.freeze({ id: "argo", name: "Gauss Argo" });

// Gauss for Education (prototype; Josh, 2026-10-20). Students: free for a year at a time, with a university email.
// Staff and research groups: monthly by card at EDU_STAFF_PRICE (US cents, wrangler.jsonc vars); empty means the price is
// TBC and there is no checkout. Departments: a yearly licence, quoted by an admin and paid by invoice in dollars.
// It is an academic licence, never a trial of the Gauss packages (sales plan).
export const EDU = Object.freeze({ id: "edu", name: "Gauss for Education", currency: "usd", interval: "month" });
export const eduMode = (env) => (["off", "open"].includes(env?.EDU_SALES) ? env.EDU_SALES : "off");
export const eduStaffPrice = (env) => {
  const n = Number(env?.EDU_STAFF_PRICE ?? "");
  return Number.isInteger(n) && n > 0 ? n : null;
};
export const eduStaffLabel = (env) => {
  const n = eduStaffPrice(env);
  return n ? `$${(n / 100).toFixed(n % 100 ? 2 : 0)} a month` : "Price TBC";
};
/** Addresses that can start straight away: ox.ac.uk, mit.edu, um.edu.my, unsw.edu.au and the like. Anyone else asks for a review.
 *  Only .edu, .edu.xx and .ac.xx count: a bare .ac (Ascension Island) is open to anyone, so it doesn't. */
export const isAcademicEmail = (email) => /@([a-z0-9-]+\.)+(edu|(?:ac|edu)\.[a-z]{2})$/i.test(String(email ?? ""));
export const eduEligible = (account, email) => isAcademicEmail(email) || !!account?.edu?.approvedAt;

/** An operator: an account with a Gauss plan whose billing is unlocked (paid, active, retrying, invoice open, or milestone-billed). */
export const isOperator = (account, now = Date.now()) => !!tierById(account?.tier) && unlocked(billingStatus(account, now));

/** Days a customer has to pay an invoice they asked for. */
export const INVOICE_DAYS = 30;

/** The account's billing status now: an unpaid invoice past its due date is overdue, and a year paid by invoice runs out. */
export function billingStatus(account, now = Date.now()) {
  const b = account?.billing ?? {};
  const status = b.status ?? (tierById(account?.tier)?.billing === "invoice" ? "invoiced" : "due");
  if (status === "invoice_open" && b.dueAt && Date.parse(b.dueAt) < now) return "overdue";
  if (status === "paid" && b.paidUntil && Date.parse(b.paidUntil) < now) return "due";
  return status;
}
