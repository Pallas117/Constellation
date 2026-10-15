import { useEffect, useMemo, useRef, useState } from "react";
import type { CanonicalSpaceWeatherPoint } from "@/lib/types/space-weather";
import { getAuthHeaders } from "@/lib/api/auth";
import { subscribeSpaceWeather } from "@/lib/api/space-weather-socket";

const MAX_POINTS = 17280; // 24 h at 5 s
const HISTORY_ENDPOINT = `/api/feed/space-weather/5s?lookback=PT24H&limit=${MAX_POINTS}`;
// Fallback polling only asks for the recent tail; the 24 h history is loaded once.
const TAIL_ENDPOINT = "/api/feed/space-weather/5s?lookback=PT1M&limit=12";
const POLL_INTERVAL_MS = 5000;

function getBaseUrl(): string {
  return import.meta.env.VITE_HELIO_PROXY_URL ?? "http://127.0.0.1:3001";
}

/** Merge incoming points into the feed by timestamp, keeping order and the 24 h cap. */
export function mergePoints(
  prev: CanonicalSpaceWeatherPoint[],
  incoming: CanonicalSpaceWeatherPoint[],
): CanonicalSpaceWeatherPoint[] {
  if (incoming.length === 0) return prev;
  const last = prev.length > 0 ? Date.parse(prev[prev.length - 1].timestamp) : -Infinity;
  // Common case: strictly newer points append without re-sorting the whole feed.
  if (incoming.every((p) => Date.parse(p.timestamp) > last)) {
    const next = prev.concat(incoming);
    return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
  }
  const byTime = new Map(prev.map((p) => [p.timestamp, p]));
  for (const p of incoming) byTime.set(p.timestamp, p);
  const next = Array.from(byTime.values()).sort(
    (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
  );
  return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
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
  const socketOpen = useRef(false);

  useEffect(() => {
    let mounted = true;
    let historyLoaded = false;

    const fetchFeed = async (endpoint: string) => {
      const response = await fetch(`${getBaseUrl()}${endpoint}`, {
        headers: await getAuthHeaders(),
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(`Feed HTTP ${response.status}`);
      }
      const json = (await response.json()) as { points?: CanonicalSpaceWeatherPoint[] };
      return Array.isArray(json.points) ? json.points : [];
    };

    const poll = async () => {
      // While the socket is delivering, polling would only duplicate it.
      if (historyLoaded && socketOpen.current) return;
      try {
        const incoming = await fetchFeed(historyLoaded ? TAIL_ENDPOINT : HISTORY_ENDPOINT);
        if (!mounted) return;
        setPoints((prev) => (historyLoaded ? mergePoints(prev, incoming) : mergePoints([], incoming)));
        historyLoaded = true;
        setError(null);
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : "Failed to fetch feed");
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(
    () =>
      subscribeSpaceWeather({
        onPoint: (point) => setPoints((prev) => mergePoints(prev, [point])),
        onStatus: (open) => {
          socketOpen.current = open;
          setSource(open ? "websocket" : "polling");
        },
      }),
    [],
  );

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
