/**
 * Processor radiation profiles (PR-02, GAU-58): published single-event-effect (SEE) test results
 * for onboard processors, so a trust record can say on what data its upset-risk band rests.
 *
 * Every profile cites the test it came from (DOI or test report), the facility, the particle and
 * its energy, and states its units (cm² per device or per bit). Effect classes stay separate:
 * SEU (a bit flipped and was corrected, e.g. by cache ECC), SEFI (the device or a subsystem stopped
 * until a reset, reboot or power cycle) and SDC (a wrong output with no error raised) are never
 * added together. Values are as printed in the source, with the spread it prints, and were read
 * twice against the source text (2026-10-24). Anything Gauss worked out itself is labelled so.
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
  /** Which part of the device and which set-up, when the source gives figures per condition. */
  condition: string;
  /** What was counted, in the source's terms. */
  observed: string;
  value: number;
  unit: "cm²/device" | "cm²/bit";
  /** The spread the source prints with the value, or null when it prints none. */
  range: { low: number; high: number; basis: string } | null;
  /** How many events the value rests on. */
  events: string;
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

const SINGLE_ENERGY = (mev: number) =>
  `Tested at one proton energy (${mev} MeV), so the cross-section's threshold energy is unknown; the band assumes it is flat over the protons that matter.`;

const XAVIER_2022 = {
  citation:
    "Rodriguez-Ferrandez, Tali, Kosmidis, Rovituso & Steenari, \"Sources of Single Event Effects in the NVIDIA Xavier SoC Family under Proton Irradiation\", IEEE IOLTS 2022",
  url: "https://doi.org/10.1109/IOLTS56730.2022.9897236",
  kind: "peer-reviewed",
  facility: "Holland Proton Therapy Centre (HollandPTC), Delft",
  particle: "proton",
  energyMeV: 200,
} as const;

const XAVIER_SEU = "cache error corrected by ECC and reported by the ARM RAS unit";
const XAVIER_SEFI = "uncorrectable error reported by RAS, then kernel panic and reboot";
const XAVIER_NOTES = [
  "SoC only: 9 cm² beam through the back of the board, cooling left on; 3 power modes × idle/CPU/GPU workloads.",
  "Values are the paper's summary (§VI). It does not show how they follow from the per-configuration Tables II–III.",
  "No wrong matrix-multiplication outputs, no GPU errors and no destructive latch-up were seen, so there is no SDC figure.",
];

const ORIN_2024 =
  "Rodriguez-Ferrandez, Kosmidis, Tali, Steenari, Hands & Bélanger-Champagne, \"Proton Evaluation of Single Event Effects in the NVIDIA GPU Orin SoM: Understanding Radiation Vulnerabilities Beyond the SoC\", IEEE IOLTS 2024";
