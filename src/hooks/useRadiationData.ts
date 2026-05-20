/**
 * Custom React hook for fetching and managing radiation data
 * Supports multiple data sources: NASA OMNI, SPENVIS, ERG/Arase, CSES
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RadiationMeasurement,
  RadiationDataFilter,
  RadiationTimeSeries,
  RealTimeRadiationSnapshot,
  OrbitType,
  ParticleType,
} from '@/lib/types/radiation';
import { fetchOMNIData, formatOMNIDate } from '@/lib/api/nasa-omni';
import { fetchSPENVISData } from '@/lib/api/spenvis';
import { loadRadiationCSV } from '@/lib/api/csv-parsers';
import {
  filterRadiationData,
  createTimeSeries,
  calculateStatistics,
  getAlertLevel,
} from '@/lib/utils/radiation';

export interface UseRadiationDataOptions {
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
  /** Enable automatic data caching */
  enableCache?: boolean;
}

export interface UseRadiationDataReturn {
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
 * Main hook for radiation data management
 */
export function useRadiationData(
  options: UseRadiationDataOptions = {}
): UseRadiationDataReturn {
  const {
    realTime = false,
    updateInterval = 60000,
    initialFilter = {},
    sources = ['nasa-omni'],
    csvSources = {},
    enableCache = true,
  } = options;

  const queryClient = useQueryClient();
  const [filter, setFilterState] = useState<RadiationDataFilter>(initialFilter);
  const [allMeasurements, setAllMeasurements] = useState<RadiationMeasurement[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Query key for React Query
  const queryKey = ['radiation-data', sources, csvSources];

  // Fetch function for React Query
  const fetchData = useCallback(async (): Promise<RadiationMeasurement[]> => {
    const measurements: RadiationMeasurement[] = [];

    // Fetch from NASA OMNI
    if (sources.includes('nasa-omni')) {
      try {
        const startDate = filter.startTime
          ? formatOMNIDate(new Date(filter.startTime))
          : formatOMNIDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)); // Default: last 7 days
        const endDate = filter.endTime
          ? formatOMNIDate(new Date(filter.endTime))
          : formatOMNIDate(new Date());

        const omniData = await fetchOMNIData({
          startDate,
          endDate,
          resolution: 'hourly',
        });

        measurements.push(...omniData);
      } catch (error) {
        console.error('Error fetching OMNI data:', error);
      }
    }

    // Fetch from SPENVIS
    if (sources.includes('spenvis')) {
      try {
        const orbitType = filter.orbitTypes?.[0] || 'LEO';
        const spenvisData = await fetchSPENVISData({
          startTime: filter.startTime || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          endTime: filter.endTime || new Date().toISOString(),
          orbitType,
        });

        measurements.push(...spenvisData);
      } catch (error) {
        console.error('Error fetching SPENVIS data:', error);
      }
    }

    // Load ERG/Arase CSV
    if (sources.includes('erg-arase') && csvSources['erg-arase']) {
      try {
        const ergData = await loadRadiationCSV(csvSources['erg-arase'], 'erg-arase');
        measurements.push(...ergData);
      } catch (error) {
        console.error('Error loading ERG/Arase CSV:', error);
      }
    }

    // Load CSES CSV
    if (sources.includes('cses') && csvSources['cses']) {
      try {
        const csesData = await loadRadiationCSV(csvSources['cses'], 'cses');
        measurements.push(...csesData);
      } catch (error) {
        console.error('Error loading CSES CSV:', error);
      }
    }

    return measurements;
  }, [sources, csvSources, filter.startTime, filter.endTime, filter.orbitTypes]);

  // React Query for data fetching
  const {
    data: queryData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: fetchData,
    enabled: true,
    staleTime: enableCache ? updateInterval : 0,
    gcTime: enableCache ? 5 * 60 * 1000 : 0, // 5 minutes cache
    refetchInterval: realTime ? updateInterval : false,
  });

  // Update measurements when query data changes
  useEffect(() => {
    if (queryData) {
      setAllMeasurements(queryData);
      setLastUpdate(new Date());
    }
  }, [queryData]);

  // Filter measurements based on current filter
  const filteredMeasurements = useMemo(() => {
    return filterRadiationData(allMeasurements, filter);
  }, [allMeasurements, filter]);

  // Create time series for each orbit/particle combination
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
        } catch (error) {
          // Skip if no data for this combination
          console.debug(`No data for ${orbitType} ${particleType}`);
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
      .slice(-100); // Last 100 measurements

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

  return {
    measurements: allMeasurements,
    filteredMeasurements,
    filter,
    setFilter,
    timeSeries,
    realTimeSnapshot,
    statistics,
    isLoading,
    error: error as Error | null,
    refetch: () => {
      queryClient.invalidateQueries({ queryKey });
      refetch();
    },
    lastUpdate,
  };
}

/**
 * Hook for fetching radiation data with a specific filter (one-time fetch)
 */
export function useRadiationDataQuery(filter: RadiationDataFilter) {
  return useRadiationData({
    realTime: false,
    initialFilter: filter,
  });
}

