import { useState, useEffect, useCallback, useRef } from 'react';
import {
  InterpolatedData,
  VisualizationParams,
  calculateVisualizationParams,
  transformApiResponse,
  validateSpaceWeatherResponse,
  applyDecay,
  canonicalToInterpolated,
  unavailableData,
  DATA_EXPIRY_MS,
} from '@/lib/dataProcessing';
import { useConnectivity } from './useConnectivity';
import { apiBase } from "@/lib/api/base-url";

// ============================================================================
// CONFIGURATION
// ============================================================================

const UPDATE_INTERVAL = 60000; // 1 minute
const MARK_UNAVAILABLE_AFTER = 3; // Consecutive failures before showing "no data"
const STALENESS_RECHECK_MS = 30000; // re-render so a value that stops updating turns stale

// No simulated fallback: without a live feed the UI shows "unavailable" (see
// unavailableData), never generated values presented as measurements.
// No tweening either: readings are shown exactly as measured the moment they
// arrive. (Easing them in over 10 s displayed values that were never measured
// under a LIVE badge.)

// ============================================================================
// CUSTOM HOOK
// ============================================================================

export interface UseSpaceWeatherReturn {
  data: InterpolatedData;
  visualParams: VisualizationParams;
  isStale: boolean;
  source: string;
  lastUpdate: Date | null;
  error: string | null;
}

export const useSpaceWeather = (): UseSpaceWeatherReturn => {
  const [data, setData] = useState<InterpolatedData>(unavailableData());
  const [visualParams, setVisualParams] = useState<VisualizationParams>(() => 
    calculateVisualizationParams(unavailableData())
  );
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const [, setTick] = useState(0);
  const failureCountRef = useRef(0);

  const show = useCallback((next: InterpolatedData) => {
    setData(next);
    setVisualParams(calculateVisualizationParams(next));
  }, []);

  // ============================================================================
  // DATA FETCHING
  // ============================================================================

  const fetchData = useCallback(async () => {
    try {
      console.log('[SpaceWeather] Fetching data from edge function...');
      
      const proxyUrl = apiBase();
      const response = await fetch(`${proxyUrl}/api/feed/space-weather/latest`);
      
      if (!response.ok) {
        throw new Error(`Proxy HTTP ${response.status}`);
      }

      const responseData = await response.json();

      // The backend serves CanonicalSpaceWeatherPoint; the legacy edge-function shape is
      // still accepted.
      const legacy = validateSpaceWeatherResponse(responseData);
      const transformed = canonicalToInterpolated(responseData) ?? (legacy ? transformApiResponse(legacy) : null);

      if (!transformed) {
        throw new Error('Invalid response format');
      }

      show(transformed);

      failureCountRef.current = 0;
      setLastUpdate(new Date());
      setError(null);
      
      console.log('[SpaceWeather] Data updated:', {
        source: transformed.source,
        stale: transformed.isStale,
        solarWind: transformed.solarWind.speed.toFixed(0) + ' km/s',
        bz: transformed.imfBz.toFixed(1) + ' nT',
        kp: transformed.kpIndex,
      });

    } catch (err) {
      failureCountRef.current++;
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[SpaceWeather] Fetch error:', errorMsg);
      
      if (failureCountRef.current >= MARK_UNAVAILABLE_AFTER) {
        console.log('[SpaceWeather] Live data unavailable');
        show(unavailableData());
        setError('Live data unavailable');
      } else {
        setError(`Fetch failed: ${errorMsg}`);
      }
    }
  }, [show]);

  // ============================================================================
  // STALENESS RECHECK
  // ============================================================================

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), STALENESS_RECHECK_MS);
    return () => clearInterval(id);
  }, []);

  // ============================================================================
  // DATA REFRESH INTERVAL
  // ============================================================================

  const { mode } = useConnectivity();

  useEffect(() => {
    // Initial fetch
    fetchData();
    
    // Adaptive interval: 1m for CLOUD, 3m for SAT, No polling for AIRGAP
    let intervalTime = UPDATE_INTERVAL;
    if (mode === 'SAT') intervalTime = UPDATE_INTERVAL * 3;
    if (mode === 'AIRGAP') return; 

    const interval = setInterval(fetchData, intervalTime);
    
    return () => clearInterval(interval);
  }, [fetchData, mode]);

  // ============================================================================
  // RETURN
  // ============================================================================

  // Expiry is judged by the measurement's own timestamp, so a value that stops updating
  // goes stale even if no fetch has failed yet.
  const effective = applyDecay(data, Date.now() - data.timestamp.getTime());

  return {
    data: effective,
    visualParams,
    isStale: effective.isStale || effective.tier === 3,
    source: effective.source,
    lastUpdate,
    error,
  };
};

// Re-export types for convenience
export type { InterpolatedData, VisualizationParams };
