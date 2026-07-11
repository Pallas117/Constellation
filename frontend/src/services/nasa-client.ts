/**
 * NASA OMNI Data Service Client
 * Typed client for fetching NASA OMNI radiation data
 * Uses React Query for caching and revalidation
 * 
 * Note: This is a client-side service component
 */

import { queryOptions } from '@tanstack/react-query';
import type { RadiationMeasurement, OrbitType, ParticleType, EnergyRange } from '@/lib/types/radiation';
import { fetchOMNIData, formatOMNIDate, type OMNIQueryParams } from '@/lib/api/nasa-omni';

export interface NASAClientOptions {
  startDate: Date;
  endDate: Date;
  orbitType?: OrbitType;
  particleType?: ParticleType;
  energyRange?: EnergyRange;
  resolution?: 'hourly' | '5min' | '1min';
}

/**
 * Cache configuration for NASA OMNI data
 * - Static orbital data: Long cache (1 hour)
 * - Recent data: Short cache (5 minutes)
 * - Real-time data: Very short cache (1 minute)
 */
export const NASA_CACHE_CONFIG = {
  static: {
    staleTime: 60 * 60 * 1000, // 1 hour
    gcTime: 24 * 60 * 60 * 1000, // 24 hours (formerly cacheTime)
  },
  recent: {
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 30 * 60 * 1000, // 30 minutes
  },
  realtime: {
    staleTime: 60 * 1000, // 1 minute
    gcTime: 5 * 60 * 1000, // 5 minutes
  },
};

/**
 * Determine cache strategy based on data age
 */
function getCacheConfig(options: NASAClientOptions) {
  const now = new Date();
  const dataAge = now.getTime() - options.startDate.getTime();
  const daysOld = dataAge / (24 * 60 * 60 * 1000);

  // Data older than 7 days is considered static
  if (daysOld > 7) {
    return NASA_CACHE_CONFIG.static;
  }
  // Data older than 1 day is recent
  if (daysOld > 1) {
    return NASA_CACHE_CONFIG.recent;
  }
  // Otherwise real-time
  return NASA_CACHE_CONFIG.realtime;
}

/**
 * Create React Query options for NASA OMNI data
 */
export function createNASAQueryOptions(options: NASAClientOptions) {
  const cacheConfig = getCacheConfig(options);

  return queryOptions({
    queryKey: [
      'nasa-omni',
      formatOMNIDate(options.startDate),
      formatOMNIDate(options.endDate),
      options.orbitType,
      options.particleType,
      options.energyRange,
      options.resolution,
    ],
    queryFn: async (): Promise<RadiationMeasurement[]> => {
      const params: OMNIQueryParams = {
        startDate: formatOMNIDate(options.startDate),
        endDate: formatOMNIDate(options.endDate),
        resolution: options.resolution || 'hourly',
      };

      const data = await fetchOMNIData(params);

      // Apply client-side filtering based on provided options
      let filtered = data;

      // Filter by orbit type if specified
      if (options.orbitType) {
        filtered = filtered.filter((m) => m.orbitType === options.orbitType);
      }

      // Filter by particle type if specified
      if (options.particleType) {
        filtered = filtered.filter((m) => m.particleType === options.particleType);
      }

      // Filter by energy range if specified
      if (options.energyRange) {
        filtered = filtered.filter((m) => {
          const { min, max } = options.energyRange!;
          return (
            (m.energyRange.min >= min && m.energyRange.min <= max) ||
            (m.energyRange.max >= min && m.energyRange.max <= max) ||
            (m.energyRange.min <= min && m.energyRange.max >= max)
          );
        });
      }

      return filtered;
    },
    staleTime: cacheConfig.staleTime,
    gcTime: cacheConfig.gcTime,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

/**
 * NASA OMNI Service Client
 */
export class NASAClient {
  /**
   * Fetch radiation data with automatic caching
   */
  static async fetchRadiationData(
    options: NASAClientOptions
  ): Promise<RadiationMeasurement[]> {
    const params: OMNIQueryParams = {
      startDate: formatOMNIDate(options.startDate),
      endDate: formatOMNIDate(options.endDate),
      resolution: options.resolution || 'hourly',
    };

    return fetchOMNIData(params);
  }

  /**
   * Get query options for React Query
   */
  static getQueryOptions(options: NASAClientOptions) {
    return createNASAQueryOptions(options);
  }
}