/** The bounds Orin's tables print (Gauss check: they match 95% Poisson intervals on σ × fluence events). */
const orinRange = (low: number, high: number, table: string) => ({
  low,
  high,
  basis: `lower and upper cross-section as printed (${table}); the paper doesn't name them, but they match 95% Poisson intervals on the event count`,
});
const ORIN_SOC_SEU = "error corrected by the SoC and reported by the ARM RAS unit, execution continued";
const ORIN_SOC_SEFI = "kernel panic and reboot";

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
            condition: "whole SoC",
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
          { effect: "SEU", condition: "SoC, all power modes and workloads", observed: XAVIER_SEU, value: 2.91e-8, unit: "cm²/device", range: null, events: "17 (Gauss count: 19 SEEs over 9 configurations in Table III, less the 2 SEFIs in Table IV)" },
          { effect: "SEFI", condition: "SoC, all power modes and workloads", observed: XAVIER_SEFI, value: 1.3e-8, unit: "cm²/device", range: null, events: "2 SEFIs (Table IV)" },
        ],
        notes: XAVIER_NOTES,
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
          { effect: "SEU", condition: "SoC, all power modes and workloads", observed: XAVIER_SEU, value: 3.61e-8, unit: "cm²/device", range: null, events: "51 (Gauss count: 58 SEEs over 9 configurations in Table II, less the 7 SEFIs in Table IV)" },
          { effect: "SEFI", condition: "SoC, all power modes and workloads", observed: XAVIER_SEFI, value: 1.52e-8, unit: "cm²/device", range: null, events: "7 SEFIs (Table IV)" },
        ],
        notes: XAVIER_NOTES,
      },
    ],
    limitations: [SINGLE_ENERGY(200)],
  },
  {
    id: "nvidia-jetson-orin-nx",
    version: 1,
    name: "NVIDIA Jetson Orin NX module",
    campaigns: [
      {
        citation: ORIN_2024,
        url: "https://doi.org/10.1109/IOLTS60994.2024.10616076",
        kind: "peer-reviewed",
        facility: "TRIUMF, BL1B beamline, Vancouver",
        particle: "proton",
        energyMeV: 480,
        dut: "Jetson Orin NX system-on-module; 3 × 3 cm beam on the SoC through the back of the board, then 1.5 × 3 cm on parts of the module; GPU matrix multiplication with a verification kernel",
        results: [
          { effect: "SEU", condition: "SoC, 15 W mode", observed: ORIN_SOC_SEU, value: 3.9e-9, unit: "cm²/device", range: orinRange(2.44e-9, 5.9e-9, "Table II"), events: "not printed; fluence 5.65e9 p/cm²" },
          { effect: "SEU", condition: "SoC, 10 W mode", observed: ORIN_SOC_SEU, value: 4.43e-9, unit: "cm²/device", range: orinRange(3.13e-9, 6.08e-9, "Table II"), events: "not printed; fluence 8.58e9 p/cm²" },
          { effect: "SEU", condition: "SoC, sub-10 W mode", observed: ORIN_SOC_SEU, value: 2.5e-9, unit: "cm²/device", range: orinRange(1.25e-9, 4.47e-9, "Table II"), events: "not printed; fluence 4.41e9 p/cm²" },
          { effect: "SEFI", condition: "SoC, 15 W mode", observed: ORIN_SOC_SEFI, value: 1.59e-9, unit: "cm²/device", range: orinRange(7.29e-10, 3.03e-9, "Table III"), events: "not printed; fluence 5.65e9 p/cm²" },
          { effect: "SEFI", condition: "SoC, 10 W mode", observed: ORIN_SOC_SEFI, value: 1.51e-9, unit: "cm²/device", range: orinRange(8.07e-10, 2.59e-9, "Table III"), events: "not printed; fluence 8.58e9 p/cm²" },
          { effect: "SEFI", condition: "SoC, sub-10 W mode", observed: ORIN_SOC_SEFI, value: 6.81e-10, unit: "cm²/device", range: orinRange(1.4e-10, 1.99e-9, "Table III"), events: "not printed; fluence 4.41e9 p/cm²" },
          { effect: "SEU", condition: "CPU complex, all modes", observed: "error corrected and reported by RAS", value: 3.22e-9, unit: "cm²/device", range: orinRange(2.48e-9, 4.11e-9, "Table IV"), events: "not printed; fluence 1.99e10 p/cm²" },
          { effect: "SEU", condition: "GPU complex, all modes", observed: "error corrected by the GPU, execution continued", value: 3.52e-10, unit: "cm²/device", range: orinRange(1.42e-10, 7.26e-10, "Table IV"), events: "not printed; fluence 1.99e10 p/cm²" },
          { effect: "SEFI", condition: "CPU complex, all modes", observed: "CPU fault forcing a reboot", value: 6.04e-10, unit: "cm²/device", range: orinRange(3.85e-10, 1.18e-9, "Table V"), events: "not printed; fluence 1.99e10 p/cm²" },
          { effect: "SEFI", condition: "GPU complex, all modes", observed: "GPU driver failure or kernel restart; never restarted the CPU", value: 6.54e-10, unit: "cm²/device", range: orinRange(3.48e-10, 1.12e-9, "Table V"), events: "not printed; fluence 1.99e10 p/cm²" },
        ],
        notes: [
          "The verification kernel never saw a wrong output, so there is no SDC figure.",
          "The paper saw no significant power-mode effect; the sub-10 W mode had the least fluence.",
          "Three current jumps that cut the power supply while the beam was on a power-delivery area, possibly latch-up; the board ran normally after power was restored, and the source (module or carrier-board regulator) was not determined.",
        ],
      },
    ],
    limitations: [SINGLE_ENERGY(480)],
  },
];

const cited = (p: ProcessorProfile) => p.campaigns.filter((c) => c.citation.trim() !== "" && /^https:\/\/\S+$/.test(c.url));

/** The campaigns a band may rest on: cited, with proton results. */
export function citedProtonCampaigns(p: ProcessorProfile): TestCampaign[] {
  return cited(p).filter((c) => c.particle === "proton" && c.results.length > 0);
}

/** Why a profile can't be used for a band, or null when it can. */
export function profileProblem(p: ProcessorProfile): string | null {
  if (!cited(p).length) return `Profile "${p.id}" has no cited test source, so it is not used.`;
  if (!citedProtonCampaigns(p).length) {
    return `Profile "${p.id}" has no cited proton test result; the band rests on trapped and solar protons, so it is not given.`;
  }
  return null;
}

export function findProfile(id: string, library: readonly ProcessorProfile[] = PROFILES): ProcessorProfile | null {
  return library.find((p) => p.id === id) ?? null;
}
