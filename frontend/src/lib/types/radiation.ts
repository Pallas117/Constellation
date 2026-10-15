/**
 * Type definitions for space radiation measurements
 */

/**
 * Orbit classification types
 */
export type OrbitType = 'LEO' | 'MEO' | 'GEO';

/**
 * Particle type classifications
 */
export type ParticleType = 'proton' | 'electron' | 'alpha' | 'heavy_ion';

export type RadiationZone =
  | 'inner-belt-low'
  | 'inner-belt-high'
  | 'slot-region'
  | 'outer-belt-inner'
  | 'outer-belt-middle'
  | 'outer-belt-outer'
  | 'magnetosphere';

/**
 * Energy range in MeV (Mega-electron Volts)
 */
export interface EnergyRange {
  min: number; // Minimum energy in MeV
  max: number; // Maximum energy in MeV
}

/**
 * Aggregated radiation data for visualization
 */
export interface RadiationDataPoint {
  timestamp: string;
  flux: number;
  altitude: number;
  L_shell: number;
  latitude?: number;
  longitude?: number;
  orbitType: OrbitType;
  particleType: ParticleType;
  energyRange: EnergyRange;
  radiationZone?: RadiationZone;
}
