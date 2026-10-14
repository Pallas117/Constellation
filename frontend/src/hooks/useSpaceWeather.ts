import { useState, useEffect, useCallback, useRef } from 'react';
import {
  EMAInterpolator,
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
import { getAuthHeaders } from '@/lib/api/auth';
import { subscribeSpaceWeather } from '@/lib/api/space-weather-socket';

// ============================================================================
// CONFIGURATION
// ============================================================================

// Updates arrive by WebSocket push; REST polling runs only while the socket is down.
const UPDATE_INTERVAL = 15000; // fallback poll of /latest (small payload)
const INTERPOLATION_DURATION = 2000; // short enough that the display tracks the feed
const MARK_UNAVAILABLE_AFTER = 3; // Consecutive failures before showing "no data"

// No simulated fallback: without a live feed the UI shows "unavailable" (see
// unavailableData), never generated values presented as measurements.

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
  
  const interpolatorRef = useRef<EMAInterpolator>(
    new EMAInterpolator(unavailableData(), INTERPOLATION_DURATION)
  );
  const animationRef = useRef<number>();
  const failureCountRef = useRef(0);
  const lastFetchTimeRef = useRef<number>(0);
  const socketOpenRef = useRef(false);

  // ============================================================================
  // DATA INTAKE (push and fallback poll share one path)
  // ============================================================================

  const applyReading = useCallback((responseData: unknown) => {
    // The backend serves CanonicalSpaceWeatherPoint; the legacy edge-function shape is
    // still accepted.
    const legacy = validateSpaceWeatherResponse(responseData);
    const transformed = canonicalToInterpolated(responseData) ?? (legacy ? transformApiResponse(legacy) : null);

    if (!transformed) {
      throw new Error('Invalid response format');
    }

    interpolatorRef.current.setTarget(transformed);

    failureCountRef.current = 0;
    lastFetchTimeRef.current = Date.now();
    setLastUpdate(new Date());
    setError(null);
  }, []);

  useEffect(
    () =>
      subscribeSpaceWeather({
        onPoint: (point) => {
          try {
            applyReading(point);
          } catch {
            // A malformed push is ignored; the next tick or the fallback poll replaces it.
          }
        },
        onStatus: (open) => {
          socketOpenRef.current = open;
        },
      }),
    [applyReading],
  );

  const fetchData = useCallback(async () => {
    try {
      const proxyUrl = import.meta.env.VITE_HELIO_PROXY_URL || 'http://127.0.0.1:3001';
      const response = await fetch(`${proxyUrl}/api/feed/space-weather/latest`, {
        headers: await getAuthHeaders(),
        credentials: 'include',
      });

      if (!response.ok) {
        throw new Error(`Proxy HTTP ${response.status}`);
      }

      applyReading(await response.json());
    } catch (err) {
      failureCountRef.current++;
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      console.error('[SpaceWeather] Fetch error:', errorMsg);
      
      if (failureCountRef.current >= MARK_UNAVAILABLE_AFTER) {
        console.log('[SpaceWeather] Live data unavailable');
        interpolatorRef.current.setTarget(unavailableData());
        setError('Live data unavailable');
      } else {
        setError(`Fetch failed: ${errorMsg}`);
      }
    }
  }, [applyReading]);

  // ============================================================================
  // ANIMATION LOOP
  // ============================================================================

  useEffect(() => {
    const animate = () => {
      let interpolated = interpolatorRef.current.getInterpolated();
      
      // Apply decay if data is stale
      if (interpolated.isStale && lastFetchTimeRef.current > 0) {
        const timeSinceUpdate = Date.now() - lastFetchTimeRef.current;
        interpolated = applyDecay(interpolated, timeSinceUpdate);
      }
      
      setData(interpolated);
      setVisualParams(calculateVisualizationParams(interpolated));
      
      animationRef.current = requestAnimationFrame(animate);
    };

    animate();
    
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  // ============================================================================
  // DATA REFRESH INTERVAL
  // ============================================================================

  const { mode } = useConnectivity();

  useEffect(() => {
    // Initial fetch, so the display fills before the first push arrives
    fetchData();

    // Fallback poll while the socket is down: 15s for CLOUD, 45s for SAT, none for AIRGAP
    let intervalTime = UPDATE_INTERVAL;
    if (mode === 'SAT') intervalTime = UPDATE_INTERVAL * 3;
    if (mode === 'AIRGAP') return;

    const interval = setInterval(() => {
      if (!socketOpenRef.current) fetchData();
    }, intervalTime);
    
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
