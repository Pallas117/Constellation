import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { structureItems, structuresSummary } from "./l1-structures-summary.ts";
import type { L1Structures } from "./types/l1-structures.ts";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const empty: L1Structures = {
  shocks: [],
  fieldOnlyDiscontinuities: [],
  sustainedSouthward: [],
  magnetopauseInsideGeo: [],
  icmeCandidates: [],
  fastFlows: [],
  coverage: { speed: 1, density: 1, bt: 1, bz: 1, temperature: 1 },
  notes: [],
};

describe("L1 structures summary", () => {
  it("operator console: L1 candidates are listed newest first with their confidence; recent non-low ones need attention (GAU-154)", () => {
    const items = structureItems({
      ...empty,
      shocks: [{ kind: "fast-forward shock candidate", time: "2026-10-21T09:40:00Z", earthArrival: "2026-10-21T10:15:00Z", shockSpeedKmS: 720, deltaSpeedKmS: 180.4, densityRatio: 2, fieldRatio: 2.2, confidence: "medium" }],
      icmeCandidates: [{ kind: "ICME candidate", start: "2026-10-21T11:00:00Z", end: "2026-10-21T16:00:00Z", hours: 5, signatures: ["low proton beta"], medianTemperatureRatio: 0.9, medianProtonBeta: 0.04, minBzNt: -12, maxBtNt: 24, confidence: "low" }],
    });
    assert.deepEqual(items.map((i) => [i.title, i.confidence]), [["ICME", "low"], ["Shock", "medium"]]);
    assert.match(items[1].detail, /ΔV 180 km\/s, shock 720 km\/s; at Earth ≈ 10:15 UTC/);
    assert.deepEqual(structuresSummary(items, NOW), { label: "L1: 2 candidates · icme 11:00 UTC", attention: true });
    // Only low-confidence or old candidates: listed, but no attention.
    assert.equal(structuresSummary(items, NOW + 6 * 3_600_000).attention, false);
    assert.equal(structuresSummary([items[0]], NOW).attention, false);
  });

  it("no candidates reads as none for the window, not as quiet conditions", () => {
    assert.deepEqual(structuresSummary(structureItems(empty), NOW), { label: "L1: no candidates (24 h)", attention: false });
  });
});
