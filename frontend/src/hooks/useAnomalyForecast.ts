import { useState, useEffect } from 'react';
import { apiBase } from "@/lib/api/base-url";

const PROXY_URL = apiBase();

export interface AnomalyForecast {
  modelVersion: string;
  generatedAt: string;
  horizonHours: number;
  anomalyProbability: number;
  predictedKpMax: number;
  warningMessage: string;
  confidenceInterval: [number, number];
}

export function useAnomalyForecast(pollIntervalMs = 300_000) {
  const [forecast, setForecast] = useState<AnomalyForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetch_() {
    try {
      const res = await fetch(`${PROXY_URL}/api/forecast/anomaly`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setForecast(await res.json() as AnomalyForecast);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetch_();
    const id = setInterval(fetch_, pollIntervalMs);
    return () => clearInterval(id);
  }, [pollIntervalMs]);

  return { forecast, loading, error };
}
