import { useEffect, useMemo, useRef, useState } from "react";
import type { CanonicalSpaceWeatherPoint } from "@/lib/types/space-weather";
import { getAccessToken } from "@/lib/api/auth";
import { useFeedSession, usePolledFeed, type FeedStatus } from "@/hooks/usePolledFeed";
import { wsOrigin } from "@/lib/api/base-url";
import { lookbackSince, mergeSeries, SERIES_MAX_POINTS, SERIES_WINDOW_MS } from "@/lib/api/feed-series";

// Signed in: the 24 h, 5 s feed (`user` role). Signed out: only the public
// latest point, about once a minute (NOAA updates each minute). The auth-only
// route is never requested without a session, because CyberTiger counts 401s.
const FEED_ENDPOINT = "/api/feed/space-weather/5s";
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

// Backfill once, then ask only for points newer than the last one held.
const seriesPathFor = (backfillMs: number) => (path: string, held: CanonicalSpaceWeatherPoint[] | null) =>
  `${path}?lookback=${lookbackSince(held, Date.now(), backfillMs)}&limit=${SERIES_MAX_POINTS}`;
const latestPath = (path: string) => path;

export interface SolarWind5sOptions {
  /** false: latest point only, once a minute, even when signed in (the landing). */
  history?: boolean;
  /**
   * How far back the first request reaches (default 24 h). A page that only needs
   * the live drivers asks for minutes, keeping a multi-MB parse out of its boot.
   */
  backfillMs?: number;
}

export function useSolarWind5s({ history = true, backfillMs = SERIES_WINDOW_MS }: SolarWind5sOptions = {}): SolarWind5sState {
  const session = useFeedSession();
  const full = history && session.signedIn;
  const seriesPath = useMemo(() => seriesPathFor(backfillMs), [backfillMs]);
  const feed = usePolledFeed({
    path: session.resolved ? (full ? FEED_ENDPOINT : PUBLIC_LATEST_ENDPOINT) : null,
    intervalMs: full ? POLL_INTERVAL_MS : PUBLIC_POLL_INTERVAL_MS,
    parse: full ? parseSeries : parseLatest,
    nextPath: full ? seriesPath : latestPath,
    reduce: mergeSeries,
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
          const payload = message.payload;
          setPoints((prev) => mergeSeries(prev, [payload]));
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
