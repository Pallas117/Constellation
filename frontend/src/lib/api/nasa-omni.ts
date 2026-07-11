/**
 * NASA OMNI (Operating Missions as a Node on the Internet) API client
 * Provides solar wind and radiation data
 * 
 * Documentation: https://omniweb.gsfc.nasa.gov/
 */

import type { RadiationMeasurement, OrbitType, ParticleType, EnergyRange } from '@/lib/types/radiation';

export interface OMNIQueryParams {
  startDate: string; // YYYYMMDD format
  endDate: string; // YYYYMMDD format
  variables?: string[]; // OMNI variable names
  resolution?: 'hourly' | '5min' | '1min';
}

export interface OMNIDataPoint {
  time: string;
  proton_flux_1MeV?: number; // protons/(cm²·s·sr·MeV)
  proton_flux_10MeV?: number;
  electron_flux_2MeV?: number;
  electron_flux_4MeV?: number;
  solar_wind_speed?: number; // km/s
  solar_wind_density?: number; // cm⁻³
  Bz?: number; // nT
  Kp?: number;
  Dst?: number; // nT
}

/**
 * Convert OMNI data point to RadiationMeasurement
 */
function convertOMNIToRadiation(
  omniData: OMNIDataPoint,
  orbitType: OrbitType,
  particleType: ParticleType,
  energyRange: EnergyRange
): RadiationMeasurement | null {
  let particleFlux: number | undefined;

  // Map OMNI variables to particle flux based on particle type and energy
  if (particleType === 'proton') {
    if (energyRange.min >= 0.5 && energyRange.max <= 2) {
      particleFlux = omniData.proton_flux_1MeV;
    } else if (energyRange.min >= 5 && energyRange.max <= 15) {
      particleFlux = omniData.proton_flux_10MeV;
    }
  } else if (particleType === 'electron') {
    if (energyRange.min >= 1 && energyRange.max <= 3) {
      particleFlux = omniData.electron_flux_2MeV;
    } else if (energyRange.min >= 3 && energyRange.max <= 5) {
      particleFlux = omniData.electron_flux_4MeV;
    }
  }

  if (particleFlux === undefined || particleFlux === null || isNaN(particleFlux)) {
    return null;
  }

  // Estimate altitude and L-shell from orbit type (approximate)
  const altitude = getOrbitAltitude(orbitType);
  const L_shell = estimateLShell(orbitType);

  return {
    timestamp: omniData.time,
    particleFlux,
    altitude,
    L_shell,
    particleType,
    energyRange,
    orbitType,
    source: 'nasa-omni',
    metadata: {
      instrument: 'OMNI',
      quality: 'high',
    },
  };
}

/**
 * Get approximate altitude for orbit type
 */
function getOrbitAltitude(orbitType: OrbitType): number {
  switch (orbitType) {
    case 'LEO':
      return 400; // Low Earth Orbit: 160-2000 km, using 400 km as typical
    case 'MEO':
      return 20000; // Medium Earth Orbit: 2000-35786 km, using 20000 km
    case 'GEO':
      return 35786; // Geostationary Orbit: ~35786 km
    default:
      return 400;
  }
}

/**
 * Estimate L-shell from orbit type (simplified)
 */
function estimateLShell(orbitType: OrbitType): number {
  switch (orbitType) {
    case 'LEO':
      return 1.1; // LEO typically L ~ 1.0-1.2
    case 'MEO':
      return 4.5; // MEO typically L ~ 3-6
    case 'GEO':
      return 6.6; // GEO typically L ~ 6.6
    default:
      return 1.1;
  }
}

/**
 * Fetch data from NASA OMNI web service
 * Note: This is a placeholder implementation. Actual OMNI API may require
 * different endpoints or authentication.
 */
export async function fetchOMNIData(
  params: OMNIQueryParams
): Promise<RadiationMeasurement[]> {
  try {
    // OMNI web service endpoint (example - actual endpoint may differ)
    const baseUrl = 'https://omniweb.gsfc.nasa.gov/cgi/nx1.cgi';
    
    const queryParams = new URLSearchParams({
      activity: 'retrieve',
      res: params.resolution || 'hourly',
      spacecraft: 'omni',
      start_date: params.startDate,
      end_date: params.endDate,
      vars: params.variables?.join(',') || 'proton_flux_1MeV,proton_flux_10MeV,electron_flux_2MeV,electron_flux_4MeV',
      fmt: 'json',
    });

    const response = await fetch(`${baseUrl}?${queryParams.toString()}`);

    if (!response.ok) {
      throw new Error(`OMNI API error: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Parse OMNI response (format may vary)
    const measurements: RadiationMeasurement[] = [];
    
    // Process proton data
    if (data.proton_flux_1MeV) {
      data.proton_flux_1MeV.forEach((point: OMNIDataPoint) => {
        const measurement = convertOMNIToRadiation(
          point,
          'LEO', // Default, can be parameterized
          'proton',
          { min: 0.5, max: 2 }
        );
        if (measurement) measurements.push(measurement);
      });
    }

    if (data.proton_flux_10MeV) {
      data.proton_flux_10MeV.forEach((point: OMNIDataPoint) => {
        const measurement = convertOMNIToRadiation(
          point,
          'LEO',
          'proton',
          { min: 5, max: 15 }
        );
        if (measurement) measurements.push(measurement);
      });
    }

    // Process electron data
    if (data.electron_flux_2MeV) {
      data.electron_flux_2MeV.forEach((point: OMNIDataPoint) => {
        const measurement = convertOMNIToRadiation(
          point,
          'LEO',
          'electron',
          { min: 1, max: 3 }
        );
        if (measurement) measurements.push(measurement);
      });
    }

    if (data.electron_flux_4MeV) {
      data.electron_flux_4MeV.forEach((point: OMNIDataPoint) => {
        const measurement = convertOMNIToRadiation(
          point,
          'LEO',
          'electron',
          { min: 3, max: 5 }
        );
        if (measurement) measurements.push(measurement);
      });
    }

    return measurements;
  } catch (error) {
    console.error('Error fetching OMNI data:', error);
    throw new Error(`Failed to fetch OMNI data: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Format date to OMNI format (YYYYMMDD)
 */
export function formatOMNIDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

