/**
 * Holdout set for the L1 structure detectors (GAU-154): storms and quiet days the detectors were
 * never tuned on. Chosen and pre-registered on GAU-154 (2026-10-21) before any of it was fetched
 * or scored. Only the L1 series is used, so the full replay goldens don't cover these.
 *
 * Catalogue: Richardson & Cane, "Near-Earth ICMEs", https://izw1.caltech.edu/ACE/ASC/DATA/level3/icmetable2.htm
 * (revised 23 July 2026, read 21 October 2026). "Disturbance" is the sudden commencement at Earth,
 * typically the shock's arrival there; ICME times are "estimated to ~ the nearest hour".
 */
import type { ReplayEvent } from "./events.js";

export interface CatalogueIcme {
  /** Disturbance at Earth (UTC). */
  disturbance: string;
  /** A minute-precise sudden commencement with dV > 0: a shock is expected. */
  shock: boolean;
  icmeStart: string;
  icmeEnd: string;
  quality: string;
  dV: number;
  /** R&C magnetic-cloud flag: 2 cloud, 1 some signatures, 0 none. */
  mc: number;
}

export interface HoldoutEvent extends ReplayEvent {
  /** The event this window is about; null for a quiet day. */
  target: CatalogueIcme | null;
  /** Other catalogued ICMEs that overlap the window (with its lead-in), so matching them isn't a false alarm. */
  others: CatalogueIcme[];
}

const quiet = (id: string, day: string): HoldoutEvent => ({
  id,
  title: `${day}: no catalogued ICME (quiet-day false-alarm check)`,
  start: `${day}T00:00:00Z`,
  end: new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().replace(".000", ""),
  expect: "No ICME in the Richardson & Cane list; a shock here could still be real (e.g. a stream interface).",
  target: null,
  others: [],
});
/** Disturbance − 3 h to ICME start + 12 h. */
const storm = (id: string, title: string, target: CatalogueIcme, others: CatalogueIcme[] = []): HoldoutEvent => ({
  id,
  title,
  start: new Date(Date.parse(target.disturbance) - 3 * 3_600_000).toISOString().replace(".000", ""),
  end: new Date(Date.parse(target.icmeStart) + 12 * 3_600_000).toISOString().replace(".000", ""),
  expect: `R&C: disturbance ${target.disturbance}, ICME ${target.icmeStart} → ${target.icmeEnd}, Q${target.quality}, dV ${target.dV}, MC ${target.mc}.`,
  target,
  others,
});

export const HOLDOUT_EVENTS: HoldoutEvent[] = [
  storm("feb-2025", "2 Feb 2025 ICME without a shock", { disturbance: "2025-02-02T16:00:00Z", shock: false, icmeStart: "2025-02-02T16:00:00Z", icmeEnd: "2025-02-04T00:00:00Z", quality: "2", dV: 0, mc: 2 }),
  storm("apr-2025", "15 Apr 2025 shock and ICME", { disturbance: "2025-04-15T17:21:00Z", shock: true, icmeStart: "2025-04-15T23:00:00Z", icmeEnd: "2025-04-18T03:00:00Z", quality: "1", dV: 150, mc: 1 }),
  storm("jun1-2025", "1 Jun 2025 fast ICME", { disturbance: "2025-06-01T05:40:00Z", shock: true, icmeStart: "2025-06-01T08:00:00Z", icmeEnd: "2025-06-03T02:00:00Z", quality: "1", dV: 250, mc: 1 }),
  storm("jun4-2025", "4 Jun 2025 ICME", { disturbance: "2025-06-04T14:14:00Z", shock: true, icmeStart: "2025-06-04T16:00:00Z", icmeEnd: "2025-06-05T05:00:00Z", quality: "2", dV: 60, mc: 1 }),
  storm("jun11-2025", "11 Jun 2025 ICME, shock at the threshold", { disturbance: "2025-06-11T15:55:00Z", shock: true, icmeStart: "2025-06-11T21:00:00Z", icmeEnd: "2025-06-13T23:00:00Z", quality: "3", dV: 40, mc: 1 }),
  storm("sep-2025", "1 Sep 2025 magnetic cloud", { disturbance: "2025-09-01T20:58:00Z", shock: true, icmeStart: "2025-09-02T08:00:00Z", icmeEnd: "2025-09-04T01:00:00Z", quality: "1", dV: 240, mc: 2 }),
  storm("nov7-2025", "7 Nov 2025 ICME, not a cloud", { disturbance: "2025-11-07T05:16:00Z", shock: true, icmeStart: "2025-11-07T09:00:00Z", icmeEnd: "2025-11-08T09:00:00Z", quality: "3", dV: 100, mc: 0 }),
  storm(
    "nov12-2025",
    "12 Nov 2025 major storm",
    { disturbance: "2025-11-12T00:09:00Z", shock: true, icmeStart: "2025-11-12T03:00:00Z", icmeEnd: "2025-11-13T00:00:00Z", quality: "1", dV: 300, mc: 2 },
    // The previous ICME is still passing at the start of this window.
    [{ disturbance: "2025-11-10T13:00:00Z", shock: false, icmeStart: "2025-11-10T18:00:00Z", icmeEnd: "2025-11-12T00:00:00Z", quality: "3", dV: 30, mc: 1 }],
  ),
  storm("dec-2025", "10 Dec 2025 weak shock (dV 20, under the 40 km/s threshold)", { disturbance: "2025-12-10T16:46:00Z", shock: true, icmeStart: "2025-12-10T20:00:00Z", icmeEnd: "2025-12-12T00:00:00Z", quality: "1", dV: 20, mc: 2 }),
  quiet("mar10-2025", "2025-03-10"),
  quiet("mar20-2025", "2025-03-20"),
  quiet("aug10-2025", "2025-08-10"),
];

export const holdoutById = (id: string) => HOLDOUT_EVENTS.find((e) => e.id === id);
