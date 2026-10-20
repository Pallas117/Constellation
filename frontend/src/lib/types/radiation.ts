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

/**
 * Radiation alert level (thresholds and sources in getAlertLevel, lib/utils/radiation.ts)
 */
export type AlertLevel = 'low' | 'moderate' | 'high' | 'severe';

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
 * Core radiation measurement interface
 */
export interface RadiationMeasurement {
  /** ISO 8601 timestamp */
  timestamp: string;
  
  /** Particle flux in particles/(cm²·s·sr·MeV) or particles/(cm²·s) */
  particleFlux: number;
  
  /** Altitude in kilometers */
  altitude: number;
  
  /** L-shell parameter (McIlwain L) - dimensionless */
  L_shell: number;
  
  /** Radiation zone classification derived from L-shell and altitude */
  radiationZone?: RadiationZone;
  
  /** Geographic latitude in degrees */
  latitude?: number;
  
  /** Geographic longitude in degrees */
  longitude?: number;
  
  /** Particle type */
  particleType: ParticleType;
  
  /** Energy range for this measurement */
  energyRange: EnergyRange;
  
  /** Orbit classification */
  orbitType: OrbitType;
  
  /** Data source identifier */
  source: 'nasa-omni' | 'spenvis' | 'erg-arase' | 'cses' | 'unknown';
  
  /** Optional metadata */
  metadata?: {
    instrument?: string;
    quality?: 'high' | 'medium' | 'low';
    uncertainty?: number;
    [key: string]: unknown;
  };
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

/**
 * Time series data structure
 */
export interface RadiationTimeSeries {
  data: RadiationDataPoint[];
  startTime: string;
  endTime: string;
  orbitType: OrbitType;
  particleType: ParticleType;
  energyRange: EnergyRange;
  source: string;
}

/**
 * Filter parameters for querying radiation data
 */
export interface RadiationDataFilter {
  /** Start time (ISO 8601) */
  startTime?: string;
  
  /** End time (ISO 8601) */
  endTime?: string;
  
  /** Orbit types to include */
  orbitTypes?: OrbitType[];
  
  /** Particle types to include */
  particleTypes?: ParticleType[];
  
  /** Energy range filter */
  energyRange?: EnergyRange;
  
  /** L-shell range */
  L_shellRange?: {
    min: number;
    max: number;
  };
  
  /** Altitude range in km */
  altitudeRange?: {
    min: number;
    max: number;
  };
  
  /** Radiation zones to include */
  radiationZones?: RadiationZone[];
  
  /** Data sources to include */
  sources?: Array<'nasa-omni' | 'spenvis' | 'erg-arase' | 'cses' | 'unknown'>;
  
  /** Maximum number of data points to return */
  limit?: number;
}

/**
 * API response wrapper
 */
export interface RadiationDataResponse {
  data: RadiationMeasurement[];
  metadata: {
    count: number;
    startTime: string;
    endTime: string;
    sources: string[];
    queryTime: string;
  };
}

/**
 * Real-time radiation data snapshot
 */
export interface RealTimeRadiationSnapshot {
  timestamp: string;
  measurements: RadiationMeasurement[];
  summary: {
    averageFlux: number;
    maxFlux: number;
    minFlux: number;
    activeOrbits: OrbitType[];
    /** Null when no measurement covers a channel with a cited threshold */
    alertLevel: AlertLevel | null;
  };
}

