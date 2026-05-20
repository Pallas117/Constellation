import { useEffect, useMemo, useState } from "react";
import type { MMSReconVectorPoint } from "@/lib/types/space-weather";
import { getAuthHeaders } from "@/lib/api/auth";

const POLL_INTERVAL_MS = 5000;

function getBaseUrl(): string {
  return import.meta.env.VITE_HELIO_PROXY_URL ?? "http://localhost:3001";
}

export interface MMSReconnectionState {
  vectors: MMSReconVectorPoint[];
  latest: MMSReconVectorPoint | null;
  loading: boolean;
  error: string | null;
}

export function useMMSReconnection(): MMSReconnectionState {
  const [vectors, setVectors] = useState<MMSReconVectorPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const fetchVectors = async () => {
      try {
        const response = await fetch(
          `${getBaseUrl()}/api/feed/mms/reconnection?lookback=PT2H&limit=1440`,
          {
            headers: await getAuthHeaders(),
          },
        );
        if (!response.ok) {
          throw new Error(`MMS feed HTTP ${response.status}`);
        }
        const json = (await response.json()) as { vectors?: MMSReconVectorPoint[] };
        if (!mounted) {
          return;
        }
        setVectors(Array.isArray(json.vectors) ? json.vectors : []);
        setError(null);
      } catch (err) {
        if (!mounted) {
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to fetch MMS vectors");
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    fetchVectors();
    const timer = setInterval(fetchVectors, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  return {
    vectors,
    latest: useMemo(
      () => (vectors.length > 0 ? vectors[vectors.length - 1] : null),
      [vectors],
    ),
    loading,
    error,
  };
}
