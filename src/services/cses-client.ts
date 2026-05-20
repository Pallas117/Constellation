/**
 * CSES Data Service Client
 * Typed client for fetching CSES CSV radiation data
 * Uses React Query for caching static CSV files
 * 
 * Note: This is a client-side service component
 */

import { queryOptions } from '@tanstack/react-query';
import type { RadiationMeasurement } from '@/lib/types/radiation';
import { loadRadiationCSV, parseCSESCSV } from '@/lib/api/csv-parsers';

/**
 * Cache configuration for CSES data
 * CSV files are typically static, so we use long cache times
 */
export const CSES_CACHE_CONFIG = {
  staleTime: 60 * 60 * 1000, // 1 hour (CSV files don't change often)
  gcTime: 24 * 60 * 60 * 1000, // 24 hours
};

/**
 * Create React Query options for CSES data
 */
export function createCSESQueryOptions(source: string | File) {
  return queryOptions({
    queryKey: [
      'cses',
      typeof source === 'string' ? source : source.name,
      source instanceof File ? source.lastModified : undefined,
    ],
    queryFn: async (): Promise<RadiationMeasurement[]> => {
      return loadRadiationCSV(source, 'cses');
    },
    staleTime: CSES_CACHE_CONFIG.staleTime,
    gcTime: CSES_CACHE_CONFIG.gcTime,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false, // CSV files don't change
  });
}

/**
 * CSES Service Client
 */
export class CSESClient {
  /**
   * Load CSES CSV data
   */
  static async loadCSV(source: string | File): Promise<RadiationMeasurement[]> {
    return loadRadiationCSV(source, 'cses');
  }

  /**
   * Parse CSES CSV content directly
   */
  static parseCSV(csvContent: string): RadiationMeasurement[] {
    return parseCSESCSV(csvContent);
  }

  /**
   * Get query options for React Query
   */
  static getQueryOptions(source: string | File) {
    return createCSESQueryOptions(source);
  }
}

