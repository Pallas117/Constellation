/**
 * Upset-risk band for a trust record (PR-02, GAU-58): was a profiled processor's single-event
 * rate likely at, above or well above the same orbit's quiet-time average when the inference ran?
 *
 * It is a band, not a rate. The rate is R = ∫ σ(E) · dΦ/dE dE over the proton spectrum
 * (ECSS-E-ST-10-12C §9.5.3). If σ is flat above its threshold energy, R / R_quiet is just
 * Φ(>E_th) / Φ_quiet(>E_th), so the cross-section's size drops out and the band follows the
 * environment. Gauss runs no orbit flux model (AP9, CREME96), so it ranks drivers instead of
 * computing that ratio:
 *  - Trapped protons: the record's SAA tier (core → high, extended → elevated). The tier exists
 *    only at 300–450 km; elsewhere the band is unknown.
 *  - Solar protons: the NOAA S-level at geostationary orbit, counted only where they can reach the
 *    spacecraft. Centred-dipole L ≥ SEP_OPEN_L is open (S1–S2 → elevated, S3+ → high); L below
 *    SEP_SHIELDED_L is shielded; in between, a geomagnetic storm (G1+) lowers the cutoff enough to
 *    count as open, otherwise only S3+ counts (→ elevated).
 *  - Galactic cosmic rays set the quiet floor. Their change with the solar cycle and storms is
 *    not modelled.
 * The band is the highest of the drivers. Any input it needs that is unknown makes it unknown.
 *
 * The profile decides whether a band may be given at all (`profileProblem`) and adds what its own
 * data can't say. It describes the environment's effect on the rate, never the hardware's
 * condition or the chance that an output was wrong.
 */
import type { Field } from "./record.js";
import type { SaaTier } from "./saa.js";
import { citedProtonCampaigns, findProfile, PROFILE_LIBRARY_VERSION, PROFILES, profileProblem, type EffectClass, type ProcessorProfile } from "./profiles.js";

/** At or above this centred-dipole L (invariant latitude 60°) solar protons reach the orbit. */
export const SEP_OPEN_L = 4;
/** Below this L (invariant latitude 45°) the field shields the orbit from solar protons. */
export const SEP_SHIELDED_L = 2;

export type UpsetBand = "baseline" | "elevated" | "high";

export interface UpsetRiskValue {
  band: UpsetBand;
  uncertainty: string;
  profileId: string;
  profileVersion: number;
  profileLibrary: string;
  /** Effect classes the profile has cited proton data for; the band applies to each. */
  effects: EffectClass[];
  /** What set the band; empty when nothing raised it above baseline. */
  drivers: string[];
}

export interface UpsetContext {
  saaTier: SaaTier | null;
  /** Why the SAA tier is unknown, when it is. */
  saaWhy: string;
  sLevel: number | null;
  sWhy: string;
  gLevel: number | null;
  gWhy: string;
  lShell: number | null;
}

const RANK: Record<UpsetBand, number> = { baseline: 0, elevated: 1, high: 2 };

/** The band and what set it, or why it can't be given. */
export function upsetBand(c: UpsetContext): { band: UpsetBand; drivers: string[]; notes: string[] } | { unknown: string } {
  if (c.saaTier === null) return { unknown: `Trapped-proton context unknown: ${c.saaWhy}` };
  if (c.sLevel === null) return { unknown: `Solar-proton level unknown: ${c.sWhy}` };
  if (c.lShell === null) return { unknown: "Solar-proton access unknown: no L-shell" };

  const drivers: string[] = [];
  const notes: string[] = [];
  let band: UpsetBand = "baseline";
  const raise = (to: UpsetBand, why: string) => {
    drivers.push(why);
    if (RANK[to] > RANK[band]) band = to;
  };

  if (c.saaTier === "core") raise("high", "inside the South Atlantic Anomaly core (trapped protons)");
  else if (c.saaTier === "extended") raise("elevated", "in the South Atlantic Anomaly's extended region (trapped protons)");

  if (c.sLevel >= 1) {
    const s = `S${c.sLevel}`;
    const l = c.lShell.toFixed(2);
    if (c.lShell < SEP_SHIELDED_L) {
      notes.push(`${s} solar protons at geostationary orbit, but at L ${l} (below ${SEP_SHIELDED_L}) the field shields this position from all but the rare GeV events.`);
    } else if (c.lShell >= SEP_OPEN_L) {
      raise(c.sLevel >= 3 ? "high" : "elevated", `${s} solar protons, reaching L ${l} (at or above ${SEP_OPEN_L})`);
    } else if (c.gLevel === null) {
      return { unknown: `Geomagnetic level unknown, needed to judge solar-proton access at L ${l}: ${c.gWhy}` };
    } else if (c.gLevel >= 1) {
      raise(c.sLevel >= 3 ? "high" : "elevated", `${s} solar protons at L ${l}, with the cutoff lowered by a G${c.gLevel} storm`);
    } else if (c.sLevel >= 3) {
      raise("elevated", `${s} solar protons, partly reaching L ${l} (between ${SEP_SHIELDED_L} and ${SEP_OPEN_L}, no geomagnetic storm)`);
    } else {
      notes.push(`${s} solar protons at geostationary orbit; at L ${l} without a geomagnetic storm few reach this position.`);
    }
  }
  return { band, drivers, notes };
}

