import { useEffect, useState } from "react";
import type { AuroraMapResponse } from "@/lib/types/space-weather";
import { getAuthHeaders } from "@/lib/api/auth";

const POLL_INTERVAL_MS = 5000;

function getBaseUrl(): string {
  return import.meta.env.VITE_HELIO_PROXY_URL ?? "http://localhost:3001";
}

export interface AuroraMapState {
  map: AuroraMapResponse | null;
  loading: boolean;
  error: string | null;
}

export function useAuroraMap(): AuroraMapState {
  const [map, setMap] = useState<AuroraMapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    const fetchMap = async () => {
      try {
        const response = await fetch(`${getBaseUrl()}/api/feed/aurora/map?projection=gsm`, {
          headers: await getAuthHeaders(),
        });
        if (!response.ok) {
          throw new Error(`Aurora map HTTP ${response.status}`);
        }
        const json = (await response.json()) as AuroraMapResponse;
        if (!mounted) {
          return;
        }
        setMap(json);
        setError(null);
      } catch (err) {
        if (!mounted) {
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to fetch aurora map");
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    fetchMap();
    const timer = setInterval(fetchMap, POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  return { map, loading, error };
}
