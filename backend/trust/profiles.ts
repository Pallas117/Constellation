/**
 * Processor radiation profiles (PR-02, GAU-58): published single-event-effect (SEE) test results
 * for onboard processors, so a trust record can say on what data its upset-rate band rests.
 *
 * Every profile cites the test it came from (DOI or test report), the facility, the particle and
 * its energy, and states its units (cm² per device or per bit). Effect classes stay separate and
 * follow how these sources classify events: SEU (an upset the device corrected, e.g. by cache ECC),
 * SEFI (the device or a subsystem stopped until a reset, reboot or power cycle) and SDC (a wrong
 * output with no error raised) are never added together. Values are as printed in the source, with the spread it prints, and were read
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
  /** Fluence behind the value as printed, p/cm², or null when the source prints none for it. */
  fluence: number | null;
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

const XAVIER_SEU = "correctable cache error reported by the ARM RAS unit (mostly ECC-corrected; a few parity errors)";
const XAVIER_SEFI = "uncorrectable error, then kernel panic and reboot";
const XAVIER_NOTES = [
  "SoC only: 9 cm² beam through the back of the board, cooling left on; 3 power modes × idle/CPU/GPU workloads.",
  "Values are the paper's summary (§VI), taken as printed. They can't be reproduced from the per-configuration Tables II–IV: pooling the tables gives SEFI cross-sections about 4 times lower, and three table rows don't equal events / fluence.",
  "No wrong matrix-multiplication outputs, no GPU errors and no destructive latch-up were seen, so there is no SDC figure.",
];
const SOC_ONLY = "The data cover the SoC under a collimated beam, not the module's memory, power or I/O.";

const ORIN_2024 =
  "Rodriguez-Ferrandez, Kosmidis, Tali, Steenari, Hands & Bélanger-Champagne, \"Proton Evaluation of Single Event Effects in the NVIDIA GPU Orin SoM: Understanding Radiation Vulnerabilities Beyond the SoC\", IEEE IOLTS 2024";
/**
 * The bounds Orin's Tables II–V print. The paper doesn't name them. Gauss check: σ × fluence is
 * within 0.1 of a whole event count in every row (σ is printed to 3 significant figures), and the
 * bounds equal the exact 95% Poisson
 * (Garwood) interval on that count, except Table V CPU SEFI (see that row).
 */
