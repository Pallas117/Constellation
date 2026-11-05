import { useState, useEffect } from 'react';
import { getAuthHeaders } from '@/lib/api/auth';
import { apiBase } from "@/lib/api/base-url";

const PROXY_URL = apiBase();

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

export function useAnomalyForecast(pollIntervalMs = 300_000) {
  const [forecast, setForecast] = useState<AnomalyForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetch_ = async () => {
      try {
        // /api requires a session; without it this always read 401 (GAU-115).
        const res = await fetch(`${PROXY_URL}/api/forecast/anomaly`, { headers: await getAuthHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = await res.json() as AnomalyForecast;
        if (cancelled) return;
        setForecast(next);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void fetch_();
    const id = setInterval(fetch_, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollIntervalMs]);

  return { forecast, loading, error };
}
