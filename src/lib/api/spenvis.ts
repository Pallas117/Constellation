/**
 * SPENVIS (Space Environment Information System) API client
 * Provides space environment and radiation data
 * 
 * Documentation: https://www.spenvis.oma.be/
 * Note: SPENVIS may require authentication or have different access methods
 */

import type { RadiationMeasurement, OrbitType, ParticleType, EnergyRange } from '@/lib/types/radiation';

export interface SPENVISQueryParams {
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  orbitType: OrbitType;
  altitude?: number; // km
  inclination?: number; // degrees
  particleType?: ParticleType;
  energyRange?: EnergyRange;
}

export interface SPENVISDataPoint {
  time: string;
  flux: number; // particles/(cm²·s·sr·MeV)
  altitude: number; // km
  L_shell: number;
  latitude?: number;
  longitude?: number;
  energy: number; // MeV
  particle_type: string;
}

/**
 * Convert SPENVIS data point to RadiationMeasurement
 */
function convertSPENVISToRadiation(
  spenvisData: SPENVISDataPoint,
  orbitType: OrbitType,
  particleType: ParticleType
): RadiationMeasurement {
  // Determine energy range from energy value
  const energyRange: EnergyRange = {
    min: spenvisData.energy * 0.8, // Approximate range
    max: spenvisData.energy * 1.2,
  };

  return {
    timestamp: spenvisData.time,
    particleFlux: spenvisData.flux,
    altitude: spenvisData.altitude,
    L_shell: spenvisData.L_shell,
    latitude: spenvisData.latitude,
    longitude: spenvisData.longitude,
    particleType,
    energyRange,
    orbitType,
    source: 'spenvis',
    metadata: {
      instrument: 'SPENVIS',
      quality: 'high',
    },
  };
}

/**
 * Fetch data from SPENVIS API
 * Note: This is a placeholder implementation. Actual SPENVIS API may require
 * different endpoints, authentication, or web interface interaction.
 */
export async function fetchSPENVISData(
  params: SPENVISQueryParams
): Promise<RadiationMeasurement[]> {
  try {
    // SPENVIS API endpoint (example - actual endpoint may differ)
    // SPENVIS typically uses a web interface, so this may need to be adapted
    const baseUrl = 'https://www.spenvis.oma.be/api/v1/radiation';
    
    const queryParams = new URLSearchParams({
      start_time: params.startTime,
      end_time: params.endTime,
      orbit_type: params.orbitType,
      ...(params.altitude && { altitude: params.altitude.toString() }),
      ...(params.inclination && { inclination: params.inclination.toString() }),
      ...(params.particleType && { particle_type: params.particleType }),
      ...(params.energyRange && {
        energy_min: params.energyRange.min.toString(),
        energy_max: params.energyRange.max.toString(),
      }),
    });

    const response = await fetch(`${baseUrl}?${queryParams.toString()}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        // Add authentication headers if required
        // 'Authorization': `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`SPENVIS API error: ${response.statusText}`);
    }

    const data = await response.json();
    
    // Parse SPENVIS response
    const measurements: RadiationMeasurement[] = [];
    
    if (Array.isArray(data)) {
      data.forEach((point: SPENVISDataPoint) => {
        const particleType: ParticleType = 
          point.particle_type.toLowerCase().includes('proton') ? 'proton' :
          point.particle_type.toLowerCase().includes('electron') ? 'electron' :
          point.particle_type.toLowerCase().includes('alpha') ? 'alpha' :
          'proton'; // default
        
        const measurement = convertSPENVISToRadiation(
          point,
          params.orbitType,
          particleType
        );
        measurements.push(measurement);
      });
    }

    return measurements;
  } catch (error) {
    console.error('Error fetching SPENVIS data:', error);
    throw new Error(`Failed to fetch SPENVIS data: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get SPENVIS model parameters for orbit
 */
export function getSPENVISOrbitParams(orbitType: OrbitType): {
  altitude: number;
  inclination: number;
  L_shell: number;
} {
  switch (orbitType) {
    case 'LEO':
      return {
        altitude: 400,
        inclination: 51.6, // ISS-like
        L_shell: 1.1,
      };
    case 'MEO':
      return {
        altitude: 20000,
        inclination: 55,
        L_shell: 4.5,
      };
    case 'GEO':
      return {
        altitude: 35786,
        inclination: 0,
        L_shell: 6.6,
      };
    default:
      return {
        altitude: 400,
        inclination: 0,
        L_shell: 1.1,
      };
  }
}

