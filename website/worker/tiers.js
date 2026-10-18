// Gauss plans: this one table drives the plans on /gauss/, the plan choice on the application form,
// and what a signed-in account sees in its workspace.
//
// Names and list prices come from the three tiers in the Lovable build (src/lib/entitlements.ts).
// What each plan includes follows the gated roadmap on /gauss/, NOT the Lovable feature list: that
// list claimed automated mitigation dispatch, a quantum surrogate and fixed warning times, which
// Gauss cannot support (it is advisory and ground-first). website/test checks these stay out.

/** Pallas: set to true only once the list prices are approved for publication (GAU-65). */
export const SHOW_PRICES = false;

export const FEATURES = Object.freeze({
  replay: "Replay of your telemetry and onboard-AI logs (CCSDS/XTCE packets, Yamcs exports)",
  provenance: "Quality and provenance on every value; missing or stale inputs stay unknown",
  correlation: "Correlation with radiation and geomagnetic conditions (NOAA, NASA HAPI)",
  evidence: "Evidence reports your engineers and assurance reviewers can check",
  weather: "Live space-weather context in your workspace",
  adapter: "Flight candidate adapter for a named mission and target processor (ONNX)",
  byok: "Bring your own model keys",
  api: "API access to your evidence",
  bridge: "Federated bridge node: a hosted-payload or in-orbit demonstration option",
});

const FLEET = ["replay", "provenance", "correlation", "evidence", "weather"];

export const TIERS = Object.freeze([
  {
    id: "tactical_fleet",
    name: "Tactical Fleet",
    stage: "Now",
    stageName: "Fleet Integration",
    audience: "Commercial LEO and MEO operators, one fleet",
    summary: "Ground-side replay of your telemetry and onboard-AI logs against the space weather they met.",
    entry: "Starts with a 30-day replay pilot.",
    listPrice: "$15,000 a month",
    features: FLEET,
  },
  {
    id: "active_mission_defense",
    name: "Active Mission Defense",
    stage: "Gated",
    stageName: "Flight Candidate Adapter",
    audience: "Mission-assurance programmes with a named mission",
    summary: "Takes the evidence towards your mission's own flight processor.",
    entry: "Only with a named mission, target processor, mission dictionary, hardware evidence and operator authority.",
    listPrice: "$85,000 a month",
    features: [...FLEET, "adapter", "byok", "api"],
  },
  {
    id: "sovereign_shield",
    name: "Sovereign Shield",
    stage: "Gated",
    stageName: "Federated Bridge Node",
    audience: "National and critical-infrastructure operators",
    summary: "Takes it to a federated bridge node, in orbit or as a hosted payload.",
    entry: "Considered only after the stages before it.",
    listPrice: "Custom",
    features: [...FLEET, "adapter", "byok", "api", "bridge"],
  },
]);

export const tierById = (id) => TIERS.find((t) => t.id === id) ?? null;
export const priceLabel = (t) => (SHOW_PRICES ? t.listPrice : "Priced per scope");

/** Where a replay pilot is up to; shown to the customer, set by an admin. */
export const PILOT_STEPS = Object.freeze(["Scoping", "Data-sharing agreement", "Data received", "Replay running", "Evidence report delivered"]);
