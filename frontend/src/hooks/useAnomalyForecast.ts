import { usePolledFeed } from '@/hooks/usePolledFeed';

/** Mirrors backend AnomalyForecastResponse: a model forecast, or an explicit "unavailable". */
export type AnomalyForecast =
  | {
      available: true;
      modelVersion: string;
      generatedAt: string;
      horizonHours: number;
      anomalyProbability: number;
      predictedKpMax: number;
      warningMessage: string;
      confidenceInterval: [number, number];
    }
  | {
      available: false;
      modelVersion: null;
      generatedAt: string;
      horizonHours: number;
      reason: string;
    };

/** On the shared poller: stops on 401/403 (CyberTiger counts them) and backs off on failures. */
export function useAnomalyForecast(pollIntervalMs = 300_000) {
  const { data: forecast, status, error } = usePolledFeed<AnomalyForecast>({
    path: '/api/forecast/anomaly',
    intervalMs: pollIntervalMs,
    parse: (json) => json as AnomalyForecast,
  });
  return { forecast, loading: status === 'waiting', error };
}
