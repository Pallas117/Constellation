import { useFeedSession, usePolledFeed } from '@/hooks/usePolledFeed';
import { ANOMALY_FORECAST_PATH, parseAnomalyForecast, type AnomalyForecast } from '@/lib/api/anomaly-forecast';

export type { AnomalyForecast };

// `user` route: never requested without a session, because CyberTiger counts 401s.
export function useAnomalyForecast(pollIntervalMs = 300_000) {
  const session = useFeedSession();
  const feed = usePolledFeed({
    path: session.resolved && session.signedIn ? ANOMALY_FORECAST_PATH : null,
    intervalMs: pollIntervalMs,
    maxBackoffMs: 4 * pollIntervalMs,
    parse: parseAnomalyForecast,
    disabledStatus: session.resolved ? 'sign-in-required' : 'waiting',
    restartKey: session.userKey,
  });

  return { forecast: feed.data, loading: feed.loading, error: feed.error };
}
