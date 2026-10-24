/**
 * Relative upset-rate band for a trust record (PR-02, GAU-58): did any modelled driver raise a
 * profiled processor's single-event rate above the same orbit's quiet-time average when the
 * inference ran, and by roughly how much (elevated or high)?
 *
 * It is a band, not a rate. The rate is R = ∫ σ(E) · dΦ/dE dE over the proton spectrum at the
 * device (ECSS-E-ST-10-12C §9.5.3). If σ were a step, flat above a threshold energy E_th,
 * R / R_quiet would be Φ(>E_th) / Φ_quiet(>E_th) and the cross-section's size would cancel. E_th
 * itself does not cancel, and none of the profiles measured it (one energy each; §9.5.3a asks for
 * the saturation value plus two points between 10 and 200 MeV). So the band follows the integral
 * proton flux above an unknown threshold, which Gauss ranks rather than computes, because it runs
 * no orbit flux model (AP9, CREME96).
 *
 * The drivers and their mappings are Gauss heuristics (only the S-level boundaries are NOAA's):
 *  - Trapped protons: the record's SAA tier (core → high, extended → elevated). At 300–450 km
 *    almost all trapped-proton flux is inside the SAA. The tier exists only there; elsewhere the
 *    band is unknown.
 *  - Solar protons: the NOAA S-level (GOES ≥10 MeV at geostationary orbit), counted only where they
 *    are likely to reach the spacecraft. L at or above SEP_OPEN_L is open (S1–S2 → elevated,
 *    S3+ → high); below SEP_SHIELDED_L is shielded; in between, a G1+ storm is taken to lower the
 *    cutoff enough to open it, otherwise only S3+ counts (→ elevated). See the thresholds below.
 *  - Galactic cosmic rays are not modelled. Outside the SAA at low L the rate sits below the orbit
 *    average; at high L cosmic rays alone can put it above.
 * The band is the highest driver: "baseline" means no modelled driver raised it, not that the rate
 * equalled the average. Any input the band needs that is unknown makes it unknown.
 *
 * The profile decides whether a band may be given at all (`profileProblem`) and adds what its own
 * data can't say. The band describes the environment's effect on the rate, never the hardware's
 * condition or the chance that an output was wrong.
 */
import type { Field } from "./record.js";
import type { SaaTier } from "./saa.js";
import { citedProtonCampaigns, findProfile, PROFILE_LIBRARY_VERSION, PROFILES, profileProblem, type EffectClass, type ProcessorProfile } from "./profiles.js";

/*
 * Solar-proton access thresholds, on the record's centred-dipole L. Observed cutoffs for ~16 MeV
 * protons sit at about 63–66.5° corrected geomagnetic latitude in quiet times, with storm floors
 * of 56–58° (Nesse Tyssøy & Stadsnes, JGR 120, 553 (2015), doi:10.1002/2014JA020508). So on a
 * true L, 4 (60°) as "open" and 2 (45°) as "shielded" are conservative. The centred-dipole L
 * reads up to 0.96 low near L 4 and up to 0.41 low near L 2 against an IGRF-14 field-line apex L
 * at 300–450 km (Gauss grid check, 2.5° × 10°, |lat| 30–62.5°, 2026-10-25: centred 3.04 vs
 * IGRF 4.01; centred 1.59 vs IGRF 2.01), so the thresholds applied to it are lowered by that
 * margin. Replace with an IGRF-traced L when the record has one.
 */
/** At or above this centred-dipole L, solar protons are taken to reach the orbit. */
export const SEP_OPEN_L = 3.0;
/** Below this centred-dipole L, the field is taken to shield the orbit from solar protons. */
export const SEP_SHIELDED_L = 1.55;

export type UpsetBand = "baseline" | "elevated" | "high";

export interface UpsetRiskValue {
  band: UpsetBand;
  uncertainty: string;
  profileId: string;
  profileVersion: number;
  profileLibrary: string;
  /** Effect classes the profile has cited proton data for; the band applies to each. */
  effects: EffectClass[];
  /** What raised the band; empty at baseline. */
  drivers: string[];
}

/** A NOAA scale reading the band reads, with its provenance. */
export interface UpsetInput {
  level: number | null;
  /** Why the level is unknown, when it is. */
  why: string;
  observedAt: string | null;
  ageSeconds: number | null;
}

export interface UpsetContext {
  saaTier: SaaTier | null;
  /** Why the SAA tier is unknown, when it is. */
  saaWhy: string;
  s: UpsetInput;
  g: UpsetInput;
  lShell: number | null;
}

const RANK: Record<UpsetBand, number> = { baseline: 0, elevated: 1, high: 2 };

