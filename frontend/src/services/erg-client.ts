/**
 * ERG/Arase Data Service Client
 * Typed client for fetching ERG/Arase CSV radiation data
 * Uses React Query for caching static CSV files
 * 
 * Note: This is a client-side service component
 */

import { queryOptions } from '@tanstack/react-query';
import type { RadiationMeasurement } from '@/lib/types/radiation';
import { loadRadiationCSV, parseERGAraseCSV } from '@/lib/api/csv-parsers';

/**
 * Cache configuration for ERG/Arase data
 * CSV files are typically static, so we use long cache times
 */
export const ERG_CACHE_CONFIG = {
  staleTime: 60 * 60 * 1000, // 1 hour (CSV files don't change often)
  gcTime: 24 * 60 * 60 * 1000, // 24 hours
};

/**
 * Create React Query options for ERG/Arase data
 */
export function createERGQueryOptions(source: string | File) {
  return queryOptions({
    queryKey: [
      'erg-arase',
      typeof source === 'string' ? source : source.name,
      source instanceof File ? source.lastModified : undefined,
    ],
    queryFn: async (): Promise<RadiationMeasurement[]> => {
      return loadRadiationCSV(source, 'erg-arase');
    },
    staleTime: ERG_CACHE_CONFIG.staleTime,
    gcTime: ERG_CACHE_CONFIG.gcTime,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false, // CSV files don't change
  });
}

/**
 * ERG/Arase Service Client
 */
export class ERGClient {
  /**
   * Load ERG/Arase CSV data
   */
  static async loadCSV(source: string | File): Promise<RadiationMeasurement[]> {
    return loadRadiationCSV(source, 'erg-arase');
  }

  /**
   * Parse ERG/Arase CSV content directly
   */
  static parseCSV(csvContent: string): RadiationMeasurement[] {
    return parseERGAraseCSV(csvContent);
  }

  /**
   * Get query options for React Query
   */
  static getQueryOptions(source: string | File) {
    return createERGQueryOptions(source);
  }
}

