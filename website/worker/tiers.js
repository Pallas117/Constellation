// Gauss plans: this one table drives the plans on /gauss/, the plan choice on the application form,
// what an approved account pays (Stripe Checkout, or a Stripe invoice where allowed) and what its workspace shows.
//
// Packages and planning prices come from the sales plan, "Gauss Aurora sales feature list and
// onboarding flow" (Gauss Aurora repo, docs/SALES_FEATURE_LIST_AND_ONBOARDING.md, 21 Aug 2026).
// Each customer's actual price is a fixed quote inside the range, set when they are approved.
// Constellation is not here: it is free and by invitation.

export const SHOW_PRICES = true;
export const CURRENCY = "gbp";

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
    price: { min: 20_000, max: 40_000, unit: "per pilot" },
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
    price: { min: 60_000, max: 125_000, unit: "a year" },
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
    price: { min: 120_000, max: 300_000, unit: "one-off" },
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
    price: { min: 750_000, max: 2_500_000, unit: "one-off" },
    billing: "invoice",
    features: ["adapter", "evidence"],
    entry: "Only with a named mission, target processor, mission dictionary, hardware evidence and operator authority.",
  },
]);

export const tierById = (id) => TIERS.find((t) => t.id === id) ?? null;

/** £20k, £125k, £2.5m */
export const gbpShort = (pounds) => (pounds >= 1_000_000 ? `£${+(pounds / 1_000_000).toFixed(2)}m` : `£${Math.round(pounds / 1000)}k`);
/** £28,000 from pence */
export const gbp = (pence) => `£${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: pence % 100 ? 2 : 0 })}`;
export const priceLabel = (t) => (SHOW_PRICES ? `${gbpShort(t.price.min)}–${gbpShort(t.price.max)} ${t.price.unit}` : "Priced per scope");
/** Short form for tight spaces (the plan picker on a phone): "Pilot · £20k–£40k". */
export const optionLabel = (t) => `${t.short} · ${gbpShort(t.price.min)}–${gbpShort(t.price.max)}${t.billing === "subscription" ? " a year" : ""}`;
export const quoteInRange = (t, pounds) => Number.isFinite(pounds) && pounds >= t.price.min && pounds <= t.price.max;

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

// Gauss Argo: the self-serve device agent (tools/argo), at one fixed monthly price. It is sold on its own and never
// shown with the Gauss packages above: the sales plan says the public site must not present Gauss as a low-price SaaS trial.
export const ARGO = Object.freeze({ id: "argo", name: "Gauss Argo", amount: 1000, currency: "usd", interval: "month" });
export const argoPrice = `$${ARGO.amount / 100} a month`;
/** ARGO_SALES (wrangler.jsonc vars): "off" = the list only (default); "invite" = invited accounts can start; "open" = anyone signed in. */
export const argoMode = (env) => (["off", "invite", "open"].includes(env?.ARGO_SALES) ? env.ARGO_SALES : "off");
export const argoCanStart = (env, account) => argoMode(env) === "open" || (argoMode(env) === "invite" && !!account?.argo?.invitedAt);

// Gauss for Education (prototype; Josh, 2026-10-20). Students: free for a year at a time, with a university email.
// Staff and research groups: monthly by card at EDU_STAFF_PRICE (US cents, wrangler.jsonc vars); empty means the price is
// TBC and there is no checkout. Departments: a yearly licence, quoted by an admin and paid by invoice in pounds.
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
/** Addresses that can start straight away: ox.ac.uk, mit.edu, um.edu.my, unsw.edu.au and the like. Anyone else asks for a review. */
export const isAcademicEmail = (email) => /@([a-z0-9-]+\.)+(edu|ac)(\.[a-z]{2})?$/i.test(String(email ?? ""));
export const eduEligible = (account, email) => isAcademicEmail(email) || !!account?.edu?.approvedAt;

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
