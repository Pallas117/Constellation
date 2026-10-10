import { useEffect, useMemo, useRef, useState } from "react";
import type { CanonicalSpaceWeatherPoint } from "@/lib/types/space-weather";
import { getAccessToken } from "@/lib/api/auth";
import { useFeedSession, usePolledFeed, type FeedStatus } from "@/hooks/usePolledFeed";
import { wsOrigin } from "@/lib/api/base-url";

// Signed in: the 24 h, 5 s feed (`user` role). Signed out: only the public
// latest point, about once a minute (NOAA updates each minute). The auth-only
// route is never requested without a session, because CyberTiger counts 401s.
const FEED_ENDPOINT = "/api/feed/space-weather/5s?lookback=PT24H&limit=17280";
const PUBLIC_LATEST_ENDPOINT = "/api/feed/space-weather/latest";
const POLL_INTERVAL_MS = 5000;
const PUBLIC_POLL_INTERVAL_MS = 60_000;

export interface SolarWind5sState {
  points: CanonicalSpaceWeatherPoint[];
  latest: CanonicalSpaceWeatherPoint | null;
  loading: boolean;
  error: string | null;
  source: "polling" | "websocket";
  /** Signed-out visitors get the public latest point only. */
  scope: "full" | "public-latest";
  status: FeedStatus;
}

const parseSeries = (json: unknown): CanonicalSpaceWeatherPoint[] => {
  const points = (json as { points?: CanonicalSpaceWeatherPoint[] } | null)?.points;
  return Array.isArray(points) ? points : [];
};

const parseLatest = (json: unknown): CanonicalSpaceWeatherPoint[] =>
  json && typeof json === "object" && "timestamp" in json ? [json as CanonicalSpaceWeatherPoint] : [];

export function useSolarWind5s(): SolarWind5sState {
  const session = useFeedSession();
  const full = session.signedIn;
  const feed = usePolledFeed({
    path: session.resolved ? (full ? FEED_ENDPOINT : PUBLIC_LATEST_ENDPOINT) : null,
    intervalMs: full ? POLL_INTERVAL_MS : PUBLIC_POLL_INTERVAL_MS,
    parse: full ? parseSeries : parseLatest,
    restartKey: session.userKey,
  });

  const [points, setPoints] = useState<CanonicalSpaceWeatherPoint[]>([]);
  const [source, setSource] = useState<"polling" | "websocket">("polling");
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (feed.data) setPoints(feed.data);
  }, [feed.data]);

  useEffect(() => {
    const wsEnabled = String(import.meta.env.VITE_HELIO_WS_ENABLED ?? "false") === "true";
    if (!wsEnabled) {
      return;
    }

    let ws: WebSocket | null = null;
    let cancelled = false;

    const connect = async () => {
      const base = wsOrigin();
      const token = await getAccessToken();
      if (!token || cancelled) {
        setSource("polling");
        return;
      }
      const wsUrl = `${base}/ws/feed/space-weather`; // session cookie authenticates; never put tokens in URLs
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
    loading: feed.loading,
    error: feed.error,
    source,
    scope: full ? "full" : "public-latest",
    status: feed.status,
  };
}
