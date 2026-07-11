/**
 * Optimized radiation data hook using service clients
 * Implements comprehensive caching strategy with React Query
 * 
 * Note: Client-side hook
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useQuery, useQueryClient, useQueries } from '@tanstack/react-query';
import type {
  RadiationMeasurement,
  RadiationDataFilter,
  RadiationTimeSeries,
  RealTimeRadiationSnapshot,
  OrbitType,
  ParticleType,
} from '@/lib/types/radiation';
import { NASAClient, ERGClient, CSESClient } from '@/services';
import {
  filterRadiationData,
  createTimeSeries,
  calculateStatistics,
  getAlertLevel,
} from '@/lib/utils/radiation';

export interface UseRadiationDataOptimizedOptions {
  /** Enable real-time updates */
  realTime?: boolean;
  /** Update interval in milliseconds (default: 60000 = 1 minute) */
  updateInterval?: number;
  /** Initial filter parameters */
  initialFilter?: RadiationDataFilter;
  /** Data sources to fetch from */
  sources?: Array<'nasa-omni' | 'spenvis' | 'erg-arase' | 'cses'>;
  /** CSV file URLs or File objects for ERG/Arase and CSES */
  csvSources?: {
    'erg-arase'?: string | File;
    'cses'?: string | File;
  };
}

export interface UseRadiationDataOptimizedReturn {
  /** All radiation measurements */
  measurements: RadiationMeasurement[];
  /** Filtered measurements based on current filter */
  filteredMeasurements: RadiationMeasurement[];
  /** Current filter parameters */
  filter: RadiationDataFilter;
  /** Update filter function */
  setFilter: (filter: Partial<RadiationDataFilter>) => void;
  /** Time series data for visualization */
  timeSeries: RadiationTimeSeries[];
  /** Real-time snapshot */
  realTimeSnapshot: RealTimeRadiationSnapshot | null;
  /** Statistics for current data */
  statistics: ReturnType<typeof calculateStatistics>;
  /** Loading state */
  isLoading: boolean;
  /** Error state */
  error: Error | null;
  /** Refetch data manually */
  refetch: () => void;
  /** Last update timestamp */
  lastUpdate: Date | null;
}

/**
 * Optimized hook using service clients with proper caching
 */
export function useRadiationDataOptimized(
  options: UseRadiationDataOptimizedOptions = {}
): UseRadiationDataOptimizedReturn {
  const {
    realTime = false,
    updateInterval = 60000,
    initialFilter = {},
    sources = ['nasa-omni'],
    csvSources = {},
  } = options;

  const queryClient = useQueryClient();
  const [filter, setFilterState] = useState<RadiationDataFilter>(initialFilter);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Calculate date range
  const startDate = useMemo(
    () =>
      filter.startTime
        ? new Date(filter.startTime)
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    [filter.startTime]
  );
  const endDate = useMemo(
    () => (filter.endTime ? new Date(filter.endTime) : new Date()),
    [filter.endTime]
  );

  // Create queries for each source using service clients
  const queries = useQueries({
    queries: [
      // NASA OMNI query
      ...(sources.includes('nasa-omni')
        ? [
            {
              ...NASAClient.getQueryOptions({
                startDate,
                endDate,
                orbitType: filter.orbitTypes?.[0],
                particleType: filter.particleTypes?.[0],
                energyRange: filter.energyRange,
                resolution: 'hourly',
              }),
              refetchInterval: realTime ? updateInterval : false,
            },
          ]
        : []),
      // ERG/Arase query
      ...(sources.includes('erg-arase') && csvSources['erg-arase']
        ? [
            {
              ...ERGClient.getQueryOptions(csvSources['erg-arase']),
              refetchInterval: false, // CSV files don't change
            },
          ]
        : []),
      // CSES query
      ...(sources.includes('cses') && csvSources['cses']
        ? [
            {
              ...CSESClient.getQueryOptions(csvSources['cses']),
              refetchInterval: false, // CSV files don't change
            },
          ]
        : []),
    ],
  });

  // Combine all query results
  const allMeasurements = useMemo(() => {
    const combined: RadiationMeasurement[] = [];
    queries.forEach((query) => {
      if (query.data) {
        combined.push(...query.data);
      }
    });
    return combined;
  }, [queries]);

  // Update last update time (side effect should be in useEffect, not useMemo)
  useEffect(() => {
    const hasData = queries.some((q) => q.data);
    if (hasData) {
      setLastUpdate(new Date());
    }
  }, [queries]);

  // Filter measurements based on current filter
  const filteredMeasurements = useMemo(() => {
    return filterRadiationData(allMeasurements, filter);
  }, [allMeasurements, filter]);

  // Create time series
  const timeSeries = useMemo(() => {
    if (filteredMeasurements.length === 0) return [];

    const orbitTypes = filter.orbitTypes || (['LEO', 'MEO', 'GEO'] as OrbitType[]);
    const particleTypes = filter.particleTypes || (['proton', 'electron'] as ParticleType[]);

    const series: RadiationTimeSeries[] = [];

    orbitTypes.forEach((orbitType) => {
      particleTypes.forEach((particleType) => {
        try {
          const seriesData = createTimeSeries(filteredMeasurements, orbitType, particleType);
          series.push(seriesData);
        } catch {
          // Skip if no data for this combination
        }
      });
    });

    return series;
  }, [filteredMeasurements, filter.orbitTypes, filter.particleTypes]);

  // Calculate statistics
  const statistics = useMemo(() => {
    return calculateStatistics(filteredMeasurements);
  }, [filteredMeasurements]);

  // Create real-time snapshot
  const realTimeSnapshot = useMemo<RealTimeRadiationSnapshot | null>(() => {
    if (!realTime || filteredMeasurements.length === 0) return null;

    const recentMeasurements = filteredMeasurements
      .filter((m) => {
        const measurementTime = new Date(m.timestamp).getTime();
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        return measurementTime >= fiveMinutesAgo;
      })
      .slice(-100);

    if (recentMeasurements.length === 0) return null;

    const fluxes = recentMeasurements.map((m) => m.particleFlux);
    const averageFlux = fluxes.reduce((a, b) => a + b, 0) / fluxes.length;
    const maxFlux = Math.max(...fluxes);
    const minFlux = Math.min(...fluxes);

    const activeOrbits = Array.from(
      new Set(recentMeasurements.map((m) => m.orbitType))
    ) as OrbitType[];

    const dominantParticleType = recentMeasurements[0]?.particleType || 'electron';
    const alertLevel = getAlertLevel(averageFlux, dominantParticleType);

    return {
      timestamp: new Date().toISOString(),
      measurements: recentMeasurements,
      summary: {
        averageFlux,
        maxFlux,
        minFlux,
        activeOrbits,
        alertLevel,
      },
    };
  }, [realTime, filteredMeasurements]);

  // Update filter function
  const setFilter = useCallback((newFilter: Partial<RadiationDataFilter>) => {
    setFilterState((prev) => ({ ...prev, ...newFilter }));
  }, []);

  // Refetch function
  const refetch = useCallback(() => {
    queries.forEach((query) => {
      query.refetch();
    });
  }, [queries]);

  // Aggregate loading and error states
  const isLoading = queries.some((q) => q.isLoading);
  const error = queries.find((q) => q.error)?.error as Error | null;

  return {
    measurements: allMeasurements,
    filteredMeasurements,
    filter,
    setFilter,
    timeSeries,
    realTimeSnapshot,
    statistics,
    isLoading,
    error,
    refetch,
    lastUpdate,
  };
}

