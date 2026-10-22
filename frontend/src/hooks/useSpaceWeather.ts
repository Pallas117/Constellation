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
import { useNow } from './useNow';
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
  
  const failureCountRef = useRef(0);

  const show = useCallback((next: InterpolatedData) => {
    setData(next);
    setVisualParams(calculateVisualizationParams(next));
  }, []);

  // ============================================================================
  // DATA REFRESH INTERVAL
  // ============================================================================

  const { mode } = useConnectivity();

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      try {
        console.log('[SpaceWeather] Fetching data from edge function...');
      
        const proxyUrl = apiBase();
        const response = await fetch(`${proxyUrl}/api/feed/space-weather/latest`);
      
        if (!response.ok) {
          throw new Error(`Proxy HTTP ${response.status}`);
        }

        const responseData = await response.json();
        if (cancelled) return;

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
        if (cancelled) return;
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
    };

    // Initial fetch
    void fetchData();
    
    // Adaptive interval: 1m for CLOUD, 3m for SAT, No polling for AIRGAP
    let intervalTime = UPDATE_INTERVAL;
    if (mode === 'SAT') intervalTime = UPDATE_INTERVAL * 3;
    if (mode === 'AIRGAP') {
      return () => {
        cancelled = true;
      };
    }

    const interval = setInterval(fetchData, intervalTime);
    
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [show, mode]);

  // ============================================================================
  // RETURN
  // ============================================================================

  // Expiry is judged by the measurement's own timestamp, so a value that stops updating
  // goes stale even if no fetch has failed yet.
  // A value that stops updating turns stale; useNow re-renders every STALENESS_RECHECK_MS.
  const now = useNow(STALENESS_RECHECK_MS);
  const effective = applyDecay(data, now - data.timestamp.getTime());

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