/** The band, what raised it and whether it needed the G-level, or why it can't be given. */
export function upsetBand(c: UpsetContext): { band: UpsetBand; drivers: string[]; notes: string[]; usedG: boolean } | { unknown: string } {
  if (c.saaTier === null) return { unknown: `Trapped-proton context unknown: ${c.saaWhy}` };
  if (c.s.level === null) return { unknown: `Solar-proton level unknown: ${c.s.why}` };
  if (c.lShell === null) return { unknown: "Solar-proton access unknown: no L-shell" };

  const drivers: string[] = [];
  const notes: string[] = [];
  let band: UpsetBand = "baseline";
  let usedG = false;
  const raise = (to: UpsetBand, why: string) => {
    drivers.push(why);
    if (RANK[to] > RANK[band]) band = to;
  };

  if (c.saaTier === "core") raise("high", "inside the South Atlantic Anomaly core (trapped protons)");
  else if (c.saaTier === "extended") raise("elevated", "in the South Atlantic Anomaly's extended region (trapped protons)");

  const sLevel = c.s.level;
  if (sLevel >= 1) {
    const s = `S${sLevel}`;
    const l = c.lShell.toFixed(2);
    if (c.lShell < SEP_SHIELDED_L) {
      notes.push(`${s} solar protons at geostationary orbit; at centred-dipole L ${l} (below ${SEP_SHIELDED_L}) the field is taken to shield this position from all but the rare GeV events.`);
    } else if (c.lShell >= SEP_OPEN_L) {
      raise(sLevel >= 3 ? "high" : "elevated", `${s} solar protons, likely reaching centred-dipole L ${l} (at or above ${SEP_OPEN_L})`);
    } else if (c.g.level === null) {
      return { unknown: `Geomagnetic level unknown, needed to judge solar-proton access at centred-dipole L ${l}: ${c.g.why}` };
    } else {
      usedG = true;
      if (c.g.level >= 1) {
        raise(sLevel >= 3 ? "high" : "elevated", `${s} solar protons at centred-dipole L ${l}; a G${c.g.level} storm is taken to lower the cutoff enough to let them in`);
      } else if (sLevel >= 3) {
        raise("elevated", `${s} solar protons, likely partly reaching centred-dipole L ${l} (between ${SEP_SHIELDED_L} and ${SEP_OPEN_L}, no geomagnetic storm)`);
      } else {
        notes.push(`${s} solar protons at geostationary orbit; at centred-dipole L ${l} without a geomagnetic storm few are taken to reach this position.`);
      }
    }
  }
  return { band, drivers, notes, usedG };
}

const BAND_ONLY =
  "Ordinal band, not a computed rate: no orbit flux model (AP9, CREME96) is run, so how far the rate sat from the quiet orbit average is not quantified.";

const MODEL_LIMITATIONS = [
  "Relative to the same orbit's average under quiet space weather. Baseline means no modelled driver raised the rate, not that it equalled that average. It says nothing about the hardware or whether the output was right.",
  "The SAA and S-level mappings and the solar-proton access thresholds are Gauss heuristics, applied to a centred-dipole L with a margin for its error.",
  "Galactic cosmic rays are not modelled: at low L outside the SAA the rate sits below the orbit average, and at high L they alone can put it above.",
  "The S-level counts protons at or above 10 MeV; a hard-spectrum event can carry significant flux at or above 100 MeV at S1–S2, and that channel is not read here.",
  "Low-energy protons can raise SEU rates in modern circuits by direct ionisation (up to 4.3 times in 20–90 nm parts; Dodds et al., IEEE TNS 62, 2440 (2015), doi:10.1109/TNS.2015.2486763), which a single high-energy test cannot show; a soft solar-proton spectrum may then be understated.",
];

export type UpsetField = Field<UpsetRiskValue>;

function unknown(source: string, why: string, extra: Partial<UpsetField> = {}): UpsetField {
  return { value: null, source, sourceUrl: null, observedAt: null, fetchedAt: null, ageSeconds: null, confidence: "none", method: "unknown", ...extra, limitations: [why, ...(extra.limitations ?? [])] };
}

/** The record's upsetRisk field for the given profile id and context (never throws on a bad id). */
export function upsetRiskField(
  profileId: string | null | undefined,
  context: UpsetContext,
  fetchedAt: string | null,
  library: readonly ProcessorProfile[] = PROFILES,
): UpsetField {
  const generic = "Processor radiation profile";
  if (!profileId) return unknown(generic, "No processor profile given; an upset-rate band needs a cited profile (PR-02, GAU-58).");
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

  // The band is as old as the oldest reading it used.
  const used = result.usedG ? [context.s, context.g] : [context.s];
  const oldest = used.reduce((a, b) => ((b.ageSeconds ?? 0) > (a.ageSeconds ?? 0) ? b : a));
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
    observedAt: oldest.observedAt,
    fetchedAt,
    ageSeconds: oldest.ageSeconds,
    confidence: "low",
    method:
      "modelled: highest of the trapped-proton driver (SAA tier) and the solar-proton driver (NOAA S-level where the L-shell is taken to let protons in), relative to the quiet orbit average; a cross-section flat above its threshold would cancel in that ratio",
    limitations: [...result.notes, ...MODEL_LIMITATIONS],
  };
}
