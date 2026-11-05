import type { DetectionConfidence, L1Structures } from "./types/l1-structures";

/** One candidate as the operator console lists it. */
export interface StructureItem {
  /** When it starts (UTC, at L1). */
  at: string;
  title: string;
  detail: string;
  confidence: DetectionConfidence;
}

const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;

/** Every candidate, newest first. */
export function structureItems(s: L1Structures): StructureItem[] {
  const items: StructureItem[] = [
    ...s.shocks.map((x) => ({
      at: x.time,
      title: "Shock",
      detail: `ΔV ${Math.round(x.deltaSpeedKmS)} km/s, shock ${x.shockSpeedKmS} km/s; at Earth ≈ ${hhmm(x.earthArrival)}`,
      confidence: x.confidence,
    })),
    ...s.fieldOnlyDiscontinuities.map((x) => ({
      at: x.time,
      title: "Field jump (plasma not tracking)",
      detail: `|B| ×${x.fieldRatio}; the speed reading isn't following the field, so no shock speed or arrival`,
      confidence: x.confidence,
    })),
    ...s.icmeCandidates.map((x) => ({
      at: x.start,
      title: "ICME",
      detail: `${x.hours} h, ${x.signatures.join(" + ")}, Bt up to ${x.maxBtNt} nT, Bz down to ${x.minBzNt} nT`,
      confidence: x.confidence,
    })),
    ...s.sustainedSouthward.map((x) => ({
      at: x.start,
      title: "Sustained southward Bz",
      detail: `${x.hours} h, Ey up to ${x.maxEyMvM} mV/m, Bz down to ${x.minBzNt} nT: an intense storm is likely`,
      confidence: x.confidence,
    })),
    ...s.magnetopauseInsideGeo.map((x) => ({
      at: x.start,
      title: "Magnetopause inside GEO",
      detail: `${x.minutes} min, down to ${x.minStandoffRe} Re: geostationary satellites may be in the magnetosheath`,
      confidence: x.confidence,
    })),
    ...s.fastFlows.map((x) => ({
      at: x.start,
      title: x.kind === "high-speed stream" ? "High-speed stream" : "Post-shock fast flow (sheath)",
      detail: `${x.hours} h, up to ${x.maxSpeedKmS} km/s`,
      confidence: x.confidence,
    })),
  ];
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/** The pill's text, and whether a candidate worth a look is recent (not low confidence, last 6 h). */
export function structuresSummary(items: StructureItem[], nowMs: number): { label: string; attention: boolean } {
  if (items.length === 0) return { label: "L1: no candidates (24 h)", attention: false };
  const [newest] = items;
  const attention = items.some((x) => x.confidence !== "low" && nowMs - Date.parse(x.at) <= 6 * 3_600_000);
  const count = `${items.length} candidate${items.length === 1 ? "" : "s"}`;
  return { label: `L1: ${count} · ${newest.title.toLowerCase()} ${hhmm(newest.at)}`, attention };
}
