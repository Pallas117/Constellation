// Gauss plans: this one table drives the plans on /gauss/, the plan choice on the application form,
// what an approved account pays (Stripe) and what its workspace shows.
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
});

export const TIERS = Object.freeze([
  {
    id: "pilot",
    name: "Design-partner pilot",
    stage: "Start here",
    outcome: "One asset group, one historical replay, one live or near-live feed, one measurable acceptance outcome.",
    price: { min: 20_000, max: 40_000, unit: "per pilot" },
    billing: "payment", // one Stripe payment
    features: ["replay", "feed", "acceptance", "provenance", "correlation", "evidence"],
    entry: "Bounded and paid. Fixed price agreed from your scope before you pay.",
  },
  {
    id: "fleet_integration",
    name: "Fleet Integration",
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
export const quoteInRange = (t, pounds) => Number.isFinite(pounds) && pounds >= t.price.min && pounds <= t.price.max;

/** Where a pilot is up to; shown to the customer, set by an admin. */
export const PILOT_STEPS = Object.freeze(["Scoping", "Data-sharing agreement", "Data received", "Replay running", "Evidence report delivered"]);

/** Billing states. Stripe webhooks move paid plans between them; invoiced plans are set by an admin. */
export const BILLING = Object.freeze({
  due: "Payment due",
  processing: "Payment processing",
  paid: "Paid",
  active: "Active",
  past_due: "Payment failed",
  canceled: "Cancelled",
  invoiced: "Invoiced by milestone",
});
// A failed renewal keeps access while Stripe retries the payment; only cancellation locks the workspace.
export const unlocked = (status) => ["paid", "active", "past_due", "invoiced"].includes(status);
