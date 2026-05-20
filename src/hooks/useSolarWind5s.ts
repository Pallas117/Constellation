import { useEffect, useMemo, useRef, useState } from "react";
import type { CanonicalSpaceWeatherPoint } from "@/lib/types/space-weather";
import { getAccessToken, getAuthHeaders } from "@/lib/api/auth";

const FEED_ENDPOINT = "/api/feed/space-weather/5s?lookback=PT24H&limit=17280";
const POLL_INTERVAL_MS = 5000;

function getBaseUrl(): string {
  return import.meta.env.VITE_HELIO_PROXY_URL ?? "http://localhost:3001";
}

export interface SolarWind5sState {
  points: CanonicalSpaceWeatherPoint[];
  latest: CanonicalSpaceWeatherPoint | null;
  loading: boolean;
  error: string | null;
  source: "polling" | "websocket";
}

export function useSolarWind5s(): SolarWind5sState {
  const [points, setPoints] = useState<CanonicalSpaceWeatherPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<"polling" | "websocket">("polling");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let mounted = true;

    const fetchFeed = async () => {
      try {
        const response = await fetch(`${getBaseUrl()}${FEED_ENDPOINT}`, {
          headers: await getAuthHeaders(),
        });
        if (!response.ok) {
          throw new Error(`Feed HTTP ${response.status}`);
        }
        const json = (await response.json()) as {
          points?: CanonicalSpaceWeatherPoint[];
        };
        if (!mounted) {
          return;
        }
        setPoints(Array.isArray(json.points) ? json.points : []);
        setError(null);
      } catch (err) {
        if (!mounted) {
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to fetch feed");
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    fetchFeed();
    const timer = setInterval(fetchFeed, POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const wsEnabled = String(import.meta.env.VITE_HELIO_WS_ENABLED ?? "false") === "true";
    if (!wsEnabled) {
      return;
    }

    let ws: WebSocket | null = null;
    let cancelled = false;

    const connect = async () => {
      const base = getBaseUrl().replace(/^http/i, "ws");
      const token = await getAccessToken();
      if (!token || cancelled) {
        setSource("polling");
        return;
      }
      const wsUrl = `${base}/ws/feed/space-weather?token=${encodeURIComponent(token)}`;
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setSource("websocket");
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as {
            topic?: string;
            payload?: CanonicalSpaceWeatherPoint;
          };
          if (message.topic !== "space-weather" || !message.payload) {
            return;
          }
          setPoints((prev) => {
            const next = [...prev, message.payload];
            const dedup = new Map(next.map((point) => [point.timestamp, point]));
            return Array.from(dedup.values()).sort(
              (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
            );
          });
        } catch {
          // Ignore malformed websocket payloads.
        }
      };

      ws.onerror = () => {
        setSource("polling");
      };

      ws.onclose = () => {
        setSource("polling");
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (ws) {
        ws.close();
      }
      wsRef.current = null;
    };
  }, []);

  const latest = useMemo(
    () => (points.length > 0 ? points[points.length - 1] : null),
    [points],
  );

  return {
    points,
    latest,
    loading,
    error,
    source,
  };
}
