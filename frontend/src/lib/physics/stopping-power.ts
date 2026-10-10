/**
 * Mass stopping powers in silicon, for absorbed-dose estimates.
 *
 * Source: NIST Standard Reference Database 124 (M.J. Berger, J.S. Coursey,
 * M.A. Zucker, J. Chang, "ESTAR, PSTAR and ASTAR: Computer Programs for
 * Calculating Stopping-Power and Range Tables for Electrons, Protons and Helium
 * Ions"), material 014 Silicon, https://physics.nist.gov/PhysRefData/Star/Text/
 * (retrieved 2026-10-10). The rows are NIST's default energy grid at mantissas
 * 1, 1.5, 2, 3, 4, 5, 6 and 8 per decade, copied without conversion.
 *
 * The tables hold the electronic (collision) stopping power: energy lost to
 * ionisation and excitation, which is what a thin target absorbs. Two terms
 * are left out on purpose:
 * - proton nuclear stopping: < 0.1 % of the total above 1 MeV, and it causes
 *   displacement damage rather than ionising dose;
 * - electron radiative stopping: bremsstrahlung photons mostly escape a thin
 *   target.
 */

import type { EnergyRange } from '@/lib/types/radiation';

/** Particles with a NIST stopping-power table here. */
export type StoppingParticle = 'proton' | 'electron';

/** [kinetic energy (MeV), mass stopping power (MeV·cm²/g)], ascending energy. */
type StoppingTable = ReadonlyArray<readonly [number, number]>;

/** PSTAR, Silicon, electronic stopping power. */
const PSTAR_SI_ELECTRONIC: StoppingTable = [
  [1.000E-02, 3.320E+02],
  [1.500E-02, 3.925E+02],
  [2.000E-02, 4.378E+02],
  [3.000E-02, 4.989E+02],
  [4.000E-02, 5.323E+02],
  [5.000E-02, 5.470E+02],
  [6.000E-02, 5.490E+02],
  [8.000E-02, 5.322E+02],
  [1.000E-01, 5.044E+02],
  [1.500E-01, 4.373E+02],
  [2.000E-01, 3.884E+02],
  [3.000E-01, 3.259E+02],
  [4.000E-01, 2.859E+02],
  [5.000E-01, 2.567E+02],
  [6.000E-01, 2.351E+02],
  [8.000E-01, 2.011E+02],
  [1.000E+00, 1.753E+02],
  [1.500E+00, 1.354E+02],
  [2.000E+00, 1.117E+02],
  [3.000E+00, 8.428E+01],
  [4.000E+00, 6.856E+01],
  [5.000E+00, 5.824E+01],
  [6.000E+00, 5.088E+01],
  [8.000E+00, 4.099E+01],
  [1.000E+01, 3.458E+01],
  [1.500E+01, 2.528E+01],
  [2.000E+01, 2.019E+01],
  [3.000E+01, 1.469E+01],
  [4.000E+01, 1.172E+01],
  [5.000E+01, 9.852E+00],
  [6.000E+01, 8.561E+00],
  [8.000E+01, 6.883E+00],
  [1.000E+02, 5.836E+00],
  [1.500E+02, 4.382E+00],
  [2.000E+02, 3.627E+00],
  [3.000E+02, 2.852E+00],
  [4.000E+02, 2.462E+00],
  [5.000E+02, 2.230E+00],
  [6.000E+02, 2.079E+00],
  [8.000E+02, 1.899E+00],
  [1.000E+03, 1.801E+00],
  [1.500E+03, 1.696E+00],
  [2.000E+03, 1.665E+00],
  [3.000E+03, 1.668E+00],
  [4.000E+03, 1.692E+00],
  [5.000E+03, 1.720E+00],
  [6.000E+03, 1.746E+00],
  [8.000E+03, 1.792E+00],
  [1.000E+04, 1.830E+00],
];

