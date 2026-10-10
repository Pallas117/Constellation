/**
 * Utility functions for radiation calculations
 * Absorbed dose rate and magnetic field calculations
 */

import type {
  EnergyRange,
  ParticleType,
  RadiationMeasurement,
  RadiationDataPoint,
} from '@/lib/types/radiation';
import { hasStoppingPowerTable, meanStoppingPowerSi } from '@/lib/physics/stopping-power';

/** 1 MeV/g in Gy (J/kg): 1.602176634e-13 J per 1e-3 kg. */
export const GRAY_PER_MEV_PER_GRAM = 1.602176634e-10;

/**
 * Omnidirectional flux (cm⁻²·s⁻¹) from unidirectional flux (cm⁻²·s⁻¹·sr⁻¹),
 * assuming an isotropic distribution: Φ = ∫ j dΩ = 4π·j.
 */
export function unidirectionalToOmnidirectional(unidirectionalFlux: number): number {
  return 4 * Math.PI * unidirectionalFlux;
}

/**
 * Thin-target absorbed dose rate for one particle species:
 * Ḋ [Gy/s] = 1.602e-10 × Φ [cm⁻²·s⁻¹] × S [MeV·cm²/g].
 *
 * @param omnidirectionalFlux Φ in cm⁻²·s⁻¹
 * @param stoppingPower Mass stopping power S of the target material in MeV·cm²/g
 */
export function absorbedDoseRate(omnidirectionalFlux: number, stoppingPower: number): number {
  return GRAY_PER_MEV_PER_GRAM * omnidirectionalFlux * stoppingPower;
}

export interface DoseRate {
  /** Absorbed dose rate in Gy/s, in the material below */
  grayPerSecond: number;
  /** Target material. Gy(Si) is the TID unit for electronics; it is not a Sv. */
  material: 'Si';
  /** Omnidirectional flux in the energy bin, cm⁻²·s⁻¹ */
  omnidirectionalFlux: number;
  /** Bin-averaged electronic mass stopping power, MeV·cm²/g (NIST PSTAR/ESTAR) */
  stoppingPower: number;
}

/**
 * Absorbed dose rate in a thin, unshielded silicon layer from one energy bin.
 *
 * Assumptions (state them wherever the number is shown):
 * - the flux is isotropic, so Φ = 4π·j·ΔE;
 * - j is flat across the bin, so the bin uses the bin-averaged S̄;
 * - the layer is thin: no shielding, and particles lose little energy in it.
 *
 * @param flux Differential unidirectional flux j(E) in cm⁻²·s⁻¹·sr⁻¹·MeV⁻¹,
 *   the unit the lib/api adapters report
 * @param energyRange Energy bin in MeV
 * @param particleType Type of particle
 * @returns The dose rate, or null when it cannot be computed: no stopping-power
 *   table for the particle (alpha, heavy ions), an empty bin, a bin outside the
 *   NIST table, or a negative or non-finite flux
 */
export function calculateDoseRate(
  flux: number,
  energyRange: EnergyRange,
  particleType: ParticleType
): DoseRate | null {
  if (!hasStoppingPowerTable(particleType) || !(Number.isFinite(flux) && flux >= 0)) return null;

  const stoppingPower = meanStoppingPowerSi(particleType, energyRange);
  if (stoppingPower === null) return null;

  // Integral unidirectional flux in the bin (cm⁻²·s⁻¹·sr⁻¹), then over 4π sr.
  const omnidirectionalFlux = unidirectionalToOmnidirectional(
    flux * (energyRange.max - energyRange.min)
  );

  return {
    grayPerSecond: absorbedDoseRate(omnidirectionalFlux, stoppingPower),
    material: 'Si',
    omnidirectionalFlux,
    stoppingPower,
  };
}

/**
 * Estimate magnetic field strength from L-shell and altitude
 * Simplified dipole field model
 * 
 * @param L_shell L-shell parameter
 * @param altitude Altitude in km
 * @param latitude Geographic latitude in degrees (optional)
 * @returns Magnetic field strength in nT (nanotesla)
 */
export function estimateMagneticField(
  L_shell: number,
  altitude: number,
  latitude?: number
): number {
  // Earth's magnetic dipole moment (approximate)
  const M = 7.94e22; // A·m²

  // Earth radius in meters
  const R_E = 6.371e6; // meters

  // Distance from Earth center
  const r = (R_E + altitude * 1000) / R_E; // in Earth radii

  // Simplified dipole field strength at equator
  // B = (M / r³) × (1 + 3sin²λ)^(1/2) for dipole field
  // For L-shell: B ≈ M / (L × R_E)³
  
  const baseField = (M / (L_shell * R_E) ** 3) * 1e9; // Convert to nT

  // Latitude correction (if provided)
  if (latitude !== undefined) {
    const latRad = (latitude * Math.PI) / 180;
    const latCorrection = Math.sqrt(1 + 3 * Math.sin(latRad) ** 2);
    return baseField * latCorrection;
  }

  return baseField;
}

/**
 * Absorbed dose rate in Si for a radiation measurement (see calculateDoseRate)
 */
export function getDoseRateFromMeasurement(
  measurement: RadiationMeasurement | RadiationDataPoint
): DoseRate | null {
  if ('particleFlux' in measurement) {
    return calculateDoseRate(
      measurement.particleFlux,
      measurement.energyRange,
      measurement.particleType
    );
  }
  return calculateDoseRate(measurement.flux, measurement.energyRange, measurement.particleType);
}

/**
 * Get magnetic field for a radiation measurement
 */
export function getMagneticFieldFromMeasurement(
  measurement: RadiationMeasurement | RadiationDataPoint
): number {
  if ('altitude' in measurement) {
    return estimateMagneticField(
      measurement.L_shell,
      measurement.altitude,
      'latitude' in measurement ? measurement.latitude : undefined
    );
  }
  return estimateMagneticField(measurement.L_shell, measurement.altitude, measurement.latitude);
}

/**
 * Format source name for display
 */
export function formatSourceName(source: string): string {
  const sourceMap: Record<string, string> = {
    'nasa-omni': 'NASA OMNI',
    'spenvis': 'SPENVIS',
    'erg-arase': 'ERG/Arase',
    'cses': 'CSES',
    'goes-18': 'GOES-18',
    'goes-16': 'GOES-16',
    'goes-17': 'GOES-17',
    'unknown': 'Unknown',
  };

  return sourceMap[source.toLowerCase()] || source.toUpperCase();
}