const BAND_ONLY =
  "Ordinal band, not a computed rate: no orbit flux model (AP9, CREME96) is run, so how far the rate sat from the quiet orbit average is not quantified.";

const MODEL_LIMITATIONS = [
  "Relative to the same orbit's average under quiet space weather; it says nothing about the hardware or whether the output was right.",
  "Galactic cosmic rays set the quiet floor; their change with the solar cycle and during storms is not modelled.",
  "Solar-proton access uses centred-dipole L thresholds, a coarse stand-in for the real, storm-dependent cutoff.",
];

export type UpsetField = Field<UpsetRiskValue>;

function unknown(source: string, why: string, extra: Partial<UpsetField> = {}): UpsetField {
  return { value: null, source, sourceUrl: null, observedAt: null, fetchedAt: null, ageSeconds: null, confidence: "none", method: "unknown", ...extra, limitations: [why, ...(extra.limitations ?? [])] };
}

/** The record's upsetRisk field for the given profile id and context (never throws on a bad id). */
export function upsetRiskField(
  profileId: string | null | undefined,
  context: UpsetContext,
  at: { time: string; fetchedAt: string | null },
  library: readonly ProcessorProfile[] = PROFILES,
): UpsetField {
  const generic = "Processor radiation profile";
  if (!profileId) return unknown(generic, "No processor profile given; an upset-risk band needs a cited profile (PR-02, GAU-58).");
  const profile = findProfile(profileId, library);
  if (!profile) {
    return unknown(generic, `No cited radiation profile for processor "${profileId}" in ${PROFILE_LIBRARY_VERSION}; known profiles: ${library.map((p) => p.id).join(", ")}.`);
  }
  const source = `Processor profile ${profile.id} v${profile.version} (${PROFILE_LIBRARY_VERSION})`;
  const problem = profileProblem(profile);
  if (problem) return unknown(source, problem);

  const proton = citedProtonCampaigns(profile);
  const result = upsetBand(context);
  if ("unknown" in result) return unknown(source, result.unknown, { sourceUrl: proton[0].url });

  const effects = [...new Set(proton.flatMap((c) => c.results.map((r) => r.effect)))];
  return {
    value: {
      band: result.band,
      uncertainty: [BAND_ONLY, ...profile.limitations].join(" "),
      profileId: profile.id,
      profileVersion: profile.version,
      profileLibrary: PROFILE_LIBRARY_VERSION,
      effects,
      drivers: result.drivers,
    },
    source: `${source}: ${proton.map((c) => `${c.citation}; ${c.facility}, ${c.energyMeV} MeV protons`).join(" | ")}`,
    sourceUrl: proton[0].url,
    observedAt: at.time,
    fetchedAt: at.fetchedAt,
    ageSeconds: 0,
    confidence: "low",
    method:
      "modelled: highest of the trapped-proton driver (SAA tier) and the solar-proton driver (NOAA S-level where the L-shell lets protons in), relative to the quiet orbit average; the cross-section's size cancels in that ratio",
    limitations: [...result.notes, ...MODEL_LIMITATIONS],
  };
}