/** ESTAR, Silicon, collision stopping power. */
const ESTAR_SI_COLLISION: StoppingTable = [
  [1.000E-02, 1.689E+01],
  [1.500E-02, 1.251E+01],
  [2.000E-02, 1.010E+01],
  [3.000E-02, 7.480E+00],
  [4.000E-02, 6.067E+00],
  [5.000E-02, 5.175E+00],
  [6.000E-02, 4.559E+00],
  [8.000E-02, 3.761E+00],
  [1.000E-01, 3.265E+00],
  [1.500E-01, 2.583E+00],
  [2.000E-01, 2.236E+00],
  [3.000E-01, 1.892E+00],
  [4.000E-01, 1.729E+00],
  [5.000E-01, 1.638E+00],
  [6.000E-01, 1.585E+00],
  [8.000E-01, 1.529E+00],
  [1.000E+00, 1.507E+00],
  [1.500E+00, 1.502E+00],
  [2.000E+00, 1.518E+00],
  [3.000E+00, 1.558E+00],
  [4.000E+00, 1.591E+00],
  [5.000E+00, 1.618E+00],
  [6.000E+00, 1.639E+00],
  [8.000E+00, 1.672E+00],
  [1.000E+01, 1.697E+00],
  [1.500E+01, 1.740E+00],
  [2.000E+01, 1.769E+00],
  [3.000E+01, 1.809E+00],
  [4.000E+01, 1.837E+00],
  [5.000E+01, 1.858E+00],
  [6.000E+01, 1.874E+00],
  [8.000E+01, 1.900E+00],
  [1.000E+02, 1.919E+00],
  [1.500E+02, 1.952E+00],
  [2.000E+02, 1.975E+00],
  [3.000E+02, 2.006E+00],
  [4.000E+02, 2.029E+00],
  [5.000E+02, 2.046E+00],
  [6.000E+02, 2.060E+00],
  [8.000E+02, 2.082E+00],
  [1.000E+03, 2.099E+00],
];

const SILICON_TABLES: Record<StoppingParticle, StoppingTable> = {
  proton: PSTAR_SI_ELECTRONIC,
  electron: ESTAR_SI_COLLISION,
};

export function hasStoppingPowerTable(particle: string): particle is StoppingParticle {
  return particle === 'proton' || particle === 'electron';
}

/** Tabulated energy range in MeV; values outside it are not extrapolated. */
export function stoppingPowerRange(particle: StoppingParticle): EnergyRange {
  const table = SILICON_TABLES[particle];
  return { min: table[0][0], max: table[table.length - 1][0] };
}

/** Index i of the segment [E_i, E_i+1] that contains energyMeV. */
function segmentIndex(table: StoppingTable, energyMeV: number): number {
  let lo = 0;
  let hi = table.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid][0] <= energyMeV) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Exponent k of the power law S = S_i·(E/E_i)^k through segment i. */
function segmentSlope(table: StoppingTable, i: number): number {
  const [e0, s0] = table[i];
  const [e1, s1] = table[i + 1];
  return Math.log(s1 / s0) / Math.log(e1 / e0);
}

/**
 * Electronic mass stopping power in Si (MeV·cm²/g) at one kinetic energy,
 * interpolated linearly in log S vs log E. Returns null outside the table.
 */
export function massStoppingPowerSi(particle: StoppingParticle, energyMeV: number): number | null {
  const table = SILICON_TABLES[particle];
  const { min, max } = stoppingPowerRange(particle);
  if (!(energyMeV >= min && energyMeV <= max)) return null;

  const i = segmentIndex(table, energyMeV);
  const [e0, s0] = table[i];
  return s0 * (energyMeV / e0) ** segmentSlope(table, i);
}

/**
 * Bin-averaged stopping power S̄ = (1/ΔE)·∫ S(E) dE over [min, max] (MeV·cm²/g),
 * integrating the log-log interpolant exactly. This is the stopping power to
 * use when the differential flux is taken as flat across the bin.
 * Returns null for an empty bin or one that leaves the table.
 */
export function meanStoppingPowerSi(particle: StoppingParticle, energyRange: EnergyRange): number | null {
  const table = SILICON_TABLES[particle];
  const { min, max } = energyRange;
  const range = stoppingPowerRange(particle);
  if (!(max > min) || min < range.min || max > range.max) return null;

  let integral = 0;
  for (let i = segmentIndex(table, min); i < table.length - 1 && table[i][0] < max; i++) {
    const [e0, s0] = table[i];
    const a = Math.max(min, e0);
    const b = Math.min(max, table[i + 1][0]);
    const k = segmentSlope(table, i);
    // ∫_a^b S_i·(E/E_i)^k dE
    integral +=
      Math.abs(k + 1) < 1e-12
        ? s0 * e0 * Math.log(b / a)
        : ((s0 * e0) / (k + 1)) * ((b / e0) ** (k + 1) - (a / e0) ** (k + 1));
  }
  return integral / (max - min);
}
