/**
 * Utility functions for radiation calculations
 * Dose rate and magnetic field calculations
 */

import type { RadiationMeasurement, RadiationDataPoint } from '@/lib/types/radiation';

/**
 * Calculate dose rate from particle flux
 * Simplified calculation - actual dose rate depends on many factors
 * 
 * @param flux Particle flux in particles/(cm²·s·sr·MeV)
 * @param energyRange Energy range in MeV
 * @param particleType Type of particle
 * @returns Dose rate in mSv/h (millisieverts per hour)
 */
export function calculateDoseRate(
  flux: number,
  energyRange: { min: number; max: number },
  particleType: 'proton' | 'electron' | 'alpha' | 'heavy_ion'
): number {
  // Average energy in MeV
  const avgEnergy = (energyRange.min + energyRange.max) / 2;

  // Conversion factors (simplified, actual values depend on particle type and energy)
  // These are approximate values for space radiation
  const conversionFactors: Record<string, number> = {
    proton: 1.0e-6, // Approximate conversion factor for protons
    electron: 5.0e-7, // Electrons have lower stopping power
    alpha: 2.0e-6, // Alpha particles have higher stopping power
    heavy_ion: 3.0e-6, // Heavy ions have highest stopping power
  };

  const factor = conversionFactors[particleType] || 1.0e-6;

  // Dose rate = flux × energy × conversion factor
  // Convert from per second to per hour
  const doseRate = flux * avgEnergy * factor * 3600; // mSv/h

  return Math.max(0, doseRate);
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
 * Calculate dose rate for a radiation measurement
 */
export function getDoseRateFromMeasurement(measurement: RadiationMeasurement | RadiationDataPoint): number {
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

