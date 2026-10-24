/**
 * Processor radiation profiles (PR-02, GAU-58): published single-event-effect (SEE) test results
 * for onboard processors, so a trust record can say on what data its upset-risk band rests.
 *
 * Every profile cites the test it came from (DOI or test report), the facility, the particle and
 * its energy, and states its units (cm² per device or per bit). Effect classes stay separate:
 * SEU (a bit flipped, here corrected by ECC), SEFI (the device stopped working until a reset or
 * power cycle) and SDC (a wrong output with no error raised) are never added together. Values are
 * as printed in the source, including its spread (95% bounds, or the range across runs or
 * configurations), and were read twice against the source before being added.
 *
 * Bump a profile's `version` whenever any of its values change, and PROFILE_LIBRARY_VERSION
 * whenever a profile is added, removed or changed: a trust record names both, so an old record
 * still says which data it used.
 *
 * A profile is used only when it has a cited proton campaign (`profileProblem`). The record's
 * band relies on trapped and solar protons, so heavy-ion or neutron data alone are not enough.
 * Nothing here is a statement about whether a device suits a mission.
 */

export const PROFILE_LIBRARY_VERSION = "gauss.processor-profiles/0.1";

export type EffectClass = "SEU" | "SEFI" | "SDC";

export interface CrossSection {
  effect: EffectClass;
  /** What was counted, in the source's terms. */
  observed: string;
  value: number;
  unit: "cm²/device" | "cm²/bit";
  /** The spread the source prints with the value, or null when it prints none. */
  range: { low: number; high: number; basis: string } | null;
  /** How many events the value rests on, as printed. */
  events: string | null;
}

export interface TestCampaign {
  citation: string;
  /** DOI link or report URL. A campaign without one is not used. */
  url: string;
  kind: "peer-reviewed" | "test report";
  facility: string;
  particle: "proton" | "heavy-ion" | "neutron";
  energyMeV: number;
  /** The part and set-up tested. */
  dut: string;
  results: CrossSection[];
  notes: string[];
}

export interface ProcessorProfile {
  id: string;
  version: number;
  name: string;
  campaigns: TestCampaign[];
  /** What the profile's data cannot tell the band, said in the record. */
  limitations: string[];
}

const XAVIER_2022 = {
  citation:
    "Rodriguez-Ferrandez, Tali, Kosmidis, Rovituso & Steenari, \"Sources of Single Event Effects in the NVIDIA Xavier SoC Family under Proton Irradiation\", IEEE IOLTS 2022",
  url: "https://doi.org/10.1109/IOLTS56730.2022.9897236",
  kind: "peer-reviewed",
  facility: "Holland Proton Therapy Centre (HollandPTC), Delft",
  particle: "proton",
  energyMeV: 200,
} as const;

const SINGLE_ENERGY = (mev: number) =>
  `Tested at one proton energy (${mev} MeV), so the cross-section's threshold energy is unknown; the band assumes it is flat over the protons that matter.`;

export const PROFILES: readonly ProcessorProfile[] = [
  {
    id: "nvidia-jetson-tx2",
    version: 1,
    name: "NVIDIA Jetson TX2 module",
    campaigns: [
      {
        citation:
          "Wyrwas, \"Proton Testing of nVidia Jetson TX2\", NASA GSFC Radiation Effects and Analysis Group (Code 561.4) test report, 22 July 2019, NTRS 20190031856",
        url: "https://ntrs.nasa.gov/citations/20190031856",
        kind: "test report",
        facility: "Massachusetts General Hospital, Francis H. Burr Proton Therapy Center",
        particle: "proton",
        energyMeV: 200,
        dut: "Jetson TX2 module (Tegra SoC, 20 nm), 2 parts, beam through the carrier board and heat sink onto the SoC; CUDA sample workloads",
        results: [
          {
            effect: "SEFI",
            observed: "functional interrupt that needed a power cycle (Table 2 heads the column \"SEU cross section\"; the text says every event was such a SEFI)",
            value: 1.02e-9,
            unit: "cm²/device",
            range: { low: 2.5e-10, high: 4.17e-9, basis: "minimum and maximum of the per-run values (Table 2)" },
            events: "11 runs, one SEFI each, so each run's value is 1/fluence; the printed value is their average",
          },
        ],
        notes: [
          "Only SEFIs were counted; no SEU or SDC figures. The per-run values span a factor of about 17.",
          "The cover gives the test date as 2 June 2019 and the text as 2 June 2018.",
          "Of the two parts, the second stopped working for good in its first run; the report gives no root cause yet.",
        ],
      },
    ],
    limitations: [SINGLE_ENERGY(200)],
  },
  {
    id: "nvidia-jetson-xavier-nx",
    version: 1,
    name: "NVIDIA Jetson Xavier NX module",
    campaigns: [
      {
        ...XAVIER_2022,
        dut: "Jetson Xavier NX (commercial module)",
        results: [
          { effect: "SEU", observed: "cache error corrected by ECC and logged by the ARM RAS unit", value: 2.91e-8, unit: "cm²/device", range: null, events: null },
          { effect: "SEFI", observed: "uncorrectable error followed by a reboot", value: 1.3e-8, unit: "cm²/device", range: null, events: null },
        ],
        notes: ["No errors were seen in the GPU during the campaign; the paper attributes this to the GPU's short share of the run time."],
      },
    ],
    limitations: [SINGLE_ENERGY(200)],
  },
  {
    id: "nvidia-jetson-agx-xavier-industrial",
    version: 1,
    name: "NVIDIA Jetson AGX Xavier Industrial module",
    campaigns: [
      {
        ...XAVIER_2022,
        dut: "Jetson AGX Xavier Industrial",
        results: [
          { effect: "SEU", observed: "cache error corrected by ECC and logged by the ARM RAS unit", value: 3.61e-8, unit: "cm²/device", range: null, events: null },
          { effect: "SEFI", observed: "uncorrectable error followed by a reboot", value: 1.52e-8, unit: "cm²/device", range: null, events: null },
        ],
        notes: ["No errors were seen in the GPU during the campaign; the paper attributes this to the GPU's short share of the run time."],
      },
    ],
    limitations: [SINGLE_ENERGY(200)],
  },
];

/** Why a profile can't be used for a band, or null when it can. */
export function profileProblem(p: ProcessorProfile): string | null {
  const cited = p.campaigns.filter((c) => c.citation.trim() !== "" && /^https:\/\/\S+$/.test(c.url));
  if (!cited.length) return `Profile "${p.id}" has no cited test source, so it is not used.`;
  if (!cited.some((c) => c.particle === "proton" && c.results.length > 0)) {
    return `Profile "${p.id}" has no cited proton test result; the band rests on trapped and solar protons, so it is not given.`;
  }
  return null;
}

export function findProfile(id: string, library: readonly ProcessorProfile[] = PROFILES): ProcessorProfile | null {
  return library.find((p) => p.id === id) ?? null;
}