const orinRange = (low: number, high: number, table: string) => ({
  low,
  high,
  basis: `lower and upper cross-section as printed (${table}); they equal the exact 95% Poisson interval on the event count (Gauss check)`,
});
const orinEvents = (n: number) => `not printed; Gauss check: σ × fluence = ${n} events`;
const ORIN_SOC_SEU = "error the SoC corrected and execution continued (RAS reports, and GPU error dumps for GPU errors)";
const ORIN_SOC_SEFI = "CPU fault forcing a kernel panic and reboot, or a GPU driver failure or CUDA-kernel restart that did not reboot the CPU";

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
        dut: "Jetson TX2 module, 2 parts, beam through the carrier board and heat sink onto the SoC; CUDA sample workloads",
        results: [
          {
            effect: "SEFI",
            condition: "whole SoC",
            observed:
              "functional interrupt (Table 2 heads the column \"SEU cross section\"). The text says each SEFI needed a power cycle, but run 13 was the second part's only run, in which it stopped working for good",
            value: 1.02e-9,
            unit: "cm²/device",
            range: {
              low: 2.5e-10,
              high: 4.17e-9,
              basis: "minimum and maximum of the per-run values (Table 2); with one event per run this is counting scatter, not a measured spread of the device",
            },
            fluence: null,
            events: "11 runs, one event each (Gauss check: σ × fluence = 1.00 for every run); the printed value is the average of the per-run 1/fluence",
          },
        ],
        notes: [
          "Only SEFIs are reported; no SEU or SDC figures. The per-run values span a factor of about 17.",
          "Gauss check: pooled over all runs, 11 events / 2.024e10 p/cm² = 5.4e-10 cm² (95% interval 2.7e-10 to 9.7e-10). The printed average is 1.9 times higher and above that bound, because averaging 1/fluence over runs that stop at the first event is biased high.",
          "Table 1 gives the SoC as 20 nm; AnandTech gives the TX2's Parker SoC as 16 nm FinFET (https://www.anandtech.com/show/11185).",
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
          {
            effect: "SEU",
            condition: "SoC, all power modes and workloads",
            observed: XAVIER_SEU,
            value: 2.91e-8,
            unit: "cm²/device",
            range: null,
            fluence: null,
            events: "not stated for the summary value; Tables III–IV list 19 events in all, 2 of them SEFIs (Gauss check: 19 / 6.548e8 p/cm² = 2.90e-8, so the printed SEU value may include the SEFIs)",
          },
          {
            effect: "SEFI",
            condition: "SoC, all power modes and workloads",
            observed: XAVIER_SEFI,
            value: 1.3e-8,
            unit: "cm²/device",
            range: null,
            fluence: null,
            events: "not stated for the summary value; Table IV lists 2 SEFIs (Gauss check: 2 / 6.548e8 p/cm² = 3.1e-9, 95% 3.7e-10 to 1.1e-8)",
          },
        ],
        notes: XAVIER_NOTES,
      },
    ],
    limitations: [SINGLE_ENERGY(200), SOC_ONLY],
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
          {
            effect: "SEU",
            condition: "SoC, all power modes and workloads",
            observed: XAVIER_SEU,
            value: 3.61e-8,
            unit: "cm²/device",
            range: null,
            fluence: null,
            events: "not stated for the summary value; Tables II and IV list 58 events in all, 7 of them SEFIs (Gauss check: 51 / 1.831e9 p/cm² = 2.8e-8)",
          },
          {
            effect: "SEFI",
            condition: "SoC, all power modes and workloads",
            observed: `${XAVIER_SEFI}; RAS reported the error for 6 of the 7`,
            value: 1.52e-8,
            unit: "cm²/device",
            range: null,
            fluence: null,
            events: "not stated for the summary value; Table IV lists 7 SEFIs (Gauss check: 7 / 1.831e9 p/cm² = 3.8e-9, 95% 1.5e-9 to 7.9e-9, below the printed value)",
          },
        ],
        notes: XAVIER_NOTES,
      },
    ],
    limitations: [SINGLE_ENERGY(200), SOC_ONLY],
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
          { effect: "SEU", condition: "SoC, 15 W mode", observed: ORIN_SOC_SEU, value: 3.9e-9, unit: "cm²/device", range: orinRange(2.44e-9, 5.9e-9, "Table II"), fluence: 5.65e9, events: orinEvents(22) },
          { effect: "SEU", condition: "SoC, 10 W mode", observed: ORIN_SOC_SEU, value: 4.43e-9, unit: "cm²/device", range: orinRange(3.13e-9, 6.08e-9, "Table II"), fluence: 8.58e9, events: orinEvents(38) },
          { effect: "SEU", condition: "SoC, sub-10 W mode", observed: ORIN_SOC_SEU, value: 2.5e-9, unit: "cm²/device", range: orinRange(1.25e-9, 4.47e-9, "Table II"), fluence: 4.41e9, events: orinEvents(11) },
          { effect: "SEFI", condition: "SoC, 15 W mode", observed: ORIN_SOC_SEFI, value: 1.59e-9, unit: "cm²/device", range: orinRange(7.29e-10, 3.03e-9, "Table III"), fluence: 5.65e9, events: orinEvents(9) },
          { effect: "SEFI", condition: "SoC, 10 W mode", observed: ORIN_SOC_SEFI, value: 1.51e-9, unit: "cm²/device", range: orinRange(8.07e-10, 2.59e-9, "Table III"), fluence: 8.58e9, events: orinEvents(13) },
          { effect: "SEFI", condition: "SoC, sub-10 W mode", observed: ORIN_SOC_SEFI, value: 6.81e-10, unit: "cm²/device", range: orinRange(1.4e-10, 1.99e-9, "Table III"), fluence: 4.41e9, events: orinEvents(3) },
          { effect: "SEU", condition: "CPU complex, all modes", observed: "error corrected and reported by RAS", value: 3.22e-9, unit: "cm²/device", range: orinRange(2.48e-9, 4.11e-9, "Table IV"), fluence: 1.99e10, events: orinEvents(64) },
          { effect: "SEU", condition: "GPU complex, all modes", observed: "error corrected by the GPU, execution continued", value: 3.52e-10, unit: "cm²/device", range: orinRange(1.42e-10, 7.26e-10, "Table IV"), fluence: 1.99e10, events: orinEvents(7) },
          {
            effect: "SEFI",
            condition: "CPU complex, all modes",
            observed: "CPU fault forcing a kernel panic and reboot",
            value: 6.04e-10,
            unit: "cm²/device",
            range: {
              low: 3.85e-10,
              high: 1.18e-9,
              basis: "lower and upper cross-section as printed (Table V). Gauss check: the value is 12 events, but the bounds are the exact 95% Poisson interval for 14; for 12 it would be 3.12e-10 to 1.05e-9",
            },
            fluence: 1.99e10,
            events: orinEvents(12),
          },
          {
            effect: "SEFI",
            condition: "GPU complex, all modes",
            observed: "GPU driver failure or CUDA-kernel restart; none restarted the CPU",
            value: 6.54e-10,
            unit: "cm²/device",
            range: orinRange(3.48e-10, 1.12e-9, "Table V"),
            fluence: 1.99e10,
            events: orinEvents(13),
          },
        ],
        notes: [
          "The verification kernel never saw a wrong output, so there is no SDC figure.",
          "The SoC rows (Tables II–III) and the CPU/GPU rows (Tables IV–V) split the same 71 SEU and 25 SEFI events two ways: never add them.",
          "The paper reports a noticeable sub-10 W SEFI difference still to be confirmed (that mode had the least fluence), and concludes no significant power-mode effect overall.",
          "Day-2 figures for the module's memory, I/O and power areas (Tables VI–VII) are not included.",
          "Three current jumps that cut the power supply while the beam was on a power-delivery area, possibly latch-up; the board ran normally after power was restored, and the source (module or carrier-board regulator) was not determined.",
        ],
      },
    ],
    limitations: [SINGLE_ENERGY(480), SOC_ONLY],
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
