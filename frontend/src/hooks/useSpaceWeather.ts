import { useMemo } from 'react';
import {
  InterpolatedData,
  VisualizationParams,
  calculateVisualizationParams,
  applyDecay,
  unavailableData,
} from '@/lib/dataProcessing';
import { useConnectivity } from './useConnectivity';
import { useNow } from './useNow';
import { usePolledFeed } from './usePolledFeed';
import {
  SPACE_WEATHER_CLOUD_INTERVAL_MS,
  SPACE_WEATHER_LATEST_PATH,
  liveDataLost,
  parseSpaceWeatherReading,
  spaceWeatherPolling,
} from '@/lib/api/space-weather-feed';

// ============================================================================
// CONFIGURATION
// ============================================================================

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
  // Public route, so no session needed. The interval follows the link (1 min in the
  // cloud, 3 min over satellite, none when air-gapped). Backoff, the stop on 401/403
  // and the pause while the tab is hidden come from usePolledFeed.
  const { mode } = useConnectivity();
  const polling = spaceWeatherPolling(mode);
  const feed = usePolledFeed({
    path: polling ? SPACE_WEATHER_LATEST_PATH : null,
    intervalMs: polling?.intervalMs ?? SPACE_WEATHER_CLOUD_INTERVAL_MS,
    maxBackoffMs: polling?.maxBackoffMs,
    parse: parseSpaceWeatherReading,
  });

  const lost = liveDataLost(feed.failures);
  const reading = feed.data;
  const data = useMemo(() => (lost || !reading ? unavailableData() : reading.data), [lost, reading]);
  const visualParams = useMemo(() => calculateVisualizationParams(data), [data]);

  // Expiry is judged by the measurement's own timestamp, so a value that stops updating
  // goes stale even if no fetch has failed yet. useNow re-renders every STALENESS_RECHECK_MS.
  const now = useNow(STALENESS_RECHECK_MS);
  const effective = applyDecay(data, now - data.timestamp.getTime());

  return {
    data: effective,
    visualParams,
    isStale: effective.isStale || effective.tier === 3,
    source: effective.source,
    lastUpdate: reading?.receivedAt ?? null,
    error: lost ? 'Live data unavailable' : feed.error,
  };
};

// Re-export types for convenience
export type { InterpolatedData, VisualizationParams };
